// Transcribes a recording with Sarvam's Saaras model, which is built for Indian languages and for speech that mixes
// Tamil and English. It runs as a batch job (upload, start, wait, download), takes files up to 2 hours long, and can
// label speakers. The key comes from SARVAM_API_KEY in .env.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SarvamAIClient } from "sarvamai";
import { UserError } from "./gemini";
import { fmtStamp, turnsFromEntries } from "./text";

export const sarvamKey = () => process.env.SARVAM_API_KEY?.trim() || "";
export const sarvamEnabled = () => !!sarvamKey();
export const SARVAM_NAME = "Sarvam Saaras v4";

// codemix keeps English words in English letters inside Tamil sentences; verbatim also keeps filler words.
export type SarvamMode = "codemix" | "verbatim";

function sarvamError(e: unknown): Error {
  if (e instanceof UserError) return e;
  const status = (e as { statusCode?: number; status?: number } | null)?.statusCode ?? (e as { status?: number } | null)?.status;
  const raw = e instanceof Error ? e.message : String(e);
  if (status === 401 || status === 403) return new UserError("Sarvam did not accept the API key. Check SARVAM_API_KEY in .env.");
  if (status === 402 || /insufficient|credit|balance/i.test(raw)) return new UserError("The Sarvam account is out of credits. Add credits at dashboard.sarvam.ai and try again.");
  if (status === 429) return new UserError("Sarvam is rate limiting this key. Wait a minute and try again.");
  return new UserError(`Sarvam could not transcribe this audio: ${raw.slice(0, 200)}`);
}

const PARAGRAPH_SECONDS = 30; // start a new paragraph this long after the paragraph began...
const PAUSE_SECONDS = 2; // ...or after a silence this long

// Turns the batch output JSON into the transcript Pechu stores: timed speaker turns when speakers are wanted, otherwise timed
// paragraphs built from the chunk timestamps, otherwise the plain transcript string.
export function parseSarvamOutput(out: any, opts: { speakers: boolean }): string {
  const turns = opts.speakers ? turnsFromEntries(out?.diarized_transcript?.entries) : "";
  return turns || timedParagraphs(out?.timestamps) || String(out?.transcript ?? "").trim();
}

function timedParagraphs(ts: any): string {
  // the real output names the text array "words" (each entry is a sentence-sized piece); "chunks" is the documented name
  const chunks: unknown = ts?.chunks ?? ts?.words, starts: unknown = ts?.start_time_seconds, ends: unknown = ts?.end_time_seconds;
  if (!Array.isArray(chunks) || !Array.isArray(starts)) return "";
  const paras: string[] = [];
  let buf: string[] = [];
  let paraStart = 0, prevEnd = 0;
  const flush = () => { if (buf.length) paras.push(`${fmtStamp(paraStart)} ${buf.join(" ")}`); buf = []; };
  chunks.forEach((c, i) => {
    const text = String(c ?? "").trim();
    const start = starts[i];
    if (!text || typeof start !== "number" || !Number.isFinite(start)) return;
    if (buf.length && (start - paraStart >= PARAGRAPH_SECONDS || start - prevEnd >= PAUSE_SECONDS)) flush();
    if (!buf.length) paraStart = start;
    buf.push(text);
    const end = Array.isArray(ends) ? ends[i] : undefined;
    prevEnd = typeof end === "number" && Number.isFinite(end) ? end : start;
  });
  flush();
  return paras.join("\n\n");
}

export async function transcribeWithSarvam(
  path: string,
  opts: { mode: SarvamMode; speakers: boolean },
  onProgress?: (note: string) => void,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pechu-sarvam-"));
  try {
    const client = new SarvamAIClient({ apiSubscriptionKey: sarvamKey() });
    onProgress?.("Sending the recording to Sarvam");
    // "unknown" = detect the language by itself, which handles Tamil with English mixed in
    const job = await client.speechToTextJob.createJob({
      model: "saaras:v4", mode: opts.mode, languageCode: "unknown", withDiarization: opts.speakers, withTimestamps: true,
    } as any);
    await job.uploadFiles([path], 900);
    await job.start();
    onProgress?.("Transcribing with Sarvam");
    await job.waitUntilComplete(1, 3 * 3600); // check every second, give up after 3 hours
    const results = await job.getFileResults();
    if (results.failed.length) throw new UserError(`Sarvam could not transcribe this audio: ${results.failed[0]!.error_message}`);
    await job.downloadOutputs(dir);
    const file = readdirSync(dir).find((f) => f.endsWith(".json"));
    if (!file) throw new UserError("Sarvam finished but returned no transcript.");
    const out = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const text = parseSarvamOutput(out, { speakers: opts.speakers });
    if (!text) throw new UserError("Sarvam found no speech in this recording.");
    return text;
  } catch (e) {
    throw sarvamError(e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
