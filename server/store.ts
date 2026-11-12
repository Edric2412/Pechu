import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Remote } from "./remote";

export type FlowNode = {
  label: string;
  kind: "root" | "topic" | "point" | "decision" | "action";
  at?: number; // seconds into the recording
  children?: FlowNode[];
};

export type Item = { text: string; at?: number };

export type ProcStep = {
  id: string;
  label: string;
  kind: "start" | "step" | "decision" | "end";
  who?: string;
  at?: number;
  next: { to: string; label?: string }[];
};

export type Process = { steps: ProcStep[] };

// Notes v2. Notes stored before it have keyPoints/decisions as string[] and no sections/process;
// the server never reads inside stored notes except to validate them, and validateNotes accepts both shapes.
export type Notes = {
  title: string;
  summary: string;
  sections: { heading: string; bullets: Item[] }[];
  keyPoints: Item[];
  decisions: (Item & { who?: string })[];
  actions: { task: string; owner?: string; due?: string; at?: number }[];
  flow: FlowNode;
  process?: Process;
};

export type Meeting = {
  id: string;
  title: string;
  source: "live" | "upload";
  createdAt: string;
  durationSec: number | null;
  status: "ready" | "transcribing" | "writing-notes" | "error";
  error?: string;
  progress?: string; // short note while a job runs, e.g. "Part 2 of 3"
  transcriber?: string; // which service wrote the transcript, e.g. "Sarvam Saaras v4"
  transcriptLive?: string; // the live captions, kept when a recording is re-transcribed afterwards
  refineError?: string; // why the second pass after a live call did not happen, if it did not
  transcript: string;
  transcriptEnglish?: string;
  notes?: Notes;
  audio?: { file: string; mime: string };
};

export const ID_RE = /^[a-z0-9-]{4,36}$/;

// Read at call time so tests can point it at a temp folder.
const root = () => process.env.PECHU_DATA_DIR ?? join(import.meta.dir, "..", "data", "meetings");

function dirOf(id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid meeting id");
  return join(root(), id);
}

// ----- optional durable copy (Cloudflare R2): the local folder is the working copy, the bucket is what survives -----
let remote: Remote | null = null;
const pending = new Set<Promise<unknown>>();
const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const track = (p: Promise<unknown>) => {
  const q: Promise<unknown> = p.catch((e) => console.error("[remote]", e instanceof Error ? e.message : e)).finally(() => pending.delete(q));
  pending.add(q);
};
export function setRemote(r: Remote | null): void { remote = r; }

function pushMeeting(id: string): void {
  if (!remote) return;
  let text: string;
  try { text = readFileSync(join(dirOf(id), "meeting.json"), "utf8"); } catch { return; }
  track(remote.put(`meetings/${id}/meeting.json`, text));
}
// Writes within one second are sent as one (job progress rewrites the file often).
function syncMeeting(id: string): void {
  if (!remote || syncTimers.has(id)) return;
  syncTimers.set(id, setTimeout(() => { syncTimers.delete(id); pushMeeting(id); }, 1000));
}
// Send everything still waiting. Called on shutdown.
export async function flushRemote(): Promise<void> {
  for (const [id, t] of [...syncTimers]) { clearTimeout(t); syncTimers.delete(id); pushMeeting(id); }
  while (pending.size) await Promise.all([...pending]);
}
// On a fresh start the local folder is empty: bring the meeting records back from the bucket (audio comes on demand).
export async function hydrate(): Promise<number> {
  if (!remote) return 0;
  let n = 0;
  for (const key of await remote.list("meetings/")) {
    const m = /^meetings\/([a-z0-9-]{4,36})\/meeting\.json$/.exec(key);
    if (!m) continue;
    const id = m[1]!;
    if (existsSync(join(dirOf(id), "meeting.json"))) continue;
    const data = await remote.get(key);
    if (!data) continue;
    try { JSON.parse(new TextDecoder().decode(data)); } catch { continue; }
    mkdirSync(dirOf(id), { recursive: true });
    writeFileSync(join(dirOf(id), "meeting.json"), data);
    n++;
  }
  return n;
}

function writeMeeting(m: Meeting, durable = true): void {
  const dir = dirOf(m.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "meeting.json.tmp");
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, join(dir, "meeting.json"));
  if (durable) syncMeeting(m.id);
}

export function createMeeting(init: Partial<Meeting> & Pick<Meeting, "source" | "status" | "transcript">): Meeting {
  const m: Meeting = {
    id: crypto.randomUUID().slice(0, 8),
    title: "Untitled meeting",
    createdAt: new Date().toISOString(),
    durationSec: null,
    ...init,
  };
  writeMeeting(m);
  return m;
}

export function getMeeting(id: string): Meeting | null {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(dirOf(id), "meeting.json"), "utf8"));
  } catch {
    return null;
  }
}

// Synchronous on purpose: a read-modify-write cannot interleave with another one.
export function updateMeeting(id: string, patch: Partial<Meeting>): Meeting | null {
  const m = getMeeting(id);
  if (!m) return null;
  const next = { ...m, ...patch, id: m.id };
  // a progress tick alone is not worth sending to the bucket; the next real change carries it
  writeMeeting(next, !Object.keys(patch).every((k) => k === "progress"));
  return next;
}

export function deleteMeeting(id: string): boolean {
  if (!getMeeting(id)) return false;
  rmSync(dirOf(id), { recursive: true, force: true });
  if (remote) {
    const r = remote;
    const t = syncTimers.get(id);
    if (t) { clearTimeout(t); syncTimers.delete(id); }
    track((async () => { for (const k of await r.list(`meetings/${id}/`)) await r.delete(k); })());
  }
  return true;
}

export function listMeetings() {
  let ids: string[] = [];
  try {
    ids = readdirSync(root());
  } catch {
    return [];
  }
  return ids
    .map(getMeeting)
    .filter((m): m is Meeting => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((m) => ({
      id: m.id,
      title: m.title,
      source: m.source,
      createdAt: m.createdAt,
      durationSec: m.durationSec,
      status: m.status,
      hasNotes: !!m.notes,
    }));
}

// A restart kills background jobs, so anything still marked as running is dead.
export function failInterrupted(): number {
  let n = 0;
  for (const s of listMeetings()) {
    if (s.status === "transcribing" || s.status === "writing-notes") {
      updateMeeting(s.id, { status: "error", error: "Stopped before it finished. Try again." });
      n++;
    }
  }
  return n;
}

// --- audio ---

const MIME_TO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mp4": "mp4",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/x-aac": "aac",
  "audio/aacp": "aac",
  "audio/x-hx-aac-adts": "aac",
  "audio/vnd.dlna.adts": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
};

const EXT_TO_MIME: Record<string, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  aiff: "audio/aiff",
};

// Extensions that are stored under another name (Ogg containers, AIFF spelling).
const EXT_ALIAS: Record<string, string> = { oga: "ogg", opus: "ogg", aif: "aiff", mpga: "mp3" };

// Extension for a Content-Type (parameters like ;codecs=opus ignored). Browsers label some files oddly
// (AAC is often "audio/x-hx-aac-adts") or not at all, so for an empty, generic or unrecognised audio type
// we trust the file name's extension instead.
export function audioExt(contentType: string, fileName = ""): string | null {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (MIME_TO_EXT[type]) return MIME_TO_EXT[type]!;
  if (type === "" || type === "application/octet-stream" || type.startsWith("audio/")) {
    const raw = fileName.split(".").pop()?.toLowerCase() ?? "";
    const ext = EXT_ALIAS[raw] ?? raw;
    if (EXT_TO_MIME[ext]) return ext;
  }
  return null;
}

export async function saveAudio(id: string, data: Blob | ArrayBuffer, ext: string): Promise<Meeting | null> {
  if (!getMeeting(id) || !EXT_TO_MIME[ext]) return null;
  const dir = dirOf(id);
  for (const f of readdirSync(dir)) if (f.startsWith("audio.")) rmSync(join(dir, f));
  const file = `audio.${ext}`;
  await Bun.write(join(dir, file), data);
  if (remote) {
    await remote.put(`meetings/${id}/${file}`, data); // the recording must be safe before we say it is saved
    for (const k of await remote.list(`meetings/${id}/audio.`)) if (k !== `meetings/${id}/${file}`) await remote.delete(k);
  }
  return updateMeeting(id, { audio: { file, mime: EXT_TO_MIME[ext]! } });
}

export function audioPath(m: Meeting): string | null {
  if (!m.audio || !/^audio\.[a-z0-9]+$/.test(m.audio.file)) return null;
  const path = join(dirOf(m.id), m.audio.file);
  try {
    if (!lstatSync(path).isFile()) return null; // a link or special file (for example from a tampered restore) is never served
  } catch {
    return null;
  }
  return path;
}

// The audio file on local disk, fetched from the bucket first when this container does not have it yet.
export async function ensureAudio(m: Meeting): Promise<string | null> {
  const local = audioPath(m);
  if (local) return local;
  if (!remote || !m.audio || !/^audio\.[a-z0-9]+$/.test(m.audio.file)) return null;
  const data = await remote.get(`meetings/${m.id}/${m.audio.file}`);
  if (!data) return null;
  mkdirSync(dirOf(m.id), { recursive: true });
  await Bun.write(join(dirOf(m.id), m.audio.file), data);
  return audioPath(m);
}
