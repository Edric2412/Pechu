import { afterAll, beforeEach, expect, test } from "bun:test";

// Pausing must stop everything that is billed. Sarvam charges for the audio it receives, silence included, so a pause
// that "keeps the connection open with silence" is paid for as if people were talking (a 1 h 45 min meeting was billed
// as 4 h 36 min). These tests run the real browser recorder (public/js/recorder.js) against a fake browser and a fake
// live-captions socket and look at what would have been sent.

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  audio: unknown[] = [];
  text: string[] = [];
  binaryType = "";
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: object) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "ready", provider: "Sarvam Saaras v4" }) }); });
  }
  send(d: unknown) {
    if (typeof d === "string") {
      this.text.push(d);
      if (d === "end") setTimeout(() => this.close(), 10); // the server ends the session after "end"
    } else this.audio.push(d);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.readyState = 3;
    queueMicrotask(() => this.onclose?.({}));
  }
}

class FakeNode { connect(n: unknown) { return n; } }
let worklet: { port: { onmessage?: (e: { data: ArrayBuffer }) => void } } | null = null;
class FakeWorkletNode extends FakeNode {
  port: { onmessage?: (e: { data: ArrayBuffer }) => void } = {};
  constructor() { super(); worklet = this; }
}
class FakeContext {
  audioWorklet = { addModule: async () => {} };
  destination = new FakeNode();
  async resume() {}
  createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }); }
  createMediaStreamSource() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createMediaStreamDestination() { return Object.assign(new FakeNode(), { stream: {} }); }
  close() {}
}
class FakeRecorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.onstop?.(); }
}

// The fake browser is installed for this file only and removed afterwards, so no other test file sees it.
const g = globalThis as any;
const FAKES = ["window", "location", "WebSocket", "AudioContext", "AudioWorkletNode", "MediaRecorder"];
const originals = new Map(FAKES.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
const originalDevices = Object.getOwnPropertyDescriptor(g.navigator, "mediaDevices");
g.window = { addEventListener() {} };
g.location = { protocol: "http:", host: "pechu.test" };
g.WebSocket = FakeSocket;
g.AudioContext = FakeContext;
g.AudioWorkletNode = FakeWorkletNode;
g.MediaRecorder = FakeRecorder;
Object.defineProperty(g.navigator, "mediaDevices", {
  configurable: true,
  value: { getUserMedia: async () => ({ getAudioTracks: () => [{ enabled: true, stop() {}, addEventListener() {} }] }) },
});
afterAll(() => {
  for (const [k, d] of originals) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
  if (originalDevices) Object.defineProperty(g.navigator, "mediaDevices", originalDevices); else delete g.navigator.mediaDevices;
});

const { rec, startRecording, pauseRecording, resumeRecording, stopRecording, finishSaving } = await import("../public/js/recorder.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Waits for something to happen (up to 2 s) instead of guessing how long it takes, so a slow machine cannot fail the test.
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await sleep(10);
  if (!done()) throw new Error("timed out waiting");
}
const chunk = () => new Int16Array(1600).buffer; // 100 ms of audio at 16 kHz, as the audio worklet sends it
const speak = (n: number) => { for (let i = 0; i < n; i++) worklet!.port.onmessage!({ data: chunk() }); };
const opts = { mode: "SMART", lang: "auto", mic: true, noise: true };

async function finish() {
  await stopRecording();
  finishSaving();
}

beforeEach(() => { FakeSocket.all.length = 0; worklet = null; });

test("while paused nothing is sent to the live captions, and the live session is ended", async () => {
  await startRecording(opts);
  try {
    expect(rec.phase).toBe("recording");
    const first = FakeSocket.all[0]!;
    speak(3);
    expect(first.audio.length).toBe(3);

    pauseRecording();
    speak(600); // a minute of muted-microphone silence, as the audio worklet keeps producing it
    await until(() => first.closed);

    expect(first.audio.length).toBe(3); // no silence was streamed (this is what was billed)
    expect(first.text).toContain("end"); // the last spoken turn is finished first
    expect(first.closed).toBe(true); // and the session is closed, so nothing stays open to be billed
    expect(FakeSocket.all.length).toBe(1); // and the recorder does not "recover" by reconnecting
    expect(rec.reconnecting).toBe(false);
  } finally { await finish(); }
});

test("resuming opens a new live session that carries only audio from after the pause", async () => {
  await startRecording(opts);
  try {
    speak(2);
    pauseRecording();
    speak(300); // paused silence: must be dropped
    await until(() => FakeSocket.all[0]!.closed);

    resumeRecording();
    speak(4); // spoken right after resuming, possibly before the new session is ready
    await until(() => FakeSocket.all.length === 2 && FakeSocket.all[1]!.audio.length === 4 && !rec.reconnecting);

    expect(FakeSocket.all[1]!.audio.length).toBe(4);
    expect(rec.paused).toBe(false);
    expect(rec.reconnecting).toBe(false);
    speak(2);
    expect(FakeSocket.all[1]!.audio.length).toBe(6); // and audio keeps flowing to it
  } finally { await finish(); }
});

test("stopping while paused saves the recording and does not open another live session", async () => {
  await startRecording(opts);
  speak(2);
  pauseRecording();
  speak(100);
  await until(() => FakeSocket.all[0]!.closed);
  const saved = await stopRecording();
  finishSaving();
  expect(saved).not.toBeNull();
  expect(saved!.blob).toBeInstanceOf(Blob);
  expect(FakeSocket.all.length).toBe(1);
  expect(FakeSocket.all[0]!.audio.length).toBe(2);
});
