// Transcribes a recording with Sarvam's Saaras model, which is built for Indian languages and for speech that mixes
// Tamil and English. It runs as a batch job (upload, start, wait, download), takes files up to 2 hours long, and can
// label speakers. The key comes from SARVAM_API_KEY in .env.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SarvamAIClient } from "sarvamai";
import { UserError, isNetworkError } from "./errors";
import { fmtStamp, turnsFromEntries } from "./text";

export const sarvamKey = () => process.env.SARVAM_API_KEY?.trim() || "";
export const sarvamEnabled = () => !!sarvamKey();
export const SARVAM_NAME = "Sarvam Saaras v4";

// codemix keeps English words in English letters inside Tamil sentences; verbatim also keeps filler words.
export type SarvamMode = "codemix" | "verbatim";

// What the person reads for anything Sarvam, or the connection to it, reports. The raw text goes to the log only (see describeError).
// Sarvam's own failure text starts with the status, for example `400:{"error":...}`, so that is read when no status is given.
export function sarvamMessage(raw: string, status?: number): string {
  const code = status ?? (Number(/^\s*(\d{3})\b/.exec(raw)?.[1]) || undefined);
  if (code === 401 || code === 403) return "Sarvam did not accept the API key. Check SARVAM_API_KEY in .env.";
  if (code === 402 || /insufficient|credit|balance/i.test(raw)) return "The Sarvam account is out of credits. Add credits at dashboard.sarvam.ai and try again.";
  if (code === 429) return "Sarvam is rate limiting this key. Wait a minute and try again.";
  if (code === 413 || /too large|file size/i.test(raw)) return "Sarvam says this recording is too large. Try a shorter recording.";
  if (code === 400 && /context length|input length|too long|exceeds/i.test(raw))
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
    if (results.failed.length) {
      const raw = String(results.failed[0]!.error_message ?? "");
      throw new UserError(sarvamMessage(raw), { cause: new Error(raw) });
    }
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
