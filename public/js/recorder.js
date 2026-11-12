// The recording session. It lives at module level so a recording keeps going while you
// move between pages. It mixes the microphone and (optionally) a shared browser tab's audio,
// streams 16 kHz PCM to the server's /api/live socket, and keeps a full-quality copy with MediaRecorder.
//
// Live sessions end after ~10 minutes on Google's side, so every ~8.5 minutes a second
// socket is opened and swapped in without dropping audio.

export const rec = {
  phase: 'idle', // idle | starting | recording | saving
  elapsed: 0,
  finals: [], // [{ t: seconds into the recording when the turn started, text }]
  interim: '',
  error: '',
  notice: '',
  reconnecting: false,
  paused: false,
  analyser: null,
  provider: '', // which service is writing the live captions, e.g. "Sarvam Saaras v4"
};
const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => f(rec));
// "[mm:ss]" or "[h:mm:ss]": the same stamp format the server writes (server/text.ts fmtStamp).
const stamp = (sec) => {
  const t = Math.max(0, Math.floor(sec)), h = Math.floor(t / 3600), p2 = (n) => String(n).padStart(2, '0');
  return h ? `[${h}:${p2(Math.floor((t % 3600) / 60))}:${p2(t % 60)}]` : `[${p2(Math.floor(t / 60))}:${p2(t % 60)}]`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROTATE_AFTER_MS = 8.5 * 60 * 1000;
let S = null; // the running session
// Seconds of recording so far, not counting time spent paused (this matches the audio file, which skips pauses too).
const clockSec = (s) => ((s.pauseAt ?? performance.now()) - s.t0 - s.pausedMs) / 1000;

function openLive(s) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/live?mode=${s.opts.mode}&lang=${encodeURIComponent(s.opts.lang)}`);
    ws.binaryType = 'arraybuffer';
    let ready = false;
    const timer = setTimeout(() => { if (!ready) { try { ws.close(); } catch { /* */ } reject(new Error('Live transcription did not start. Check your internet connection.')); } }, 12000);
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'ready') { ready = true; clearTimeout(timer); if (m.provider) { rec.provider = m.provider; emit(); } resolve(ws); }
      else if (m.type === 'notice') { rec.notice = m.message || 'Live captions changed service.'; emit(); }
      else if (m.type === 'interim') {
        if (ws === s.ws) {
          rec.interim = m.text || '';
          if (rec.interim && s.turnStart == null) s.turnStart = Math.floor(clockSec(s)); // a new turn begins
          emit();
        }
      }
      else if (m.type === 'final') addFinal(s, m.text, ws);
      else if (m.type === 'error') {
        if (!ready) { clearTimeout(timer); reject(new Error(m.message || 'Live transcription failed.')); }
        else { rec.notice = m.message || 'Live transcription reported a problem.'; emit(); }
      }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (!ready) reject(new Error('Live transcription could not connect.'));
      else onSocketClosed(s, ws);
    };
    ws.onerror = () => {};
  });
}

function addFinal(s, text, ws) {
  text = (text || '').trim();
  if (!text) return;
  // t is when the turn started: its first interim message, else (no interim seen) when the final arrived
  const arrived = Math.floor(clockSec(s));
  rec.finals.push({ t: ws === s.ws ? (s.turnStart ?? arrived) : arrived, text });
  if (ws === s.ws) { rec.interim = ''; s.turnStart = null; }
  if (s.ending) s.gotFinalAfterEnd = true;
  emit();
}

function sendChunk(s, buf) {
  if (s.ws && s.ws.readyState === 1 && !rec.reconnecting) { s.ws.send(buf); return; }
  s.pending.push(buf); // hold up to ~60 s while reconnecting
  if (s.pending.length > 600) s.pending.shift();
}

async function onSocketClosed(s, ws) {
  if (ws !== s.ws || s.ending) return; // a rotated-out socket closing is expected
  s.ws = null;
  rec.reconnecting = true; emit();
  for (let i = 0; i < 5 && !s.ending; i++) {
    await sleep(Math.min(1000 * 2 ** i, 8000));
    try {
      const next = await openLive(s);
      s.ws = next; s.startedAt = performance.now();
      rec.reconnecting = false;
      for (const b of s.pending.splice(0)) next.send(b);
      emit();
      return;
    } catch { /* try again */ }
  }
  if (!s.ending) {
    rec.reconnecting = false;
    rec.notice = 'Live text stopped. The audio is still being recorded, so you can stop now and keep the recording.';
    emit();
  }
}

async function rotate(s) {
  s.rotating = true;
  try {
    const next = await openLive(s);
    const old = s.ws;
    s.ws = next; s.startedAt = performance.now();
    for (const b of s.pending.splice(0)) next.send(b);
    if (old) { try { old.send('end'); } catch { /* */ } setTimeout(() => { try { old.close(); } catch { /* */ } }, 4000); }
  } catch { /* the old socket keeps going until it closes, then onSocketClosed reconnects */ }
  finally { s.rotating = false; }
}

function release(s) {
  clearInterval(s.timer); clearInterval(s.tick);
  s.tracks.forEach((t) => t.stop());
  try { s.ctx?.close(); } catch { /* */ }
  try { s.ws?.close(); s.old?.close(); } catch { /* */ }
  if (S === s) S = null;
  rec.analyser = null;
}

export async function startRecording(opts) {
  if (rec.phase !== 'idle') return;
  Object.assign(rec, { phase: 'starting', error: '', notice: '', finals: [], interim: '', elapsed: 0, reconnecting: false, paused: false, provider: '' });
  emit();
  const s = { pausedMs: 0, pauseAt: null, opts, tracks: [], pending: [], chunks: [], t0: 0, turnStart: null, ws: null, rotating: false, ending: false, startedAt: 0 };
  S = s;
  try {
    // getDisplayMedia needs a fresh click, so ask for the tab before the microphone.
    let shared = null;
    if (opts.tab) {
      const d = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      d.getVideoTracks().forEach((t) => t.stop());
      shared = d.getAudioTracks();
      if (!shared.length) {
        d.getTracks().forEach((t) => t.stop());
        throw new Error('No tab audio was shared. Choose the meeting tab and tick “Share tab audio”.');
      }
      s.tracks.push(...shared);
      shared[0].addEventListener('ended', () => {
        if (rec.phase === 'recording') { rec.notice = 'Sharing of the meeting audio stopped. Still recording the microphone.'; emit(); }
      });
    }
    let mic = null;
    if (opts.mic) {
      // the filters help in noisy rooms but can clip quiet words; the person can switch them off (opts.noise === false)
      const clean = opts.noise !== false;
      mic = await openInput(opts.micDevice, !!opts.micLoop, clean);
      s.tracks.push(...mic.getAudioTracks());
    }
    // the computer's own sound (for example "Monitor of ..." on Ubuntu, BlackHole on a Mac): what the other people say in a Zoom or Meet app
    let sys = null;
    if (opts.sysDevice) {
      sys = await openInput(opts.sysDevice, true, false);
      s.tracks.push(...sys.getAudioTracks());
    }

    s.ctx = new AudioContext();
    await s.ctx.resume();
    await s.ctx.audioWorklet.addModule('/js/pcm-worklet.js');
    s.mix = s.ctx.createGain();
    if (shared) s.ctx.createMediaStreamSource(new MediaStream(shared)).connect(s.mix);
    if (mic) s.ctx.createMediaStreamSource(mic).connect(s.mix);
    if (sys) s.ctx.createMediaStreamSource(sys).connect(s.mix);

    s.analyser = s.ctx.createAnalyser();
    s.analyser.fftSize = 1024;
    s.analyser.smoothingTimeConstant = 0.45;
    s.mix.connect(s.analyser);

    s.node = new AudioWorkletNode(s.ctx, 'pcm16k');
    const silent = s.ctx.createGain(); silent.gain.value = 0;
    s.mix.connect(s.node); s.node.connect(silent).connect(s.ctx.destination);
    s.node.port.onmessage = (e) => sendChunk(s, e.data);

    s.dest = s.ctx.createMediaStreamDestination();
    s.mix.connect(s.dest);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    s.mr = new MediaRecorder(s.dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    s.mr.ondataavailable = (e) => { if (e.data.size) s.chunks.push(e.data); };

    s.ws = await openLive(s); // rejects with a readable message if the server or key refuses
    s.t0 = performance.now(); s.startedAt = s.t0;
    s.mr.start(1000);
    rec.analyser = s.analyser;
    rec.phase = 'recording';
    s.tick = setInterval(() => { rec.elapsed = clockSec(s); emit(); }, 250);
    s.timer = setInterval(() => {
      if (!s.ws || s.ending || s.rotating) return;
      if (performance.now() - s.startedAt > ROTATE_AFTER_MS) rotate(s);
    }, 4000);
    emit();
  } catch (err) {
    release(s);
    rec.phase = 'idle';
    rec.error = friendly(err);
    emit();
  }
}

// A chosen input. Sound that comes from the computer itself is not a room: echo cancelling, noise filtering and automatic
// volume would only damage it, so those are off for it.
function openInput(deviceId, loopback, clean) {
  return navigator.mediaDevices.getUserMedia({
    audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: !loopback, noiseSuppression: clean && !loopback, autoGainControl: clean && !loopback },
  });
}

function friendly(err) {
  const n = err?.name;
  if (n === 'NotAllowedError') return 'Permission was declined. Allow the microphone or tab sharing and try again.';
  if (n === 'NotFoundError') return 'No microphone was found on this computer.';
  if (n === 'OverconstrainedError') return 'That audio input is not available any more. Choose another one.';
  if (n === 'NotReadableError') return 'The microphone is busy in another app.';
  return err?.message || 'Recording could not start.';
}

// Pause: the audio file and the clock stop, and the live captions get silence (tracks are muted) so the connection stays open.
export function pauseRecording() {
  const s = S;
  if (!s || rec.phase !== 'recording' || rec.paused || rec.reconnecting) return;
  s.pauseAt = performance.now();
  s.tracks.forEach((t) => { t.enabled = false; });
  try { if (s.mr?.state === 'recording') s.mr.pause(); } catch { /* */ }
  rec.paused = true; rec.analyser = null; emit();
}

export function resumeRecording() {
  const s = S;
  if (!s || rec.phase !== 'recording' || !rec.paused) return;
  s.pausedMs += performance.now() - s.pauseAt; s.pauseAt = null;
  s.tracks.forEach((t) => { t.enabled = true; });
  try { if (s.mr?.state === 'paused') s.mr.resume(); } catch { /* */ }
  rec.paused = false; rec.analyser = s.analyser; emit();
}

// Ends the session and returns what was captured. The caller saves it, then calls finishSaving().
export async function stopRecording() {
  const s = S;
  if (!s || rec.phase !== 'recording') return null;
  rec.phase = 'saving'; rec.paused = false; emit();
  s.ending = true;
  clearInterval(s.timer); clearInterval(s.tick);
  const durationSec = Math.max(1, Math.round(clockSec(s)));

  try { if (s.ws?.readyState === 1) s.ws.send('end'); } catch { /* */ }
  // Give the last spoken turn a moment to arrive as a final transcript.
  await new Promise((resolve) => {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (s.gotFinalAfterEnd || !s.ws || s.ws.readyState > 1 || performance.now() - t0 > 3500) { clearInterval(iv); resolve(); }
    }, 100);
  });
  if (rec.interim.trim()) addFinal(s, rec.interim, s.ws);
  rec.interim = '';

  const blob = await new Promise((resolve) => {
    if (!s.mr || s.mr.state === 'inactive') return resolve(new Blob(s.chunks));
    s.mr.onstop = () => resolve(new Blob(s.chunks, { type: s.mr.mimeType || 'audio/webm' }));
    s.mr.stop();
  });
  const transcript = rec.finals.map((f) => `${stamp(f.t)} ${f.text}`).join('\n\n');
  release(s);
  emit();
  return { blob, durationSec, transcript, provider: rec.provider };
}

export function finishSaving() {
  Object.assign(rec, { phase: 'idle', paused: false, elapsed: 0, finals: [], interim: '', notice: '', error: '' });
  emit();
}

window.addEventListener('beforeunload', (e) => {
  if (rec.phase === 'recording') { e.preventDefault(); e.returnValue = ''; }
});
