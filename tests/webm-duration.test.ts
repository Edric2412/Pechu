import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWebmDuration, cleanup, prepareParts } from "../server/audio";
import { audioPath, createMeeting, getMeeting, saveAudio } from "../server/store";

// A browser recording (MediaRecorder) is a live-style WebM: its header declares no total length and there is no seek
// index, so a player reports an infinite duration and draws a wrong progress bar. addWebmDuration rewrites the wrapper.
// These run the real GStreamer tools, so they are skipped on a machine without the WebM muxer.
const webmMux = !!Bun.which("gst-launch-1.0") && Bun.spawnSync(["gst-inspect-1.0", "webmmux"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

// True when the Info section near the start of the file carries a Duration element (id 0x4489).
function webmHasDuration(path: string): boolean {
  const head = readFileSync(path).subarray(0, 1024);
  const at = head.findIndex((_, i) => head[i] === 0x15 && head[i + 1] === 0x49 && head[i + 2] === 0xa9 && head[i + 3] === 0x66);
  if (at < 0) throw new Error("no Info section found");
  const first = head[at + 4]!;
  const sizeBytes = Math.clz32(first) - 23; // the length of the size field is the leading zero bits of its first byte, plus one
  let size = first & (0xff >> sizeBytes);
  for (let i = 1; i < sizeBytes; i++) size = size * 256 + head[at + 4 + i]!;
  const info = head.subarray(at + 4 + sizeBytes, at + 4 + sizeBytes + size);
  return info.findIndex((_, i) => info[i] === 0x44 && info[i + 1] === 0x89) >= 0;
}

async function liveStyleWebm(seconds: number) {
  const dir = mkdtempSync(join(tmpdir(), "pechu-webm-"));
  const path = join(dir, "audio.webm");
  const proc = Bun.spawn(["gst-launch-1.0", "-q", "audiotestsrc", `num-buffers=${seconds * 100}`, "samplesperbuffer=480", "!", "audio/x-raw,rate=48000,channels=1",
    "!", "opusenc", "!", "webmmux", "streamable=true", "!", "filesink", `location=${path}`], { stdout: "ignore", stderr: "ignore" });
  expect(await proc.exited).toBe(0);
  return { dir, path };
}

test.skipIf(!webmMux)("a live-style WebM gets its length written in, and still decodes to the same audio", async () => {
  const { dir, path } = await liveStyleWebm(5);
  try {
    expect(webmHasDuration(path)).toBe(false); // the bug: Chrome-style recordings arrive like this
    const before = await prepareParts(path);
    expect(before).not.toBeNull();
    expect(await addWebmDuration(path)).toBe(true);
    expect(webmHasDuration(path)).toBe(true);
    expect(existsSync(`${path}.fix`)).toBe(false);
    const after = await prepareParts(path);
    expect(after).not.toBeNull();
    expect(after!.seconds).toBeCloseTo(before!.seconds, 1);
    cleanup(before!); cleanup(after!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!webmMux)("saving a recording stores a WebM with its length, and other formats as they came", async () => {
  const { dir, path } = await liveStyleWebm(3);
  const data = mkdtempSync(join(tmpdir(), "pechu-store-"));
  const prev = process.env.PECHU_DATA_DIR;
  process.env.PECHU_DATA_DIR = data;
  try {
    const m = createMeeting({ source: "live", status: "ready", transcript: "", title: "Length" });
    await saveAudio(m.id, readFileSync(path), "webm");
    expect(webmHasDuration(audioPath(getMeeting(m.id)!)!)).toBe(true);

    const other = createMeeting({ source: "upload", status: "ready", transcript: "", title: "Not webm" });
    const bytes = Buffer.from("not really an mp3, saved as it came");
    await saveAudio(other.id, bytes, "mp3");
    expect(readFileSync(audioPath(getMeeting(other.id)!)!).equals(bytes)).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.PECHU_DATA_DIR; else process.env.PECHU_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test.skipIf(!webmMux)("a file that cannot be rewritten is left exactly as it was", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pechu-webm-"));
  const path = join(dir, "audio.webm");
  const junk = Buffer.from("this is not a webm file at all");
  writeFileSync(path, junk);
  try {
    expect(await addWebmDuration(path)).toBe(false);
    expect(readFileSync(path).equals(junk)).toBe(true);
    expect(existsSync(`${path}.fix`)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
