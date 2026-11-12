// The Sarvam second pass is manual. These start the real server with a fake Sarvam key and Gemini key and no route to the
// internet (the proxy points at a closed port), so any call to either service fails at once, the same way every time.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wavBytes } from "../server/audio";

let proc: ReturnType<typeof Bun.spawn>;
let base = "";
let dir = "";
const JSON_HEADERS = { "content-type": "application/json" };
const NOTES = { title: "Kept notes", summary: "These notes must survive.", sections: [], keyPoints: [], decisions: [], actions: [], flow: { label: "Kept notes", kind: "root", children: [] } };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pechu-second-"));
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server", "index.ts")], {
    env: {
      PATH: process.env.PATH ?? "", PORT: String(port), HOST: "127.0.0.1", PECHU_DATA_DIR: join(dir, "meetings"), ENV_FILE: join(dir, ".env"),
      GEMINI_API_KEY: "fake-gemini", NOTES_MODEL: "test-model", SARVAM_API_KEY: "fake-sarvam",
      HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9",
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ } await Bun.sleep(100); }
  throw new Error("server did not start");
});
afterAll(async () => { proc.kill("SIGTERM"); await proc.exited; rmSync(dir, { recursive: true, force: true }); });

const get = async (id: string) => (await fetch(`${base}/api/meetings/${id}`)).json() as Promise<any>;
async function settled(id: string) { // wait until no job is running on the meeting
  for (let i = 0; i < 150; i++) {
    const m = await get(id);
    if (m.status !== "transcribing" && m.status !== "writing-notes") return m;
    await Bun.sleep(100);
  }
  throw new Error("the job did not finish");
}
const audio = () => wavBytes(new Int16Array(16000).fill(3000)); // one second of tone
async function liveMeeting(withNotes: boolean) {
  const m = (await (await fetch(`${base}/api/meetings`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ source: "live", title: "Live call", transcript: "[00:01] Hello from the live captions.", durationSec: 60 }) })).json()) as any;
  expect((await fetch(`${base}/api/meetings/${m.id}/audio`, { method: "PUT", headers: { "content-type": "audio/wav" }, body: audio() })).status).toBe(200);
  if (withNotes) expect((await fetch(`${base}/api/meetings/${m.id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ notes: NOTES }) })).status).toBe(200);
  return m.id as string;
}

test("saving a live recording does not start a Sarvam second pass", async () => {
  const id = await liveMeeting(false);
  expect((await fetch(`${base}/api/meetings/${id}/notes`, { method: "POST" })).status).toBe(200);
  const m = await settled(id);
  expect(m.refineError).toBeUndefined(); // the old automatic second pass would have tried Sarvam and failed here
  expect(m.transcriptLive).toBeUndefined();
  expect(m.transcript).toContain("Hello from the live captions.");
});

test("an improvement that fails keeps the transcript and the notes, and says why", async () => {
  const id = await liveMeeting(true);
  expect((await fetch(`${base}/api/meetings/${id}/transcribe`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ speakers: false }) })).status).toBe(200);
  const m = await settled(id);
  expect(m.status).toBe("ready");
  expect(m.transcript).toContain("Hello from the live captions.");
  expect(m.notes?.summary).toBe("These notes must survive.");
  expect(m.refineError).toContain("could not reach Sarvam");
  expect(m.transcriptLive).toBeUndefined();
});

test("a first transcription that fails still shows an error", async () => {
  const form = new FormData();
  form.append("file", new File([audio()], "talk.wav", { type: "audio/wav" }));
  const created = (await (await fetch(`${base}/api/uploads`, { method: "POST", body: form })).json()) as any;
  const m = await settled(created.id);
  expect(m.status).toBe("error");
  expect(m.error).toContain("could not reach Sarvam");
  expect(m.transcript).toBe("");
});
