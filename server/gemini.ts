import { GoogleGenAI, Type } from "@google/genai";
import { PART_SECONDS, SPEAKER_PART_SECONDS, cleanup, prepareParts } from "./audio";
import { getKey, maskKey } from "./env";
import { DRAFTS_NOTE, FLOW_PROMPT, NOTES_PROMPT, PART_PROMPT, TRANSLATE_PROMPT } from "./prompts";
import { chunkText, extractWords, turnsFromWords } from "./text";
import type { FlowNode, Item, Notes, Process, ProcStep } from "./store";

const API = "https://generativelanguage.googleapis.com/v1beta";
const KINDS = ["root", "topic", "point", "decision", "action"];

// An error whose message is already written for the user.
export class UserError extends Error {}

const client = () => new GoogleGenAI({ apiKey: getKey(), httpOptions: { apiVersion: "v1beta" } });

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStatus = (e: unknown) => (e as { status?: number } | null)?.status;

// Google's free tier has three different 429s: a daily request cap, a per-minute token cap, and "busy" (503).
// Waiting helps with the last two only; a daily cap resets hours later, so retrying would just hang.
export const isDailyLimit = (e: unknown) => /per day|daily/i.test(errText(e));
export const isRateLimit = (e: unknown) =>
  !isDailyLimit(e) && (errStatus(e) === 429 || /rate limit|RESOURCE_EXHAUSTED/i.test(errText(e)));
export const isBusy = (e: unknown) => errStatus(e) === 503 || /overloaded|UNAVAILABLE/i.test(errText(e));

// "Please retry in 14h21m22s" -> "about 14 h 21 min"
function resetIn(raw: string): string {
  const m = /retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?/i.exec(raw);
  if (!m || (!m[1] && !m[2])) return "later";
  return "in about " + [m[1] ? `${m[1]} h` : "", m[2] ? `${m[2]} min` : ""].filter(Boolean).join(" ");
}

export function friendlyError(e: unknown): string {
  const raw = errText(e);
  const status = errStatus(e);
  let msg = raw;
  if (e instanceof UserError) msg = raw;
  else if (isDailyLimit(e))
    msg = `Today's free limit for this Gemini model is used up. It resets ${resetIn(raw)}. A paid Google plan removes the limit.`;
  else if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(raw))
    msg = "Google did not accept the API key, or the key cannot use this model. Check the key and try again.";
  else if (status === 400 && /invalid argument/i.test(raw))
    msg = "Google could not read this audio. Try exporting it as MP3 or WAV, then upload it again.";
  else if (status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(raw))
    msg = "The Gemini quota or rate limit was reached. Wait a little, or check your Google plan, then try again.";
  else if (status === 503 || /overloaded|UNAVAILABLE/i.test(raw))
    msg = "Gemini is busy right now. Try again in a minute.";
  const key = getKey();
  if (key) msg = msg.split(key).join(maskKey(key));
  return msg.slice(0, 300);
}

// --- models ---

type ModelInfo = { name: string; supportedGenerationMethods?: string[] };

async function listModels(key: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let token: string | undefined;
  do {
    const url = new URL(`${API}/models`);
    url.searchParams.set("pageSize", "200");
    if (token) url.searchParams.set("pageToken", token);
    const res = await fetch(url, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Google returned ${res.status} when listing models.`);
    const body = (await res.json()) as { models?: ModelInfo[]; nextPageToken?: string };
    out.push(...(body.models ?? []));
    token = body.nextPageToken;
  } while (token);
  return out;
}

// "valid" = 200, "invalid" = Google refused the key; anything else (network, 5xx) throws.
export async function checkKey(key: string): Promise<"valid" | "invalid"> {
  const res = await fetch(`${API}/models?pageSize=1`, {
    headers: { "x-goog-api-key": key },
    signal: AbortSignal.timeout(15000),
  });
  if (res.ok) return "valid";
  if (res.status === 400 || res.status === 401 || res.status === 403) return "invalid";
  throw new Error(`Google could not check the key right now (status ${res.status}).`);
}

const version = (name: string) => parseFloat(/gemini-(\d+(?:\.\d+)?)/i.exec(name)?.[1] ?? "0");

// Newest version first; on a tie, a non-preview model wins.
function newestFirst(a: string, b: string): number {
  return version(b) - version(a) || Number(/preview/i.test(a)) - Number(/preview/i.test(b));
}

// Returns the bare model id (no "models/" prefix) or null.
export function pickNotesModel(models: ModelInfo[]): string | null {
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""));
  const best = usable.filter((n) => /flash/i.test(n) && !/lite|live|tts|image|audio|transcribe|embed|thinking|exp/i.test(n));
  const fallback = usable.filter((n) => /pro|flash/i.test(n) && !/live|tts|image|audio|transcribe|embed/i.test(n));
  // In the fallback pool a lite model is the last resort.
  const lite = (n: string) => Number(/lite/i.test(n));
  return [...(best.length ? best : fallback)].sort((a, b) => lite(a) - lite(b) || newestFirst(a, b))[0] ?? null;
}

let cachedModel: string | null = null;

export async function discoverNotesModel(): Promise<string | null> {
  const key = getKey();
  if (!key) return null;
  try {
    cachedModel = pickNotesModel(await listModels(key));
  } catch {
    cachedModel = null; // status shows null; the next call tries again
  }
  return cachedModel;
}

export async function getNotesModel(): Promise<string | null> {
  return process.env.NOTES_MODEL?.trim() || cachedModel || (await discoverNotesModel());
}

// --- notes ---

const str = (v: unknown): v is string => typeof v === "string";
const text = (v: unknown) => (str(v) ? v.trim() : "");
// `at` is seconds into the recording: kept only as a non-negative whole number.
const atOf = (v: unknown): { at?: number } => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? { at: Math.round(v) } : {});

// v1 notes have plain strings, v2 has { text, at }.
function itemOf(v: any): Item | null {
  const t = str(v) ? v.trim() : text(v?.text);
  return t ? { text: t, ...(str(v) ? {} : atOf(v?.at)) } : null;
}
const itemList = (v: unknown): Item[] => (Array.isArray(v) ? v.map(itemOf).filter((i): i is Item => !!i) : []);

function checkFlow(v: any, depth: number): FlowNode {
  if (!v || typeof v !== "object" || !str(v.label) || !v.label.trim()) throw new Error("flow node has no label");
  const node: FlowNode = {
    label: v.label.trim(),
    kind: KINDS.includes(v.kind) ? v.kind : depth === 1 ? "root" : "point",
    ...atOf(v.at),
  };
  if (depth < 4 && Array.isArray(v.children) && v.children.length)
    node.children = v.children.map((c: unknown) => checkFlow(c, depth + 1));
  return node;
}

const STEP_KINDS = ["start", "step", "decision", "end"];
const MAX_STEPS = 30;

// Returns a cleaned process, or undefined when fewer than 3 usable steps remain. Accepts { steps } or the bare list.
export function validateProcess(v: any): Process | undefined {
  const raw = Array.isArray(v) ? v : v?.steps;
  if (!Array.isArray(raw)) return undefined;
  const valid = raw.filter((s) => s && typeof s === "object" && text(s.label)).slice(0, MAX_STEPS);
  if (valid.length < 3) return undefined;
  const used = new Set<string>();
  const byGiven = new Map<string, string>(); // the id the model wrote -> the unique id (arrows point to the first one)
  const ids = valid.map((s, i) => {
    const given = text(s.id) || `s${i + 1}`;
    let id = given;
    for (let n = 2; used.has(id); n++) id = `${given}-${n}`;
    used.add(id);
    if (!byGiven.has(given)) byGiven.set(given, id);
    return id;
  });
  return {
    steps: valid.map((s, i): ProcStep => {
      const kind = i === 0 ? "start" : STEP_KINDS.includes(s.kind) ? s.kind : "step";
      const next = kind === "end" ? [] : (Array.isArray(s.next) ? s.next : []).flatMap((n: any) => {
        const to = byGiven.get(text(n?.to));
        return to ? [{ to, ...(text(n.label) ? { label: text(n.label) } : {}) }] : [];
      });
      return { id: ids[i]!, label: text(s.label), kind, ...(text(s.who) ? { who: text(s.who) } : {}), ...atOf(s.at), next };
    }),
  };
}

// Throws if the shape is wrong; returns a cleaned Notes v2 copy otherwise. Accepts old (v1) notes too.
export function validateNotes(v: any): Notes {
  if (!v || typeof v !== "object") throw new Error("notes is not an object");
  if (!str(v.title) || !v.title.trim()) throw new Error("notes.title missing");
  if (!str(v.summary)) throw new Error("notes.summary missing");
  if (!Array.isArray(v.keyPoints)) throw new Error("notes.keyPoints must be a list");
  const actions = (Array.isArray(v.actions) ? v.actions : [])
    .filter((a: any) => a && str(a.task) && a.task.trim())
    .map((a: any) => ({
      task: a.task.trim(),
      ...(text(a.owner) ? { owner: text(a.owner) } : {}),
      ...(text(a.due) ? { due: text(a.due) } : {}),
      ...atOf(a.at),
    }));
  const decisions = (Array.isArray(v.decisions) ? v.decisions : []).flatMap((d: any) => {
    const item = itemOf(d);
    return item ? [{ ...item, ...(text(d?.who) ? { who: text(d.who) } : {}) }] : [];
  });
  const sections = (Array.isArray(v.sections) ? v.sections : []).flatMap((s: any) => {
    const bullets = itemList(s?.bullets).slice(0, 12);
    return bullets.length ? [{ heading: text(s?.heading) || "Details", bullets }] : [];
  });
  const process = validateProcess(v.process);
  return {
    title: v.title.trim(),
    summary: v.summary.trim(),
    sections: sections.slice(0, 10),
    keyPoints: itemList(v.keyPoints),
    decisions,
    actions,
    flow: checkFlow(v.flow, 1),
    ...(process ? { process } : {}),
  };
}

function parseJson(raw: string): any {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(json);
  } catch {
    throw new UserError("Gemini sent back notes that could not be read. Try again.");
  }
}

export function parseNotes(raw: string): Notes {
  const v = parseJson(raw);
  try {
    return validateNotes(v);
  } catch (e) {
    throw new UserError(`Gemini sent back notes in the wrong shape (${(e as Error).message}). Try again.`);
  }
}

// The flow-only answer: { flow, process? }.
export function parseFlow(raw: string): { flow: FlowNode; process?: Process } {
  const v = parseJson(raw);
  try {
    const process = validateProcess(v?.process);
    return { flow: checkFlow(v?.flow, 1), ...(process ? { process } : {}) };
  } catch (e) {
    throw new UserError(`Gemini sent back a flow chart in the wrong shape (${(e as Error).message}). Try again.`);
  }
}

const itemSchema = (extra: Record<string, unknown> = {}): any => ({
  type: Type.OBJECT,
  properties: { text: { type: Type.STRING }, at: { type: Type.INTEGER }, ...extra },
  required: ["text"],
});

const flowSchema = (levels: number): any => ({
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING },
    kind: { type: Type.STRING, enum: KINDS },
    at: { type: Type.INTEGER },
    ...(levels > 1 ? { children: { type: Type.ARRAY, items: flowSchema(levels - 1) } } : {}),
  },
  required: ["label", "kind"],
});

// A flat list: arrows refer to other steps by id, so no nesting is needed.
const processSchema = {
  type: Type.OBJECT,
  properties: {
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          label: { type: Type.STRING },
          kind: { type: Type.STRING, enum: STEP_KINDS },
          who: { type: Type.STRING },
          at: { type: Type.INTEGER },
          next: {
            type: Type.ARRAY,
            items: { type: Type.OBJECT, properties: { to: { type: Type.STRING }, label: { type: Type.STRING } }, required: ["to"] },
          },
        },
        required: ["id", "label", "kind", "next"],
      },
    },
  },
  required: ["steps"],
};

const notesSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    summary: { type: Type.STRING },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { heading: { type: Type.STRING }, bullets: { type: Type.ARRAY, items: itemSchema() } },
        required: ["heading", "bullets"],
      },
    },
    keyPoints: { type: Type.ARRAY, items: itemSchema() },
    decisions: { type: Type.ARRAY, items: itemSchema({ who: { type: Type.STRING } }) },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { task: { type: Type.STRING }, owner: { type: Type.STRING }, due: { type: Type.STRING }, at: { type: Type.INTEGER } },
        required: ["task"],
      },
    },
    flow: flowSchema(4),
    process: processSchema,
  },
  required: ["title", "summary", "sections", "keyPoints", "decisions", "actions", "flow"],
};

const flowOnlySchema = {
  type: Type.OBJECT,
  properties: { flow: flowSchema(4), process: processSchema },
  required: ["flow"],
};

// Translating the whole transcript inside the notes request made Gemini condense it (a 28-minute meeting came back
// as a short summary). So the English version is made first, in parts, and the notes are written from that.
async function translateChunk(model: string, text: string, insist = false, onWait?: (sec: number) => void): Promise<string> {
  const res = await withRetry(() =>
    client().models.generateContent({
      model,
      contents: text,
      config: {
        systemInstruction: insist
          ? `${TRANSLATE_PROMPT}\nIMPORTANT: your last answer was far too short. Translate every sentence this time.`
          : TRANSLATE_PROMPT,
        temperature: 0.2,
      },
    }),
    onWait,
  );
  const out = (res.text ?? "").trim();
  if (!out) throw new UserError("Gemini returned an empty translation. Try again.");
  return out;
}

export async function translateToEnglish(transcript: string, onProgress?: (note: string) => void): Promise<string> {
  const model = await getNotesModel();
  if (!model) throw new UserError("No suitable Gemini model was found for notes. Set NOTES_MODEL in .env.");
  const chunks = chunkText(transcript, 10000);
  const waiting = (sec: number) => onProgress?.(`Gemini is busy, trying again in ${sec} s`);
  onProgress?.(chunks.length > 1 ? `Translating ${chunks.length} parts` : "Translating to English");
  // the parts are independent, so a few are translated at the same time (still in order in the result)
  const out: string[] = new Array(chunks.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const chunk = chunks[i]!;
      let en = await translateChunk(model, chunk, false, waiting);
      if (chunk.length > 1500 && en.length < chunk.length * 0.3) en = await translateChunk(model, chunk, true, waiting); // came back too short
      out[i] = en;
      if (chunks.length > 1) onProgress?.(`Translating: ${++done} of ${chunks.length} parts done`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
  return out.join("\n\n");
}

// One call to the notes model. Injectable so the long-transcript path can be tested without Gemini.
export type ModelCall = (req: { system: string; contents: string; schema?: unknown }) => Promise<string>;

async function geminiCall(onProgress?: (note: string) => void): Promise<ModelCall> {
  const model = await getNotesModel();
  if (!model) throw new UserError("No suitable Gemini model was found for notes. Set NOTES_MODEL in .env.");
  return async ({ system, contents, schema }) => {
    const res = await withRetry(
      () =>
        client().models.generateContent({
          model,
          contents,
          config: { systemInstruction: system, ...(schema ? { responseMimeType: "application/json", responseSchema: schema as any } : { temperature: 0.2 }) },
        }),
      (sec) => onProgress?.(`Gemini is busy, trying again in ${sec} s`),
    );
    return res.text ?? "";
  };
}

const LONG_CHARS = 12000; // longer English transcripts are written up in parts first
const PART_CHARS = 10000;
const hasStamps = (t: string) => /^\[(?:\d+:)?\d{1,2}:\d{2}\]\s+/m.test(t);
// Gemini sometimes adds `at` even when asked not to; without stamps in the transcript any value would be made up.
const withoutTimes = <T>(v: T): T => JSON.parse(JSON.stringify(v, (k, x) => (k === "at" ? undefined : x)));

// What the final call reads: the transcript itself, or, for a long one, a draft of each part (so detail is not lost).
async function sourceFor(english: string, call: ModelCall, onProgress?: (note: string) => void): Promise<{ contents: string; long: boolean }> {
  if (english.length <= LONG_CHARS) return { contents: `Transcript:\n"""\n${english}\n"""`, long: false };
  const parts = chunkText(english, PART_CHARS);
  const drafts: string[] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      onProgress?.(`Summarising part ${i + 1} of ${parts.length}`);
      const draft = (await call({ system: PART_PROMPT, contents: `Part ${i + 1} of ${parts.length}:\n"""\n${parts[i]}\n"""` })).trim();
      if (!draft) throw new UserError("Gemini returned an empty summary of one part. Try again.");
      drafts[i] = `=== Part ${i + 1} of ${parts.length} ===\n${draft}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, parts.length) }, worker));
  return { contents: `Detailed notes on the parts of the meeting, in order:\n"""\n${drafts.join("\n\n")}\n"""`, long: true };
}

function needSpeech(english: string) {
  if (english.trim().length < 20) throw new UserError("There is not enough speech to write notes.");
}

// Notes (summary, sections, key points, decisions, actions, flow, process) from an English transcript. No translation.
export async function notesFromEnglish(english: string, onProgress?: (note: string) => void, call?: ModelCall): Promise<Notes> {
  needSpeech(english);
  const ask = call ?? (await geminiCall(onProgress));
  const { contents, long } = await sourceFor(english.trim(), ask, onProgress);
  onProgress?.("Writing the summary and flow charts");
  const notes = parseNotes(await ask({ system: NOTES_PROMPT + (long ? DRAFTS_NOTE : ""), contents, schema: notesSchema }));
  return hasStamps(english) ? notes : withoutTimes(notes);
}

// Only the topic map and the step-by-step chart, from an English transcript.
export async function flowFromEnglish(
  english: string,
  title: string,
  onProgress?: (note: string) => void,
  call?: ModelCall,
): Promise<{ flow: FlowNode; process?: Process }> {
  needSpeech(english);
  const ask = call ?? (await geminiCall(onProgress));
  const { contents, long } = await sourceFor(english.trim(), ask, onProgress);
  onProgress?.("Drawing the flow chart");
  const out = parseFlow(await ask({ system: FLOW_PROMPT + (long ? DRAFTS_NOTE : ""), contents: `Meeting title: ${title}\n\n${contents}`, schema: flowOnlySchema }));
  return hasStamps(english) ? out : withoutTimes(out);
}

// onEnglish gets the English transcript as soon as it exists, so it can be shown while the summary is still being written.
export async function generateNotes(transcript: string, onProgress?: (note: string) => void, onEnglish?: (english: string) => void) {
  needSpeech(transcript);
  const transcriptEnglish = await translateToEnglish(transcript, onProgress);
  onEnglish?.(transcriptEnglish);
  return { notes: await notesFromEnglish(transcriptEnglish, onProgress), transcriptEnglish };
}

// --- file transcription ---

// Gemini's list says m4a, not mp4.
const geminiMime = (mime: string) => (mime === "audio/mp4" ? "audio/m4a" : mime);

function outputText(r: any): string {
  if (typeof r?.output_text === "string") return r.output_text;
  return (r?.steps ?? [])
    .flatMap((s: any) => s?.content ?? [])
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .join("");
}

// "speakers" = as-spoken text with a speaker label on every turn (Google only allows labels in the as-spoken style).
export type TranscribeMode = "smart" | "verbatim" | "speakers";

async function transcribeOne(path: string, mime: string, mode: TranscribeMode): Promise<string> {
  const ai = client();
  let file = await ai.files.upload({ file: path, config: { mimeType: geminiMime(mime) } });
  try {
    for (let i = 0; file.state === "PROCESSING" && i < 150; i++) {
      await Bun.sleep(2000);
      file = await ai.files.get({ name: file.name! });
    }
    if (file.state === "FAILED") throw new UserError("Google could not process this audio file.");
    if (file.state === "PROCESSING") throw new UserError("Google took too long to process this audio file.");
    const res = await ai.interactions.create({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", uri: file.uri!, mime_type: (file.mimeType ?? geminiMime(mime)) as any }],
      generation_config: {
        transcription_config: {
          language_codes: [],
          mode: mode === "speakers" ? { type: "verbatim", diarization_mode: "speaker" } : mode,
        },
      },
    });
    // With speaker labels the speakers come on the word list; without them (or if it is missing) use the plain text.
    return (mode === "speakers" && turnsFromWords(extractWords(res))) || outputText(res).trim();
  } finally {
    ai.files.delete({ name: file.name! }).catch(() => {}); // best effort; Google also expires files itself
  }
}

// --- retries ---

// Waits and tries again for the per-minute token cap and for "busy"; gives up at once on anything else
// (including the daily cap, which a wait cannot fix).
export async function withRetry<T>(fn: () => Promise<T>, onWait?: (sec: number) => void, attempts = 6, waitSec = 65): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const wait = isRateLimit(e) ? waitSec : isBusy(e) ? Math.min(waitSec, 2 ** i) : null; // busy usually clears fast: 2, 4, 8, 16 s
      if (wait === null || i >= attempts) throw e;
      console.warn(`[gemini] ${isBusy(e) ? "busy" : "rate limit"}, trying again in ${wait} s (attempt ${i} of ${attempts})`);
      onWait?.(wait);
      await Bun.sleep(wait * 1000);
    }
  }
}

// Converts the audio to WAV and sends it in parts (see audio.ts for why). `onProgress` gets a short note such as
// "Part 2 of 3". If conversion is not possible the original file is sent as it is.
export async function transcribeFile(
  path: string,
  mime: string,
  mode: TranscribeMode,
  onProgress?: (note: string) => void,
): Promise<string> {
  const parts = await prepareParts(path, mode === "speakers" ? SPEAKER_PART_SECONDS : PART_SECONDS);
  try {
    if (!parts) return await withRetry(() => transcribeOne(path, mime, mode), () => onProgress?.("Waiting for Google's rate limit"));
    const total = parts.files.length;
    const texts: string[] = [];
    for (const [i, file] of parts.files.entries()) {
      const label = total > 1 ? `Part ${i + 1} of ${total}` : "Transcribing";
      onProgress?.(label);
      texts.push(await withRetry(() => transcribeOne(file, "audio/wav", mode), () => onProgress?.(`${label}, waiting for Google`)));
    }
    return texts.map((t) => t.trim()).filter(Boolean).join("\n\n");
  } finally {
    if (parts) cleanup(parts);
  }
}
