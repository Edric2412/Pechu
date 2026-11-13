// Turns any uploaded audio into clean 16 kHz mono WAV parts that Gemini accepts.
//
// Why: Gemini's reader rejected a perfectly valid 28-minute AAC file ("400 invalid argument") but accepted the
// same audio as WAV. Converting first also makes every format behave the same, and lets long meetings be sent
// in parts so a rate limit or a size limit only affects one part.
//
// Conversion uses GStreamer (gst-launch-1.0), which Ubuntu Desktop already has. If it is missing,
// prepareParts() returns null and the caller sends the original file instead.
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors";

export const RATE = 16000;
export const PART_SECONDS = 10 * 60; // each part is about 10 minutes
export const SPEAKER_PART_SECONDS = 25 * 60; // speaker labels work up to 30 minutes per request, and fewer parts keeps labels consistent
const SEARCH_SECONDS = 25; // look this far back from a part boundary for a quiet moment
const FRAME = 1600; // 100 ms of samples

export function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// Finds the PCM samples inside a WAV file by walking its chunks (so extra chunks like LIST do not matter).
export function readWavPcm(file: Buffer): Int16Array {
  if (file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let pos = 12;
  while (pos + 8 <= file.length) {
    const id = file.toString("ascii", pos, pos + 4);
    const size = file.readUInt32LE(pos + 4);
    if (id === "data") {
      const start = pos + 8;
      const end = Math.min(file.length, start + size);
      const bytes = (end - start) & ~1;
      // copy so the Int16Array is aligned whatever the Buffer's offset is
      return new Int16Array(file.buffer.slice(file.byteOffset + start, file.byteOffset + start + bytes));
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error("WAV file has no audio data");
}

// Sample positions where to cut so that each part is about `partSeconds` long, but never in the middle of speech:
// each cut moves to the quietest 100 ms in the last SEARCH_SECONDS before the target.
export function chooseCuts(pcm: Int16Array, partSeconds = PART_SECONDS): number[] {
  const cuts: number[] = [];
  const part = partSeconds * RATE;
  let from = 0;
  while (pcm.length - from > part * 1.25) {
    const target = from + part;
    const lo = Math.max(from + FRAME, target - SEARCH_SECONDS * RATE);
    let best = target, bestEnergy = Infinity;
    for (let s = lo; s + FRAME <= target; s += FRAME) {
      let e = 0;
      for (let i = s; i < s + FRAME; i++) e += pcm[i]! * pcm[i]!;
      if (e < bestEnergy) { bestEnergy = e; best = s + FRAME / 2; }
    }
    cuts.push(best);
    from = best;
  }
  return cuts;
}

export function wavBytes(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.concat([wavHeader(data.length), data]);
}

// Plugins that can fetch from the network (playlist/manifest demuxers, HTTP sources) are switched off for this child:
// an "audio" file that is really a playlist must not make the server request other addresses (SSRF).
export const GST_ENV_RANK =
  "hlsdemux:0,hlsdemux2:0,dashdemux:0,dashdemux2:0,mssdemux:0,mssdemux2:0,souphttpsrc:0,curlhttpsrc:0,neonhttpsrc:0,rtspsrc:0,rtmpsrc:0,rtmp2src:0,srtsrc:0,udpsrc:0,tcpclientsrc:0";
// The longest recording Pechu transcribes: 2 hours unless MAX_AUDIO_MINUTES says otherwise.
export const maxAudioMinutes = () => (Number(process.env.MAX_AUDIO_MINUTES) > 0 ? Number(process.env.MAX_AUDIO_MINUTES) : 120);
const MAX_DECODED_BYTES = () => maxAudioMinutes() * 60 * RATE * 2;

// A recording over the limit. It is shown to the person as written, and the job stops: the original file is never sent on.
export class AudioTooLongError extends UserError {
  constructor() {
    const n = maxAudioMinutes();
    super(`That recording is longer than ${n} minute${n === 1 ? "" : "s"}, which is the most Pechu transcribes at a time. Split it into shorter recordings and upload each one.`);
  }
}

async function gstConvert(src: string, dest: string): Promise<void> {
  // Each argument is passed separately (no shell). Paths here are the app's own: data/meetings/<id>/audio.<ext>.
  const proc = Bun.spawn(
    ["gst-launch-1.0", "-q", "filesrc", `location=${src}`, "!", "decodebin", "!", "audioconvert", "!", "audioresample", "!",
      `audio/x-raw,format=S16LE,rate=${RATE},channels=1`, "!", "wavenc", "!", "filesink", `location=${dest}`],
    // a bare environment: none of the app's keys or passwords are given to the decoder
    { stdout: "ignore", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), GST_PLUGIN_FEATURE_RANK: GST_ENV_RANK } },
  );
  const timeout = setTimeout(() => proc.kill(), 10 * 60 * 1000);
  // decoded audio is 32 KB per second whatever the size of the file: stop a decode that grows past the limit
  let tooLong = false;
  const watch = setInterval(() => {
    if (Bun.file(dest).size > MAX_DECODED_BYTES()) { tooLong = true; proc.kill(); }
  }, 250);
  const code = await proc.exited;
  clearTimeout(timeout);
  clearInterval(watch);
  if (tooLong || (code === 0 && Bun.file(dest).size > MAX_DECODED_BYTES())) throw new AudioTooLongError();
  if (code !== 0) throw new Error(`Audio conversion failed: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
}

export type Parts = { dir: string; files: string[]; seconds: number };

// Converts `src` and splits it. Returns null when conversion is not possible (the caller then sends the original).
// Throws AudioTooLongError when the recording is over the limit: that one is never sent on whole.
// The caller must call cleanup(parts) when done.
export async function prepareParts(src: string, partSeconds = PART_SECONDS): Promise<Parts | null> {
  if (!Bun.which("gst-launch-1.0")) return null;
  const dir = mkdtempSync(join(tmpdir(), "pechu-"));
  try {
    const full = join(dir, "full.wav");
    await gstConvert(src, full);
    const pcm = readWavPcm(Buffer.from(await Bun.file(full).arrayBuffer()));
    if (pcm.length < RATE / 2) throw new Error("No audio was found in the file");
    rmSync(full);
    const cuts = chooseCuts(pcm, partSeconds);
    const bounds = [0, ...cuts, pcm.length];
    const files: string[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const path = join(dir, `part-${String(i + 1).padStart(2, "0")}.wav`);
      await Bun.write(path, wavBytes(pcm.subarray(bounds[i], bounds[i + 1])));
      files.push(path);
    }
    return { dir, files, seconds: pcm.length / RATE };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (e instanceof AudioTooLongError) throw e;
    console.error("[audio] conversion skipped:", (e as Error).message);
    return null;
  }
}

// For a recording that goes to a service as it is (Sarvam): throws AudioTooLongError when it is over the limit.
// If the decoder is missing or cannot read the file, this does nothing and the caller carries on as before.
export async function assertWithinLimit(src: string): Promise<void> {
  if (!Bun.which("gst-launch-1.0")) return;
  const dir = mkdtempSync(join(tmpdir(), "pechu-len-"));
  try {
    await gstConvert(src, join(dir, "length-check.wav"));
  } catch (e) {
    if (e instanceof AudioTooLongError) throw e;
    console.error("[audio] length check skipped:", (e as Error).message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const cleanup = (p: Parts) => rmSync(p.dir, { recursive: true, force: true });

// A recording made in the browser (MediaRecorder) is a live-style WebM: its header declares no total length and it has
// no seek index, so a player reports an infinite duration and draws a wrong progress bar (a 1 h 45 min meeting showed
// as about a minute). Rewriting the wrapper adds both; the audio itself is copied, not re-encoded.
// The original is replaced only when the rewrite finished and produced a whole file. On any failure the file stays
// exactly as it was and only the progress bar stays wrong, so this never risks the recording.
export async function addWebmDuration(path: string): Promise<boolean> {
  if (!Bun.which("gst-launch-1.0")) return false;
  const tmp = `${path}.fix`;
  const proc = Bun.spawn(
    ["gst-launch-1.0", "-q", "filesrc", `location=${path}`, "!", "matroskademux", "!", "webmmux", "!", "filesink", `location=${tmp}`],
    { stdout: "ignore", stderr: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), GST_PLUGIN_FEATURE_RANK: GST_ENV_RANK } },
  );
  const timeout = setTimeout(() => proc.kill(), 2 * 60 * 1000);
  const code = await proc.exited;
  clearTimeout(timeout);
  // the rewrite adds an index, so it is never smaller than the original: a much smaller file means something was cut off
  if (code === 0 && Bun.file(tmp).size >= Bun.file(path).size * 0.9) {
    renameSync(tmp, path);
    return true;
  }
  rmSync(tmp, { force: true });
  return false;
}
