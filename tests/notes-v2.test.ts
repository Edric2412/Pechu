import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flowFromEnglish, notesFromEnglish, parseFlow, validateNotes, validateProcess, type ModelCall } from "../server/gemini";
import { PART_PROMPT } from "../server/prompts";
import { chunkText } from "../server/text";

const flow = { label: "Release", kind: "root", children: [{ label: "Build", kind: "topic", at: 12.6 }] };
const v1 = () => ({
  title: " Release plan ",
  summary: "We plan the release.",
  keyPoints: ["Build on Friday", "  ", "Test first"],
  decisions: ["Ship Monday"],
  actions: [{ task: "Deploy", owner: "Ravi" }],
  flow,
});
const step = (id: string, kind = "step", next: { to: string; label?: string }[] = []) => ({ id, label: `Do ${id}`, kind, next });

test("v1 notes come back as v2", () => {
  const n = validateNotes(v1());
  expect(n.title).toBe("Release plan");
  expect(n.keyPoints).toEqual([{ text: "Build on Friday" }, { text: "Test first" }]);
  expect(n.decisions).toEqual([{ text: "Ship Monday" }]);
  expect(n.sections).toEqual([]);
  expect(n.process).toBeUndefined();
  expect(n.flow.children?.[0]?.at).toBe(13);
});

test("v2 items keep who and cleaned at; bad at is dropped", () => {
  const n = validateNotes({
    ...v1(),
    keyPoints: [{ text: " a ", at: 75.4 }, { text: "b", at: -3 }, { text: "c", at: "9" }, { text: "d", at: Infinity }, { text: "" }],
    decisions: [{ text: "Go", at: 0, who: " Ravi " }, { text: "Stop", who: "  " }],
    actions: [{ task: "T", at: 30.5 }],
  });
  expect(n.keyPoints).toEqual([{ text: "a", at: 75 }, { text: "b" }, { text: "c" }, { text: "d" }]);
  expect(n.decisions).toEqual([{ text: "Go", at: 0, who: "Ravi" }, { text: "Stop" }]);
  expect(n.actions).toEqual([{ task: "T", at: 31 }]);
});

test("sections: empty ones dropped, at most 10 sections of 12 bullets", () => {
  const bullets = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `b${i}`, at: i }));
  const sections = [
    { heading: "Empty", bullets: [{ text: " " }] },
    { heading: "No list" },
    { heading: " Big ", bullets: bullets(20) },
    ...Array.from({ length: 15 }, (_, i) => ({ heading: `S${i}`, bullets: bullets(1) })),
  ];
  const n = validateNotes({ ...v1(), sections });
  expect(n.sections).toHaveLength(10);
  expect(n.sections[0]!.heading).toBe("Big");
  expect(n.sections[0]!.bullets).toHaveLength(12);
});

test("process: dangling arrows dropped, duplicate ids renamed, first step is start", () => {
  const p = validateProcess({
    steps: [
      step("a", "step", [{ to: "b" }, { to: "ghost" }]),
      step("b", "decision", [{ to: "c", label: "Yes" }, { to: "a", label: "No" }]),
      step("b", "step", [{ to: "c" }]),
      step("c", "end", [{ to: "a" }]),
    ],
  })!;
  expect(p.steps.map((s) => s.id)).toEqual(["a", "b", "b-2", "c"]);
  expect(p.steps[0]!.kind).toBe("start");
  expect(p.steps[0]!.next).toEqual([{ to: "b" }]);
  expect(p.steps[1]!.next).toEqual([{ to: "c", label: "Yes" }, { to: "a", label: "No" }]); // cycle and labels kept
  expect(p.steps[3]!.next).toEqual([]); // end has no arrows
});

test("process: fewer than 3 valid steps is omitted; more than 30 is cut; unknown kind becomes step", () => {
  expect(validateProcess({ steps: [step("a"), step("b")] })).toBeUndefined();
  expect(validateProcess({ steps: [step("a"), step("b"), { id: "c", label: " ", kind: "step", next: [] }] })).toBeUndefined();
  expect(validateProcess(undefined)).toBeUndefined();
  const many = Array.from({ length: 40 }, (_, i) => step(`s${i}`));
  expect(validateProcess(many)!.steps).toHaveLength(30);
  expect(validateProcess([step("a"), { ...step("b"), kind: "weird" }, step("c")])!.steps[1]!.kind).toBe("step");
  expect(validateNotes({ ...v1(), process: { steps: [step("a"), step("b")] } }).process).toBeUndefined();
});

test("parseFlow reads flow and process only", () => {
  const raw = JSON.stringify({ flow, process: { steps: [step("a"), step("b"), step("c")] } });
  const out = parseFlow(raw);
  expect(out.flow.label).toBe("Release");
  expect(out.process?.steps).toHaveLength(3);
  expect(() => parseFlow(JSON.stringify({ process: { steps: [] } }))).toThrow();
});

// --- model path with a stubbed model ---

const modelNotes = (extra: object = {}) => ({
  title: "T",
  summary: "S",
  sections: [{ heading: "H", bullets: [{ text: "x", at: 75 }] }],
  keyPoints: [{ text: "k", at: 75 }],
  decisions: [],
  actions: [],
  flow: { ...flow, at: 5 },
  ...extra,
});

const turn = (sec: number, n: number) => `[${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}] Speaker ${n % 2 + 1}: ${"word ".repeat(150).trim()}`;
const stamped = (turns: number) => Array.from({ length: turns }, (_, i) => turn(i * 20, i)).join("\n\n");

test("short stamped transcript: one call, at survives", async () => {
  const calls: Parameters<ModelCall>[0][] = [];
  const call: ModelCall = async (r) => (calls.push(r), JSON.stringify(modelNotes()));
  const n = await notesFromEnglish(stamped(5), undefined, call);
  expect(calls).toHaveLength(1);
  expect(n.sections[0]!.bullets[0]!.at).toBe(75);
  expect(n.flow.at).toBe(5);
});

test("transcript without stamps: at is removed even if the model sent it", async () => {
  const plain = "Speaker 1: " + "we should release on Friday. ".repeat(10);
  const n = await notesFromEnglish(plain, undefined, async () => JSON.stringify(modelNotes()));
  expect(JSON.stringify(n)).not.toContain('"at"');
});

test("long transcript: part drafts (max 3 at once), then one final call that gets drafts, not the text", async () => {
  const english = stamped(120); // about 100k characters
  const parts = chunkText(english, 10000).length;
  expect(parts).toBeGreaterThan(3);
  let live = 0, peak = 0, finals = 0, partCalls = 0;
  const progress: string[] = [];
  let finalContents = "";
  const call: ModelCall = async (r) => {
    if (r.system === PART_PROMPT) {
      partCalls++;
      peak = Math.max(peak, ++live);
      await Bun.sleep(5);
      live--;
      return `[00:20] DRAFT of ${r.contents.slice(0, 8)}`;
    }
    finals++;
    finalContents = r.contents;
    return JSON.stringify(modelNotes());
  };
  const n = await notesFromEnglish(english, (p) => progress.push(p), call);
  expect(partCalls).toBe(parts);
  expect(peak).toBeLessThanOrEqual(3);
  expect(finals).toBe(1);
  expect(finalContents).toContain("=== Part 1 of");
  expect(finalContents).toContain(`=== Part ${parts} of ${parts}`);
  expect(finalContents.length).toBeLessThan(english.length / 5);
  expect(progress.some((p) => /Summarising part 2 of/.test(p))).toBe(true);
  expect(n.keyPoints[0]!.at).toBe(75);
});

test("flowFromEnglish returns flow and process and keeps the title in the request", async () => {
  let seen = "";
  const call: ModelCall = async (r) => (seen = r.contents, JSON.stringify({ flow, process: { steps: [step("a"), step("b"), step("c")] } }));
  const out = await flowFromEnglish(stamped(3), "My meeting", undefined, call);
  expect(seen).toContain("My meeting");
  expect(out.process?.steps).toHaveLength(3);
  await expect(flowFromEnglish("short", "x", undefined, call)).rejects.toThrow("not enough speech");
});

// --- HTTP: PATCH notes and the new endpoint guards (no model is ever called) ---

const PORT = 4381;
const base = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn>;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pechu-notes-"));
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server", "index.ts")], {
    env: { ...process.env, PORT: String(PORT), PECHU_DATA_DIR: dir, GEMINI_API_KEY: "" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("test server did not start");
});

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const api = (path: string, method = "GET", body?: unknown) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("PATCH validates notes, stores v2, and the guards for notes-only and flow answer 400", async () => {
  const m = await (await api("/api/meetings", "POST", { transcript: "Speaker 1: hello there everyone", title: "T" })).json();
  const id = m.id as string;

  expect((await api(`/api/meetings/${id}/flow`, "POST")).status).toBe(400); // no notes yet
  expect((await api(`/api/meetings/${id}/notes?only=notes`, "POST")).status).toBe(400); // no English transcript yet
  expect((await api(`/api/meetings/${id}/notes?only=junk`, "POST")).status).toBe(400);

  const bad = await api(`/api/meetings/${id}`, "PATCH", { notes: { title: "" } });
  expect(bad.status).toBe(400);
  expect((await api(`/api/meetings/${id}`, "PATCH", { notes: "x" })).status).toBe(400);

  const ok = await api(`/api/meetings/${id}`, "PATCH", { notes: v1() });
  expect(ok.status).toBe(200);
  const saved = await ok.json();
  expect(saved.notes.keyPoints[0]).toEqual({ text: "Build on Friday" });
  expect(saved.notes.sections).toEqual([]);
  expect(saved.title).toBe("T");

  // the stored v2 notes survive a second PATCH of themselves
  const again = await (await api(`/api/meetings/${id}`, "PATCH", { notes: saved.notes })).json();
  expect(again.notes).toEqual(saved.notes);

  // with notes but no English transcript, flow still answers 400 (and never reaches the model)
  expect((await api(`/api/meetings/${id}/flow`, "POST")).status).toBe(400);
  expect((await api("/api/meetings/zzzzzz/flow", "POST")).status).toBe(404);
});
