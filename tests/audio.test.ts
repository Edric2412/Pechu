import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioTooLongError, PART_SECONDS, RATE, assertWithinLimit, chooseCuts, cleanup, maxAudioMinutes, prepareParts, readWavPcm, wavBytes } from "../server/audio";
import { friendlyError, isBusy, isDailyLimit, isRateLimit, transcribeFile, withRetry } from "../server/gemini";

// A tone-filled signal with short silences at chosen seconds.
function signal(seconds: number, quietAt: number[]): Int16Array {
  const pcm = new Int16Array(seconds * RATE).fill(8000);
  for (const q of quietAt) pcm.fill(0, Math.floor(q * RATE), Math.floor((q + 0.3) * RATE));
  return pcm;
}

test("a WAV written by wavBytes reads back to the same samples", () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
  expect(Array.from(readWavPcm(wavBytes(pcm)))).toEqual(Array.from(pcm));
});

test("readWavPcm skips extra chunks before the data and rejects non-WAV input", () => {
  const plain = wavBytes(Int16Array.from([5, 6, 7]));
  const extra = Buffer.concat([plain.subarray(0, 36), Buffer.from("LIST\x04\x00\x00\x00abcd", "binary"), plain.subarray(36)]);
  expect(Array.from(readWavPcm(extra))).toEqual([5, 6, 7]);
  expect(() => readWavPcm(Buffer.from("not a wav file at all"))).toThrow();
});

test("short audio is not split", () => {
  expect(chooseCuts(signal(5 * 60, []))).toEqual([]);
  expect(chooseCuts(signal(PART_SECONDS + 60, []))).toEqual([]); // under 1.25 parts: keep it whole
});

test("long audio is cut at the quiet moment before each boundary, not mid-speech", () => {
  const quiet = PART_SECONDS - 7; // silence 7 s before the first target
  const cuts = chooseCuts(signal(25 * 60, [quiet, 2 * PART_SECONDS - 12]));
  expect(cuts.length).toBe(2);
  expect(Math.abs(cuts[0]! / RATE - (quiet + 0.15))).toBeLessThan(0.2);
  expect(cuts[1]! / RATE).toBeGreaterThan(cuts[0]! / RATE + PART_SECONDS - 30);
});

test("with no quiet moment the cut lands on the boundary itself", () => {
  const cuts = chooseCuts(signal(25 * 60, []));
  expect(cuts[0]! / RATE).toBeGreaterThan(PART_SECONDS - 26);
  expect(cuts[0]! / RATE).toBeLessThanOrEqual(PART_SECONDS);
});

test("rate limit errors are recognised and retried, other errors are not", async () => {
  expect(isRateLimit(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
  expect(isRateLimit(new Error("Rate limit exceeded for model gemini-3.5-transcribe"))).toBe(true);
  expect(isRateLimit(new Error("400 Request contains an invalid argument."))).toBe(false);

  let calls = 0;
  const waits: number[] = [];
  const out = await withRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error("Rate limit exceeded"), { status: 429 });
    return "done";
  }, (s) => waits.push(s), 6, 0);
  expect(out).toBe("done");
  expect(calls).toBe(3);
  expect(waits.length).toBe(2);

  let bad = 0;
  await expect(withRetry(async () => { bad++; throw new Error("400 Request contains an invalid argument."); }, undefined, 6, 0)).rejects.toThrow("invalid argument");
  expect(bad).toBe(1);

  let always = 0;
  await expect(withRetry(async () => { always++; throw new Error("Rate limit exceeded"); }, undefined, 3, 0)).rejects.toThrow("Rate limit");
  expect(always).toBe(3);
});

test("a daily quota is never retried, and the message says when it resets", async () => {
  const daily = Object.assign(new Error("429 Rate limit exceeded for model x (limit: 25 requests per day on Free Tier). Please retry in 14h21m22s"), { status: 429 });
  expect(isDailyLimit(daily)).toBe(true);
  expect(isRateLimit(daily)).toBe(false);
  let calls = 0;
  await expect(withRetry(async () => { calls++; throw daily; }, undefined, 6, 0)).rejects.toThrow("per day");
  expect(calls).toBe(1);
  expect(friendlyError(daily)).toContain("in about 14 h 21 min");
});

test("a busy Gemini is retried", async () => {
  const busy = Object.assign(new Error("503 The model is overloaded"), { status: 503 });
  expect(isBusy(busy)).toBe(true);
  let calls = 0;
  expect(await withRetry(async () => { if (++calls < 3) throw busy; return "ok"; }, undefined, 6, 0)).toBe("ok");
  expect(calls).toBe(3);
});

// ----- the 2-hour limit -----
test("the default longest recording is 2 hours", () => {
  const prev = process.env.MAX_AUDIO_MINUTES;
  delete process.env.MAX_AUDIO_MINUTES;
  try { expect(maxAudioMinutes()).toBe(120); } finally { if (prev !== undefined) process.env.MAX_AUDIO_MINUTES = prev; }
});

// These run the real decoder (gst-launch-1.0), so they are skipped on a machine without GStreamer.
const gst = !!Bun.which("gst-launch-1.0");
async function wavFile(seconds: number) {
  const dir = mkdtempSync(join(tmpdir(), "pechu-test-"));
  const path = join(dir, "a.wav");
  await Bun.write(path, wavBytes(signal(seconds, [])));
  return { dir, path };
}
async function withLimit(minutes: string, run: () => Promise<void>) {
  const prev = process.env.MAX_AUDIO_MINUTES;
  process.env.MAX_AUDIO_MINUTES = minutes;
  try { await run(); } finally { if (prev === undefined) delete process.env.MAX_AUDIO_MINUTES; else process.env.MAX_AUDIO_MINUTES = prev; }
}

test.skipIf(!gst)("a recording over the limit is refused with a clear message, never sent on whole", async () => {
  const { dir, path } = await wavFile(75);
  try {
    await withLimit("1", async () => {
      await expect(assertWithinLimit(path)).rejects.toBeInstanceOf(AudioTooLongError);
      await expect(prepareParts(path)).rejects.toBeInstanceOf(AudioTooLongError);
      // Gemini path: it must stop here and not upload the original file
      await expect(transcribeFile(path, "audio/wav", "smart")).rejects.toThrow(/longer than 1 minute/);
      try { await assertWithinLimit(path); } catch (e) { expect(friendlyError(e)).toContain("Split it into shorter recordings"); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!gst)("a recording within the limit is accepted", async () => {
  const { dir, path } = await wavFile(30);
  try {
    await withLimit("1", async () => {
      await assertWithinLimit(path);
      const parts = await prepareParts(path);
      expect(parts).not.toBeNull();
      cleanup(parts!);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
