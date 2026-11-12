import { accessSync, constants, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadEnvFile, getKey, normalizeKey, saveKey } from "./env";
import { isLoopback, loadConfig, validateConfig } from "./config";
import { log } from "./log";
import { purgeOld } from "./retention";
import { remoteFromEnv } from "./remote";
import { RateLimiter, accessEmail, clearCookie, clientIp, cookieOf, hostAllowed, hostOf, isSecure, makeSession, passwordOk, revokeSession, sessionCookie, sessionOk, withSecurityHeaders } from "./security";
import { checkKey, discoverNotesModel, getNotesModel, validateNotes, type TranscribeMode } from "./gemini";
import { activeJobs, retranscribe, startFlow, startNotes, startNotesOnly, startUpload } from "./jobs";
import { sarvamEnabled } from "./sarvam";
import * as live from "./live";
import {
  audioExt,
  ensureAudio,
  flushRemote,
  hydrate,
  setRemote,
  createMeeting,
  deleteMeeting,
  failInterrupted,
  getMeeting,
  listMeetings,
  saveAudio,
  updateMeeting,
  type Meeting,
} from "./store";

const PUBLIC = resolve(import.meta.dir, "..", "public");
const MAX_BYTES = 100 * 1000 * 1000; // 100 MB: the most Cloudflare lets through to the app on the free plan
const MAX_TRANSCRIPT_CHARS = 2_000_000; // far more than any meeting; keeps one job from costing thousands of model calls
const NO_STORE = { "Cache-Control": "no-store" };

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: NO_STORE });
const fail = (status: number, message: string) => json({ error: message }, status);

async function readJson(req: Request): Promise<Record<string, any>> {
  // JSON only: a plain-text or form body would let another site send this request without a browser preflight
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "Send a JSON object.");
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Send a JSON object.");
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function serveStatic(pathname: string): Response {
  let rel = "/";
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    // keep "/" and serve the index
  }
  const target = resolve(PUBLIC, "." + rel);
  const file = target.startsWith(PUBLIC + sep) && isFile(target) ? target : join(PUBLIC, "index.html");
  if (!isFile(file)) return new Response("Frontend not found (public/index.html is missing).", { status: 404, headers: NO_STORE });
  return new Response(Bun.file(file), { headers: NO_STORE });
}

function serveAudio(req: Request, path: string, mime: string): Response {
  const file = Bun.file(path);
  const size = file.size;
  const headers = { ...NO_STORE, "Content-Type": mime, "Accept-Ranges": "bytes" };
  const range = req.headers.get("range");
  if (!range) return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = 0;
  let end = size - 1;
  if (m && m[1] !== "") {
    start = Number(m[1]);
    if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
  } else if (m && m[2] !== "") {
    start = Math.max(0, size - Number(m[2])); // "bytes=-N" means the last N bytes
  } else {
    start = size; // malformed: fall into the 416 below
  }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
}

const needKey = () => {
  if (!getKey()) throw new HttpError(401, "Add your Gemini API key first.");
};

function needMeeting(id: string): Meeting {
  const m = getMeeting(id);
  if (!m) throw new HttpError(404, "Meeting not found.");
  return m;
}

async function postKey(req: Request) {
  const body = await readJson(req);
  const key = typeof body.key === "string" ? normalizeKey(body.key) : "";
  const rejected = fail(400, "That key was not accepted by Google.");
  if (!/^[\x21-\x7e]{1,300}$/.test(key)) return rejected;
  let verdict: "valid" | "invalid";
  try {
    verdict = await checkKey(key);
  } catch {
    return fail(502, "Could not check the key with Google right now. Check your internet connection and try again.");
  }
  if (verdict === "invalid") return rejected;
  saveKey(key);
  await discoverNotesModel();
  return json({ ok: true, notesModel: await getNotesModel() });
}

async function postUpload(req: Request) {
  needKey();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "Send a multipart form with an audio file in the field named file.");
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "No audio file was received.");
  if (file.size > MAX_BYTES) throw new HttpError(413, "That file is larger than 100 MB.");
  const ext = audioExt(file.type, file.name);
  if (!ext) throw new HttpError(415, "That does not look like an audio file.");
  const titleField = form.get("title");
  const title =
    (typeof titleField === "string" && titleField.trim()) || file.name.replace(/\.[^.]*$/, "").trim() || "Untitled meeting";
  // speakers = as-spoken text with a "Speaker N:" label on every turn
  const mode: TranscribeMode = form.get("speakers") === "1" ? "speakers" : form.get("mode") === "verbatim" ? "verbatim" : "smart";

  const m = createMeeting({ source: "upload", status: "transcribing", transcript: "", title: title.slice(0, 200) });
  try {
    await saveAudio(m.id, file, ext);
  } catch {
    deleteMeeting(m.id);
    throw new HttpError(500, "Could not save the audio file.");
  }
  startUpload(m.id, mode);
  return json(getMeeting(m.id));
}

async function putAudio(req: Request, id: string) {
  needMeeting(id);
  const ext = audioExt(req.headers.get("content-type") ?? "");
  if (!ext) throw new HttpError(415, "Send audio with an audio Content-Type, for example audio/webm.");
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, "The audio was empty.");
  if (bytes.byteLength > MAX_BYTES) throw new HttpError(413, "That recording is larger than 100 MB.");
  if (!(await saveAudio(id, bytes, ext))) throw new HttpError(404, "Meeting not found.");
  return json({ ok: true });
}

async function api(req: Request, url: URL, server: Bun.Server<live.LiveData>): Promise<Response | undefined> {
  const { pathname } = url;
  const method = req.method;
  const parts = pathname.split("/").slice(2); // after "/api"

  if (pathname === "/api/status" && method === "GET") {
    return json({ hasKey: !!getKey(), notesModel: getKey() ? await getNotesModel() : null, transcriber: sarvamEnabled() ? "sarvam" : "gemini" });
  }
  if (pathname === "/api/key" && method === "POST") return postKey(req);

  if (pathname === "/api/live" && method === "GET") {
    if (!getKey() && !sarvamEnabled()) needKey(); // live captions work with either key
    const lang = url.searchParams.get("lang") || "auto";
    if (lang !== "auto" && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(lang)) throw new HttpError(400, "Unknown language code.");
    const data: live.LiveData = {
      mode: url.searchParams.get("mode")?.toUpperCase() === "VERBATIM" ? "VERBATIM" : "SMART",
      langs: lang === "auto" ? [] : [lang],
      session: 0,
      ready: false,
      ending: false,
      closed: false,
      queue: [],
      queueBytes: 0,
    };
    if (server.upgrade(req, { data })) return undefined;
    throw new HttpError(400, "Expected a WebSocket connection.");
  }

  if (pathname === "/api/uploads" && method === "POST") return postUpload(req);

  if (parts[0] === "meetings" && parts.length === 1) {
    if (method === "GET") return json(listMeetings());
    if (method === "POST") {
      const b = await readJson(req);
      if (b.source !== undefined && b.source !== "live") throw new HttpError(400, 'source must be "live".');
      if (typeof b.transcript !== "string") throw new HttpError(400, "transcript must be text.");
      if (b.transcript.length > MAX_TRANSCRIPT_CHARS) throw new HttpError(413, "That transcript is too long.");
      if (b.title !== undefined && typeof b.title !== "string") throw new HttpError(400, "title must be text.");
      const d = b.durationSec;
      if (d != null && !(typeof d === "number" && Number.isFinite(d) && d >= 0)) throw new HttpError(400, "durationSec must be a number.");
      return json(
        createMeeting({
          source: "live",
          status: "ready",
          transcript: b.transcript,
          title: (b.title?.trim() || "Untitled meeting").slice(0, 200),
          durationSec: d ?? null,
          // which service wrote the live captions, shown as "Made with" until the second listen replaces it
          ...(typeof b.transcriber === "string" && b.transcriber.trim() ? { transcriber: `${b.transcriber.trim().slice(0, 60)} (live)` } : {}),
        }),
      );
    }
  }

  if (parts[0] === "meetings" && parts.length >= 2) {
    const id = parts[1]!;
    const sub = parts[2];
    if (parts.length === 2) {
      if (method === "GET") return json(needMeeting(id));
      if (method === "DELETE") {
        if (!deleteMeeting(id)) throw new HttpError(404, "Meeting not found.");
        return json({ ok: true });
      }
      if (method === "PATCH") {
        needMeeting(id);
        const b = await readJson(req);
        const patch: Partial<Meeting> = {};
        if ("title" in b) {
          if (typeof b.title !== "string") throw new HttpError(400, "title must be text.");
          patch.title = b.title.trim().slice(0, 200) || "Untitled meeting";
        }
        if ("transcript" in b) {
          if (typeof b.transcript !== "string") throw new HttpError(400, "transcript must be text.");
          if (b.transcript.length > MAX_TRANSCRIPT_CHARS) throw new HttpError(413, "That transcript is too long.");
          patch.transcript = b.transcript;
        }
        if ("transcriptEnglish" in b) {
          if (typeof b.transcriptEnglish !== "string") throw new HttpError(400, "transcriptEnglish must be text.");
          if (b.transcriptEnglish.length > MAX_TRANSCRIPT_CHARS) throw new HttpError(413, "That transcript is too long.");
          patch.transcriptEnglish = b.transcriptEnglish;
        }
        if ("notes" in b) {
          try {
            patch.notes = validateNotes(b.notes); // old or new shape in, new shape stored
          } catch (e) {
            log("notes.invalid", { id, message: (e as Error).message }); // the detail is for the log, not the screen
            throw new HttpError(400, "Those notes could not be saved because they are not in the expected format. Reload the page and try again.");
          }
        }
        if (!Object.keys(patch).length) throw new HttpError(400, "Send title, transcript, transcriptEnglish and/or notes.");
        return json(updateMeeting(id, patch));
      }
    }
    if (parts.length === 3 && sub === "audio") {
      if (method === "PUT") return putAudio(req, id);
      if (method === "GET") {
        const m = needMeeting(id);
        const path = await ensureAudio(m);
        if (!path || !m.audio) throw new HttpError(404, "This meeting has no audio.");
        return serveAudio(req, path, m.audio.mime);
      }
    }
    if (parts.length === 3 && sub === "notes" && method === "POST") {
      const m = needMeeting(id);
      const only = url.searchParams.get("only");
      if (only !== null && only !== "notes") throw new HttpError(400, 'only must be "notes".');
      if (only && !m.transcriptEnglish?.trim()) throw new HttpError(400, "There is no English transcript yet. Write the full notes first.");
      needKey();
      return json(only ? startNotesOnly(id) : startNotes(id));
    }
    if (parts.length === 3 && sub === "flow" && method === "POST") {
      const m = needMeeting(id);
      if (!m.notes) throw new HttpError(400, "Write the notes first.");
      if (!m.transcriptEnglish?.trim()) throw new HttpError(400, "There is no English transcript yet. Write the full notes first.");
      needKey();
      return json(startFlow(id));
    }
    if (parts.length === 3 && sub === "transcribe" && method === "POST") {
      const m = needMeeting(id);
      needKey();
      if (!m.audio) throw new HttpError(400, "This meeting has no saved audio to transcribe.");
      const b = await readJson(req).catch(() => ({}));
      return json(retranscribe(id, b.speakers === true ? "speakers" : "smart"));
    }
  }

  throw new HttpError(404, "Not found.");
}

loadEnvFile();
const cfg = loadConfig();
const problems = validateConfig(cfg);
if (problems.length) {
  for (const p of problems) console.error(`[config] ${p}`);
  process.exit(1);
}
// Cloudflare: the container disk is temporary, so meetings are mirrored to R2 and restored here at start.
try {
  const r = remoteFromEnv();
  if (r) {
    setRemote(r);
    log("storage", { backend: "r2", restored: await hydrate() });
  }
} catch (e) {
  console.error(`[config] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const accessOn = !!(cfg.accessTeam && cfg.accessAud); // Cloudflare Access is the login
const authOn = !!cfg.password && !accessOn; // Pechu's own password login

// With Cloudflare Access: a request that came through the proxy must carry a valid Access pass. A request made directly
// on this computer (loopback host, no forwarded host) is the owner at the keyboard, as in local mode.
async function accessAllowed(req: Request): Promise<boolean> {
  const viaProxy = !!req.headers.get("x-forwarded-host") || !isLoopback(hostOf(req.headers.get("host") ?? ""));
  if (!viaProxy) return true;
  const token = req.headers.get("cf-access-jwt-assertion") || cookieOf(req, "CF_Authorization");
  return !!token && (await accessEmail(token, cfg)) !== null;
}
const apiLimit = new RateLimiter(600, 60_000); // calls per minute per address
const loginLimit = new RateLimiter(5, 60_000);
const uploadLimit = new RateLimiter(30, 3_600_000);
const liveLimit = new RateLimiter(20, 60_000);
let liveOpen = 0;
let stopping = false;
const started = Date.now();

// Reachable without logging in: the login check, health probes and the (public) page files.
const OPEN_API = new Set(["/api/auth", "/api/login", "/api/logout"]);

function dataDirWritable(): boolean {
  try {
    accessSync(process.env.PECHU_DATA_DIR ?? join(import.meta.dir, "..", "data", "meetings"), constants.W_OK);
    return true;
  } catch {
    // the directory is created on first save; its parent must then be writable
    try { accessSync(join(process.env.PECHU_DATA_DIR ?? join(import.meta.dir, "..", "data", "meetings"), ".."), constants.W_OK); return true; } catch { return false; }
  }
}

async function login(req: Request, ip: string, secure: boolean) {
  if (!authOn) return json({ ok: true });
  if (!loginLimit.take(ip)) { log("auth.throttled", { ip }); return fail(429, "Too many attempts. Wait a minute and try again."); }
  const b = await readJson(req);
  if (typeof b.password !== "string" || !passwordOk(b.password, cfg.password)) {
    log("auth.failed", { ip });
    await Bun.sleep(400); // slows guessing a little more
    return fail(401, "That password is not right.");
  }
  log("auth.ok", { ip });
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", sessionCookie(makeSession(cfg.sessionSecret, cfg.password), secure));
  return res;
}

const server = Bun.serve<live.LiveData>({
  port: cfg.port,
  hostname: cfg.host,
  maxRequestBodySize: MAX_BYTES + 5 * 1024 * 1024,
  async fetch(req, server) {
    const t0 = performance.now();
    const url = new URL(req.url);
    const secure = isSecure(req, cfg);
    const ip = clientIp(req, server.requestIP(req)?.address, cfg);
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    const done = (res: Response | undefined) => {
      if (!res) return res; // websocket upgrade
      const ms = Math.round(performance.now() - t0);
      if (isApi && (req.method !== "GET" || res.status >= 400)) log("req", { method: req.method, path: url.pathname.replace(/\/meetings\/[^/]+/, "/meetings/:id"), status: res.status, ms, ip });
      return withSecurityHeaders(res, secure);
    };

    if (url.pathname === "/healthz") return done(json({ ok: true, uptimeSec: Math.round((Date.now() - started) / 1000) }));
    if (url.pathname === "/readyz") return done(dataDirWritable() && !stopping ? json({ ok: true }) : fail(503, "Not ready."));

    if (!hostAllowed(req, cfg, isApi)) return done(isApi ? fail(403, "Not allowed.") : new Response("Not allowed.", { status: 403 }));
    if (!isApi) return done(req.method === "GET" || req.method === "HEAD" ? serveStatic(url.pathname) : new Response("Not found.", { status: 404 }));

    try {
      if (!apiLimit.take(ip)) return done(fail(429, "Too many requests. Slow down a little."));
      const authed = accessOn ? await accessAllowed(req) : !authOn || sessionOk(cookieOf(req), cfg.sessionSecret, cfg.password);
      if (url.pathname === "/api/auth" && req.method === "GET") return done(json({ authRequired: authOn, authed }));
      if (url.pathname === "/api/login" && req.method === "POST") return done(await login(req, ip, secure));
      if (url.pathname === "/api/logout" && req.method === "POST") {
        revokeSession(cookieOf(req));
        const res = json({ ok: true });
        res.headers.append("Set-Cookie", clearCookie(secure));
        return done(res);
      }
      if (!authed && !OPEN_API.has(url.pathname)) return done(fail(401, "Please sign in."));
      if (stopping) return done(fail(503, "The server is restarting. Try again in a moment."));
      // paid work: new audio and re-transcription share one hourly limit, and only so many jobs run at once
      const audioWork = (url.pathname === "/api/uploads" && req.method === "POST") || (/^\/api\/meetings\/[^/]+\/(audio|transcribe)$/.test(url.pathname) && (req.method === "PUT" || req.method === "POST"));
      const startsJob = req.method === "POST" && (url.pathname === "/api/uploads" || /^\/api\/meetings\/[^/]+\/(transcribe|notes|flow)$/.test(url.pathname));
      if (audioWork && !uploadLimit.take(ip)) return done(fail(429, "Upload limit reached for this hour."));
      if (startsJob && activeJobs() >= cfg.maxJobs) return done(fail(429, "Pechu is busy with other meetings. Try again in a few minutes."));
      if (url.pathname === "/api/live") {
        if (!liveLimit.take(ip)) return done(fail(429, "Too many live sessions started. Wait a minute."));
        if (liveOpen >= cfg.maxLive) return done(fail(503, "All live caption sessions are busy. Try again shortly."));
      }
      return done(await api(req, url, server));
    } catch (e) {
      if (e instanceof HttpError) return done(fail(e.status, e.message));
      log("error", { path: url.pathname, message: e instanceof Error ? e.message : String(e) });
      return done(fail(500, "Something went wrong on the server."));
    }
  },
  websocket: {
    open: (ws) => { liveOpen++; live.onOpen(ws); },
    message: live.onMessage,
    close: (ws) => { liveOpen = Math.max(0, liveOpen - 1); live.onClose(ws); },
    idleTimeout: 300,
    maxPayloadLength: 64 * 1024, // the browser sends ~3 KB audio chunks; larger frames are refused
  },
});

const interrupted = failInterrupted();
if (getKey()) void discoverNotesModel();
if (cfg.retentionDays) {
  purgeOld(cfg.retentionDays);
  setInterval(() => purgeOld(cfg.retentionDays), 6 * 3600 * 1000).unref();
}
log("start", {
  url: `http://${isLoopback(cfg.host) ? "localhost" : cfg.host}:${server.port}`,
  auth: accessOn ? "cloudflare-access" : authOn,
  retentionDays: cfg.retentionDays || null,
  geminiKey: getKey() ? "set" : "not set", // never log any part of a key
  interrupted,
});

// Finish what is running, then exit. A new deploy or restart should not cut a transcription in half.
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("shutdown", { signal, activeJobs: activeJobs() });
  void server.stop(); // no new connections
  const deadline = Date.now() + 25_000;
  while (activeJobs() > 0 && Date.now() < deadline) await Bun.sleep(500);
  await flushRemote(); // meetings and audio still waiting to be copied to the bucket
  log("stopped", { unfinishedJobs: activeJobs() });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
