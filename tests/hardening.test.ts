import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GST_ENV_RANK } from "../server/audio";
import { onMessage, type LiveData } from "../server/live";
import { audioPath, createMeeting } from "../server/store";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "pechu-hard-")); process.env.PECHU_DATA_DIR = join(dir, "meetings"); });
afterAll(() => { delete process.env.PECHU_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });

test("live captions: audio waiting for the upstream is bounded by bytes, not only by count", () => {
  const data: LiveData = { mode: "SMART", langs: [], session: 0, ready: false, ending: false, closed: false, queue: [], queueBytes: 0 };
  const ws = { data } as any;
  for (let i = 0; i < 40; i++) onMessage(ws, Buffer.alloc(512 * 1024)); // 20 MiB offered
  expect(data.queueBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(data.queue.reduce((n, b) => n + b.byteLength, 0)).toBe(data.queueBytes);
  expect(data.queue.length).toBeLessThan(600);
});

test("a link in place of the audio file is never served", () => {
  const m = createMeeting({ source: "upload", status: "ready", transcript: "" });
  const mdir = join(process.env.PECHU_DATA_DIR!, m.id);
  mkdirSync(mdir, { recursive: true });
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "private");
  symlinkSync(secret, join(mdir, "audio.webm"));
  expect(audioPath({ ...m, audio: { file: "audio.webm", mime: "audio/webm" } })).toBeNull();
  rmSync(join(mdir, "audio.webm"));
  writeFileSync(join(mdir, "audio.webm"), "x");
  expect(audioPath({ ...m, audio: { file: "audio.webm", mime: "audio/webm" } })).toBe(join(mdir, "audio.webm"));
});

test("the audio decoder may not use network-capable plugins", () => {
  for (const name of ["hlsdemux", "hlsdemux2", "dashdemux", "dashdemux2", "souphttpsrc"]) expect(GST_ENV_RANK).toContain(`${name}:0`);
});

test("restore.sh refuses an archive that contains a link", () => {
  const src = join(dir, "src"); mkdirSync(join(src, "data"), { recursive: true });
  writeFileSync(join(src, "data", "a.txt"), "a");
  symlinkSync("/etc/hostname", join(src, "data", "audio.webm"));
  const archive = join(dir, "bad.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", archive, "-C", src, "data"]).exitCode).toBe(0);
  const run = Bun.spawnSync(["bash", join(import.meta.dir, "..", "scripts", "restore.sh"), archive, join(dir, "out-bad")], { stderr: "pipe" });
  expect(run.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(run.stderr)).toContain("links or special files");
  // a plain archive still restores
  rmSync(join(src, "data", "audio.webm"));
  const good = join(dir, "good.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", good, "-C", src, "data"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["bash", join(import.meta.dir, "..", "scripts", "restore.sh"), good, join(dir, "out-good")]).exitCode).toBe(0);
});
