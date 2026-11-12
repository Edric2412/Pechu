// Transcribes a recording with Sarvam's Saaras model, which is built for Indian languages and for speech that mixes
// Tamil and English. It runs as a batch job (upload, start, wait, download), takes files up to 2 hours long, and can
// label speakers. The key comes from SARVAM_API_KEY in .env.
//
// Some recordings (a long one with constant background noise has no quiet moments to cut at) make Sarvam answer "Input
// length ... exceeds model's maximum context length". Such a recording is then cut into short pieces here, sent in
// batches, and put back together with the right times. Trying the whole recording first costs nothing when it fails.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SarvamAIClient } from "sarvamai";
import { RATE, chooseCuts, cleanup, prepareParts, readWavPcm, wavBytes } from "./audio";
import { UserError, isNetworkError } from "./errors";
import { fmtStamp, turnsFromEntries } from "./text";

export const sarvamKey = () => process.env.SARVAM_API_KEY?.trim() || "";
export const sarvamEnabled = () => !!sarvamKey();
export const SARVAM_NAME = "Sarvam Saaras v4";

// codemix keeps English words in English letters inside Tamil sentences; verbatim also keeps filler words.
export type SarvamMode = "codemix" | "verbatim";

// Sarvam's failure text starts with the status, for example `400:{"error":...}`.
const statusOf = (raw: string) => Number(/^\s*(\d{3})\b/.exec(raw)?.[1]) || undefined;
const LENGTH_LIMIT = /context length|input length|too long|exceeds/i;
// Sarvam could not take this audio in one piece: cutting it into shorter pieces can help.
export const isSarvamContextError = (raw: string) => statusOf(raw) === 400 && LENGTH_LIMIT.test(raw);

// What the person reads for anything Sarvam, or the connection to it, reports. The raw text goes to the log only (see describeError).
// Sarvam's own failure text starts with the status, for example `400:{"error":...}`, so that is read when no status is given.
export function sarvamMessage(raw: string, status?: number): string {
  const code = status ?? statusOf(raw);
  if (code === 401 || code === 403) return "Sarvam did not accept the API key. Check SARVAM_API_KEY in .env.";
  if (code === 402 || /insufficient|credit|balance/i.test(raw)) return "The Sarvam account is out of credits. Add credits at dashboard.sarvam.ai and try again.";
  if (code === 429) return "Sarvam is rate limiting this key. Wait a minute and try again.";
  if (code === 413 || /too large|file size/i.test(raw)) return "Sarvam says this recording is too large. Try a shorter recording.";
  if (code === 400 && LENGTH_LIMIT.test(raw))
    return "Sarvam could not process this recording in one piece. This can happen when a long recording has constant background noise. Try a shorter section of it.";
  if (code !== undefined && code >= 500) return "Sarvam is having trouble on its side. Try again in a few minutes.";
  if (isNetworkError(raw)) return "Pechu could not reach Sarvam. Check the internet connection and try again.";
  return "Sarvam could not transcribe this recording. Try again, and if it keeps failing, try a shorter recording.";
}

function sarvamError(e: unknown): Error {
  if (e instanceof UserError) return e;
  const status = (e as { statusCode?: number; status?: number } | null)?.statusCode ?? (e as { status?: number } | null)?.status;
  const raw = e instanceof Error ? e.message : String(e);
  return new UserError(sarvamMessage(raw, status), { cause: e });
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

const PIECE_SECONDS = 120; // the first cut: pieces of about two minutes
const MIN_PIECE_SECONDS = 30; // a piece shorter than twice this is not cut again
const FILES_PER_JOB = 20; // Sarvam takes at most 20 files in one batch job

export type Piece = { name: string; path: string; start: number; seconds: number };
// What one batch job gave back, by file name: the output for each file that worked, the failure text for each that did not.
export type BatchResult = { ok: Map<string, any>; failed: Map<string, string> };

// Sarvam's times start at 0 inside each file; add where the file starts in the whole recording.
function shifted(out: any, secs: number): any {
  const ts = out?.timestamps;
  if (!secs || !ts) return out;
  const add = (a: unknown) => (Array.isArray(a) ? a.map((x) => (typeof x === "number" ? x + secs : x)) : a);
  return { ...out, timestamps: { ...ts, start_time_seconds: add(ts.start_time_seconds), end_time_seconds: add(ts.end_time_seconds) } };
}

// Cuts a piece into halves (at the quietest moment near the middle), as new files next to it.
async function halve(p: Piece): Promise<Piece[]> {
  const pcm = readWavPcm(Buffer.from(await Bun.file(p.path).arrayBuffer()));
  const bounds = [0, ...chooseCuts(pcm, Math.ceil(p.seconds / 2)), pcm.length];
  const halves: Piece[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const name = `${p.name.replace(/\.wav$/, "")}-${String.fromCharCode(97 + i)}.wav`;
    const path = join(dirname(p.path), name);
    await Bun.write(path, wavBytes(pcm.subarray(bounds[i], bounds[i + 1])));
    halves.push({ name, path, start: p.start + bounds[i]! / RATE, seconds: (bounds[i + 1]! - bounds[i]!) / RATE });
  }
  return halves;
}

// Sends the pieces to Sarvam (at most 20 files per job) and joins what comes back. A piece Sarvam still cannot take is cut in
// half and only that piece is sent again; any other failure stops here. Speaker labels are not asked for: each file is
// labelled on its own, so the names would not match from piece to piece.
export async function transcribePieces(
  pieces: Piece[],
  runBatch: (files: Piece[]) => Promise<BatchResult>,
  onProgress?: (note: string) => void,
): Promise<string> {
  const texts = new Map<number, string>(); // by start time, so the pieces come out in order
  let pending = pieces;
  for (let round = 0; pending.length; round++) {
    const tooLong: Piece[] = [];
    for (let i = 0; i < pending.length; i += FILES_PER_JOB) {
      const batch = pending.slice(i, i + FILES_PER_JOB);
      onProgress?.(round === 0 ? `Transcribing parts ${i + 1} to ${i + batch.length} of ${pending.length} with Sarvam` : `Cutting ${pending.length} parts shorter and trying again`);
      const result = await runBatch(batch);
      for (const f of batch) {
        const out = result.ok.get(f.name);
        if (out !== undefined) {
          const text = parseSarvamOutput(shifted(out, f.start), { speakers: false });
          if (text) texts.set(f.start, text);
          continue;
        }
        const raw = result.failed.get(f.name) ?? "";
        if (isSarvamContextError(raw) && f.seconds >= 2 * MIN_PIECE_SECONDS) { tooLong.push(f); continue; }
        throw new UserError(sarvamMessage(raw), { cause: new Error(raw) });
      }
    }
    pending = (await Promise.all(tooLong.map(halve))).flat();
  }
  const text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("\n\n");
  if (!text) throw new UserError("Sarvam found no speech in this recording.");
  return text;
}

// One Sarvam batch job for these files. Files that worked come back in `ok`, files that did not in `failed`.
async function runJob(
  client: SarvamAIClient, files: string[], opts: { mode: SarvamMode; speakers: boolean }, outDir: string,
  onProgress: ((note: string) => void) | undefined, sending: string, working: string,
): Promise<BatchResult> {
  onProgress?.(sending);
  // "unknown" = detect the language by itself, which handles Tamil with English mixed in
  const job = await client.speechToTextJob.createJob({
    model: "saaras:v4", mode: opts.mode, languageCode: "unknown", withDiarization: opts.speakers, withTimestamps: true,
  } as any);
  await job.uploadFiles(files, 900);
  await job.start();
  onProgress?.(working);
  await job.waitUntilComplete(1, 3 * 3600); // check every second, give up after 3 hours
  const results = await job.getFileResults();
  const failed = new Map(results.failed.map((f) => [f.file_name, String(f.error_message ?? "")] as [string, string]));
  const ok = new Map<string, any>();
  if (results.successful.length) {
    await job.downloadOutputs(outDir); // only the files that worked are downloaded, each as <file name>.json
    for (const f of results.successful) ok.set(f.file_name, JSON.parse(readFileSync(join(outDir, `${f.file_name}.json`), "utf8")));
  }
  return { ok, failed };
}

export async function transcribeWithSarvam(
  path: string,
  opts: { mode: SarvamMode; speakers: boolean },
  onProgress?: (note: string) => void,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pechu-sarvam-"));
  try {
    const client = new SarvamAIClient({ apiSubscriptionKey: sarvamKey() });
    const whole = await runJob(client, [path], opts, dir, onProgress, "Sending the recording to Sarvam", "Transcribing with Sarvam");
    const name = basename(path);
    const out = whole.ok.get(name);
    if (out !== undefined) {
      const text = parseSarvamOutput(out, { speakers: opts.speakers });
      if (!text) throw new UserError("Sarvam found no speech in this recording.");
      return text;
    }
    const raw = whole.failed.get(name);
    if (raw === undefined) throw new UserError("Sarvam finished but returned no transcript.");
    if (!isSarvamContextError(raw)) throw new UserError(sarvamMessage(raw), { cause: new Error(raw) });

    // Sarvam could not take the whole recording (a failed job is not charged): cut it into short pieces instead.
    console.error(`[sarvam] whole recording refused, splitting into pieces: ${raw.slice(0, 200)}`);
    onProgress?.(opts.speakers
      ? "Sarvam could not take the whole recording, so it is being cut into parts. Speaker labels are not available this way."
      : "Sarvam could not take the whole recording, so it is being cut into parts");
    const parts = await prepareParts(path, PIECE_SECONDS); // over the length limit: this throws the plain "too long" error
    if (!parts) throw new UserError(sarvamMessage(raw), { cause: new Error(raw) }); // cannot be cut here (no decoder)
    try {
      let start = 0;
      const pieces: Piece[] = parts.files.map((file) => {
        const seconds = (Bun.file(file).size - 44) / (RATE * 2); // a 44-byte WAV header, then 16-bit mono samples
        const piece = { name: basename(file), path: file, start, seconds };
        start += seconds;
        return piece;
      });
      return await transcribePieces(pieces, (files) => runJob(
        client, files.map((f) => f.path), { mode: opts.mode, speakers: false }, dir, onProgress,
        `Sending ${files.length} parts to Sarvam`, `Transcribing ${files.length} parts with Sarvam`,
      ), onProgress);
    } finally {
      cleanup(parts);
    }
  } catch (e) {
    throw sarvamError(e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
