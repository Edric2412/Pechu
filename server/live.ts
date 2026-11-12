// Live captions. The browser sends 16 kHz PCM here and gets {ready, interim, final, notice, error, closed} messages back,
// whichever service does the listening. Sarvam is used when SARVAM_API_KEY is set (better for Tamil mixed with English);
// if it cannot connect or fails during the call, the same session moves to Gemini's live transcription so captions continue.
import type { ServerWebSocket } from "bun";
import { getKey, maskKey } from "./env";
import { SARVAM_NAME, sarvamEnabled, sarvamKey } from "./sarvam";

// The *_LIVE_URL variables exist only so tests can point the proxy at a local stand-in.
const GEMINI_URL =
  process.env.GEMINI_LIVE_URL ??
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const SARVAM_URL = process.env.SARVAM_LIVE_URL ?? "wss://api.sarvam.ai/speech-to-text-realtime/ws";

type Provider = "sarvam" | "gemini";
const NAME: Record<Provider, string> = { sarvam: SARVAM_NAME, gemini: "Gemini 3.5 Transcribe Live" };

type Upstream = { send(pcm: Uint8Array): void; end(): void; close(): void };
// What an upstream tells the proxy. fail = could not start or broke down; closed = ended normally.
type Events = { ready(): void; interim(text: string): void; final(text: string): void; fail(reason: string): void; closed(): void };

export type LiveData = {
  mode: "SMART" | "VERBATIM";
  langs: string[];
  up?: Upstream;
  session: number; // bumps on every (re)start so events from an abandoned upstream are ignored
  ready: boolean;
  ending: boolean;
  closed: boolean;
  queue: Uint8Array[]; // audio that arrived before the upstream was ready
  queueBytes: number;
};

type Ws = ServerWebSocket<LiveData>;
const MAX_QUEUE = 600; // about 60 s of audio
const MAX_QUEUE_BYTES = 2 * 1024 * 1024; // the real bound: a frame can be any size, so count alone is not enough

const tell = (ws: Ws, msg: object) => {
  if (!ws.data.closed) ws.send(JSON.stringify(msg));
};

const asText = (data: unknown) => (typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));

// ---------- Gemini ----------

function connectGemini(d: LiveData, ev: Events): Upstream {
  const up = new WebSocket(`${GEMINI_URL}?key=${getKey()}`);
  up.binaryType = "arraybuffer";
  let ready = false;
  const giveUp = setTimeout(() => {
    if (!ready) { ev.fail("Timed out connecting to Google's live transcription."); up.close(); }
  }, 15000);

  up.onopen = () =>
    up.send(
      JSON.stringify({
        setup: {
          model: "models/gemini-3.5-transcribe-live",
          generationConfig: { responseModalities: ["TEXT"] },
          inputAudioTranscription: { languageCodes: d.langs, mode: d.mode },
        },
      }),
    );

  up.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(asText(e.data)); } catch { return; } // Google may send JSON as a text or a binary frame
    if (m.setupComplete !== undefined && !ready) { ready = true; clearTimeout(giveUp); ev.ready(); }
    const sc = m.serverContent;
    if (sc?.interimInputTranscription?.text) ev.interim(sc.interimInputTranscription.text);
    if (sc?.inputTranscription?.text) ev.final(sc.inputTranscription.text);
    if (m.error) ev.fail(String(m.error.message ?? "Live transcription failed."));
  };
  up.onerror = () => ev.fail("Could not reach Google's live transcription.");
  up.onclose = (e) => {
    clearTimeout(giveUp);
    if (e.code === 1000 || e.code === 1005) return ev.closed(); // 1000 = normal end, 1005 = no code given
    const key = getKey();
    ev.fail((e.reason || `connection ended (code ${e.code})`).split(key || "\0").join(maskKey(key)).slice(0, 300));
  };

  return {
    send: (pcm) => up.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm).toString("base64"), mimeType: "audio/pcm;rate=16000" } } })),
    end: () => up.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })),
    close: () => { clearTimeout(giveUp); try { up.close(); } catch { /* already closed */ } },
  };
}

// ---------- Sarvam ----------

function connectSarvam(d: LiveData, ev: Events): Upstream {
  const params = new URLSearchParams({
    language_code: d.langs[0] ?? "auto", // auto = detect, which handles Tamil with English mixed in
    model: "saaras:v4",
    stream_type: "balanced", // partials a little slower but more accurate: right for captions
    mode: d.mode === "VERBATIM" ? "verbatim" : "codemix", // applies to each finished sentence
    encoding: "linear16",
    sample_rate: "16000",
  });
  const up = new WebSocket(`${SARVAM_URL}?${params}`, { headers: { "api-subscription-key": sarvamKey() } } as any);
  let ready = false;
  const giveUp = setTimeout(() => {
    if (!ready) { ev.fail("Timed out connecting to Sarvam's live transcription."); up.close(); }
  }, 15000);

  up.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(asText(e.data)); } catch { return; }
    switch (m.event) {
      case "session.begin": ready = true; clearTimeout(giveUp); ev.ready(); break;
      case "transcript.partial": if (m.text) ev.interim(m.text); break;
      case "transcript.final": if (m.text) ev.final(m.text); break;
      case "error": if (m.is_fatal) ev.fail(String(m.message ?? "Sarvam live transcription failed.")); break;
    }
  };
  up.onerror = () => ev.fail("Could not reach Sarvam's live transcription.");
  up.onclose = (e) => {
    clearTimeout(giveUp);
    if (e.code === 1000 || e.code === 1005) return ev.closed();
    const why = e.code === 1003 ? "the key was refused or the quota is used up" : e.code === 4000 ? "a setting was refused" : `code ${e.code}`;
    ev.fail(`Sarvam live transcription ended (${why}).`);
  };

  return {
    send: (pcm) => up.readyState === 1 && up.send(JSON.stringify({ event: "audio_input", audio: Buffer.from(pcm).toString("base64") })),
    end: () => up.readyState === 1 && up.send(JSON.stringify({ event: "end" })),
    close: () => { clearTimeout(giveUp); try { up.close(); } catch { /* already closed */ } },
  };
}

// ---------- the session ----------

function start(ws: Ws, provider: Provider) {
  const d = ws.data;
  const id = ++d.session;
  d.ready = false;
  const current = () => d.session === id && !d.closed; // false once this upstream was abandoned or the browser left
  const ev: Events = {
    ready() {
      if (!current()) return;
      d.ready = true;
      tell(ws, { type: "ready", provider: NAME[provider] });
      for (const pcm of d.queue.splice(0)) d.up!.send(pcm);
      d.queueBytes = 0;
      if (d.ending) d.up!.end();
    },
    interim: (t) => current() && tell(ws, { type: "interim", text: t }),
    final: (t) => current() && tell(ws, { type: "final", text: t }),
    fail(reason) {
      if (!current()) return;
      d.session++; // ignore anything else this upstream says
      d.up?.close();
      d.up = undefined;
      d.ready = false;
      if (provider === "sarvam" && getKey() && !d.ending) {
        console.error(`[live] Sarvam failed (${reason}); switching to Gemini`);
        tell(ws, { type: "notice", message: `${reason} Gemini live captions are taking over; the recording is not affected.` });
        start(ws, "gemini");
        return;
      }
      tell(ws, { type: "error", message: reason });
      tell(ws, { type: "closed" });
      ws.close();
    },
    closed() {
      if (!current()) return;
      tell(ws, { type: "closed" });
      ws.close();
    },
  };
  d.up = provider === "sarvam" ? connectSarvam(d, ev) : connectGemini(d, ev);
}

export function onOpen(ws: Ws) {
  start(ws, sarvamEnabled() ? "sarvam" : "gemini");
}

export function onMessage(ws: Ws, msg: string | Buffer) {
  const d = ws.data;
  if (typeof msg === "string") {
    if (msg !== "end") return;
    d.ending = true;
    if (d.ready && d.up) d.up.end();
    return;
  }
  if (d.ready && d.up) d.up.send(new Uint8Array(msg));
  else {
    d.queue.push(new Uint8Array(msg)); d.queueBytes += msg.byteLength;
    while (d.queue.length > MAX_QUEUE || d.queueBytes > MAX_QUEUE_BYTES) d.queueBytes -= d.queue.shift()!.byteLength;
  }
}

export function onClose(ws: Ws) {
  ws.data.closed = true;
  ws.data.up?.close();
}
