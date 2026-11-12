// A recording Sarvam cannot take in one piece is cut into short pieces and put back together. The "send these files to Sarvam"
// step is replaced by a fake here, so nothing is sent anywhere and nothing is charged.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RATE, wavBytes } from "../server/audio";
import { isSarvamContextError, transcribePieces, type BatchResult, type Piece } from "../server/sarvam";

const CONTEXT_FAILURE = `400:{"error":{"message":"Input length (4192) exceeds model's maximum context length (4096).","code":"invalid_request_error"}}`;
let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "pechu-split-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// pieces of real (tone) audio on disk, because splitting a piece in half reads its samples
async function pieces(n: number, seconds: number): Promise<Piece[]> {
  const list: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const path = join(dir, `piece-${n}-${seconds}-${i}.wav`);
    await Bun.write(path, wavBytes(new Int16Array(seconds * RATE).fill(8000)));
    list.push({ name: `piece-${n}-${seconds}-${i}.wav`, path, start: i * seconds, seconds });
  }
  return list;
}
// what Sarvam returns for one file: its times start at 0 inside that file
const output = (text: string) => ({ timestamps: { words: [text], start_time_seconds: [0], end_time_seconds: [1] } });
const ok = (files: Piece[], text: (f: Piece) => string = (f) => `said ${f.name}`): BatchResult => ({ ok: new Map(files.map((f) => [f.name, output(text(f))])), failed: new Map() });
const stamps = (text: string) => [...text.matchAll(/^\[(\d+):(\d{2})\]/gm)].map((m) => Number(m[1]) * 60 + Number(m[2]));

test("the length failure Sarvam gave for the first long recording is recognised", () => {
  expect(isSarvamContextError(CONTEXT_FAILURE)).toBe(true);
  expect(isSarvamContextError("413:payload too large")).toBe(false);
  expect(isSarvamContextError(`400:{"error":{"message":"language not supported"}}`)).toBe(false);
  expect(isSarvamContextError("")).toBe(false);
});

test("the pieces are stitched together with their start times added", async () => {
  const p = await pieces(3, 120);
  const text = await transcribePieces(p, async (files) => ok(files), () => {});
  expect(stamps(text)).toEqual([0, 120, 240]);
  expect(text.split("\n\n").map((s) => s.replace(/^\[\d+:\d{2}\] /, ""))).toEqual(p.map((f) => `said ${f.name}`));
});

test("at most 20 files go into one Sarvam job", async () => {
  const p = await pieces(45, 10);
  const sizes: number[] = [];
  const text = await transcribePieces(p, async (files) => { sizes.push(files.length); return ok(files); }, () => {});
  expect(sizes).toEqual([20, 20, 5]);
  expect(stamps(text).length).toBe(45);
});

test("a piece Sarvam cannot take is cut in half and only that piece is sent again", async () => {
  const p = await pieces(3, 120);
  const calls: string[][] = [];
  const text = await transcribePieces(p, async (files) => {
    calls.push(files.map((f) => f.name));
    const bad = files.find((f) => f.name === p[1]!.name);
    if (!bad) return ok(files);
    return { ok: new Map(files.filter((f) => f !== bad).map((f) => [f.name, output(`said ${f.name}`)])), failed: new Map([[bad.name, CONTEXT_FAILURE]]) };
  }, () => {});
  expect(calls.length).toBe(2);
  expect(calls[0]!.length).toBe(3);
  expect(calls[1]!.length).toBeGreaterThanOrEqual(2); // only the pieces cut from the failed one, not the ones that already worked
  expect(calls[1]!.some((n) => n === p[0]!.name || n === p[2]!.name || n === p[1]!.name)).toBe(false);
  const s = stamps(text);
  expect(s.length).toBe(2 + calls[1]!.length);
  expect([...s].sort((a, b) => a - b)).toEqual(s); // still in order
  expect(s[0]).toBe(0);
  expect(s[1]).toBe(120); // the first cut piece starts where the failed piece started
  for (const t of s.slice(2, -1)) { expect(t).toBeGreaterThan(120); expect(t).toBeLessThan(240); } // the others start inside it
  expect(s.at(-1)).toBe(240);
});

test("a piece too short to cut again gives a plain error", async () => {
  const p = await pieces(1, 20);
  await expect(transcribePieces(p, async (files) => ({ ok: new Map(), failed: new Map(files.map((f) => [f.name, CONTEXT_FAILURE])) }), () => {}))
    .rejects.toThrow(/could not process this recording in one piece/);
});

test("any other failure stops at once and is not retried by cutting", async () => {
  const p = await pieces(2, 120);
  let calls = 0;
  await expect(transcribePieces(p, async (files) => { calls++; return { ok: new Map(), failed: new Map(files.map((f) => [f.name, "503:upstream connect error"])) }; }, () => {}))
    .rejects.toThrow(/trouble on its side/);
  expect(calls).toBe(1);
});

test("a piece with no speech adds nothing, and a recording with no speech at all is reported", async () => {
  const p = await pieces(2, 60);
  const quiet = (files: Piece[]): BatchResult => ({ ok: new Map(files.map((f) => [f.name, f === p[0] ? output("hello") : { timestamps: { words: [], start_time_seconds: [] }, transcript: "" }])), failed: new Map() });
  expect(await transcribePieces(p, async (f) => quiet(f), () => {})).toBe("[00:00] hello");
  await expect(transcribePieces(p, async (files) => ({ ok: new Map(files.map((f) => [f.name, { transcript: "" }])), failed: new Map() }), () => {})).rejects.toThrow(/no speech/);
});
