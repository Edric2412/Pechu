import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  audioExt,
  audioPath,
  createMeeting,
  deleteMeeting,
  failInterrupted,
  getMeeting,
  ID_RE,
  listMeetings,
  saveAudio,
  updateMeeting,
} from "../server/store";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pechu-store-"));
  process.env.PECHU_DATA_DIR = dir;
});
afterAll(() => {
  delete process.env.PECHU_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("create, get, patch, list, delete", () => {
  const m = createMeeting({ source: "live", status: "ready", transcript: "hello", title: "First" });
  expect(m.id).toMatch(ID_RE);
  expect(getMeeting(m.id)?.transcript).toBe("hello");

  const patched = updateMeeting(m.id, { title: "Renamed", transcript: "hello world" });
  expect(patched?.title).toBe("Renamed");
  expect(getMeeting(m.id)?.transcript).toBe("hello world");
  expect(getMeeting(m.id)?.id).toBe(m.id);

  const list = listMeetings();
  expect(list.map((x) => x.id)).toContain(m.id);
  expect(list.find((x) => x.id === m.id)?.hasNotes).toBe(false);

  expect(deleteMeeting(m.id)).toBe(true);
  expect(getMeeting(m.id)).toBeNull();
  expect(existsSync(join(dir, m.id))).toBe(false);
  expect(deleteMeeting(m.id)).toBe(false);
  expect(updateMeeting(m.id, { title: "x" })).toBeNull();
});

test("ids that could escape the data folder are rejected", () => {
  for (const bad of ["../x", "..", "a/b", "ab", "UPPER12", "x".repeat(37), "", "a b c d"]) {
    expect(ID_RE.test(bad)).toBe(false);
    expect(getMeeting(bad)).toBeNull();
    expect(deleteMeeting(bad)).toBe(false);
    expect(updateMeeting(bad, { title: "x" })).toBeNull();
  }
});

test("newest first in the list", async () => {
  const a = createMeeting({ source: "live", status: "ready", transcript: "", createdAt: "2026-01-01T00:00:00.000Z" });
  const b = createMeeting({ source: "live", status: "ready", transcript: "", createdAt: "2026-02-01T00:00:00.000Z" });
  const ids = listMeetings().map((x) => x.id);
  expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
});

test("audio is saved next to the meeting and a different format replaces the old file", async () => {
  const m = createMeeting({ source: "live", status: "ready", transcript: "" });
  await saveAudio(m.id, new Uint8Array([1, 2, 3, 4]).buffer, "webm");
  const p = audioPath(getMeeting(m.id)!)!;
  expect(p.endsWith("audio.webm")).toBe(true);
  expect(await Bun.file(p).bytes()).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(getMeeting(m.id)?.audio).toEqual({ file: "audio.webm", mime: "audio/webm" });
  await saveAudio(m.id, new Uint8Array([9]).buffer, "wav");
  expect(existsSync(p)).toBe(false);
  expect(getMeeting(m.id)?.audio?.file).toBe("audio.wav");
});

test("audioExt maps content types and refuses non-audio", () => {
  expect(audioExt("audio/webm;codecs=opus")).toBe("webm");
  expect(audioExt("audio/mpeg")).toBe("mp3");
  expect(audioExt("audio/x-m4a")).toBe("m4a");
  expect(audioExt("application/octet-stream", "talk.MP3")).toBe("mp3");
  expect(audioExt("", "notes.txt")).toBeNull();
  expect(audioExt("text/plain", "a.mp3")).toBeNull();
  expect(audioExt("application/pdf")).toBeNull();
});

test("audioExt accepts AAC and other formats however the browser labels them", () => {
  // Chrome on Linux labels .aac files with odd types, and some files carry no type at all
  expect(audioExt("audio/x-hx-aac-adts", "call.aac")).toBe("aac");
  expect(audioExt("audio/aacp", "call.aac")).toBe("aac");
  expect(audioExt("audio/x-aac", "call.aac")).toBe("aac");
  expect(audioExt("audio/aac", "call.aac")).toBe("aac");
  expect(audioExt("", "call.AAC")).toBe("aac");
  // an unknown audio/* type falls back to the file extension
  expect(audioExt("audio/x-something", "voice.opus")).toBe("ogg");
  expect(audioExt("audio/x-something", "voice.oga")).toBe("ogg");
  // but an unknown audio type with an unknown extension is still refused
  expect(audioExt("audio/x-something", "voice.xyz")).toBeNull();
});

test("unfinished jobs are marked as errors on start", () => {
  const a = createMeeting({ source: "upload", status: "transcribing", transcript: "" });
  const b = createMeeting({ source: "live", status: "writing-notes", transcript: "x" });
  const c = createMeeting({ source: "live", status: "ready", transcript: "x" });
  expect(failInterrupted()).toBe(2);
  expect(getMeeting(a.id)).toMatchObject({ status: "error", error: "Stopped before it finished. Try again." });
  expect(getMeeting(b.id)?.status).toBe("error");
  expect(getMeeting(c.id)?.status).toBe("ready");
});
