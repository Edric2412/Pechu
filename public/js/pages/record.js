// Home: the recorder. The wave is the biggest thing on the screen because the screen's
// one question is "is it listening?".
import { h, set, icon, toggle, segmented, clock, greeting, longDate, hasTamil, wordCount, whenLabel, duration, statusPill, copyText, store, save, fadeIn } from '../ui.js';
import { api } from '../api.js';
import { state, subscribeState, refreshMeetings } from '../store.js';
import { createWave } from '../wave.js';
import { rec, subscribe, startRecording, stopRecording, pauseRecording, resumeRecording, finishSaving } from '../recorder.js';

const NAME = 'Edric';
const defaults = { mic: true, device: true, lang: 'auto', mode: 'SMART', noise: true, monitor: '' };
// inputs that carry the computer's own sound, not a room
const isLoopback = (label) => /monitor|loopback|blackhole|soundflower|stereo mix|cable output|virtual/i.test(label || '');
const canShare = !!navigator.mediaDevices?.getDisplayMedia; // phones cannot share a tab or screen

const calendarIcon = () => h('span', {
  class: 'icon', 'aria-hidden': 'true',
  html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 6.8h11M5.5 2v3M10.5 2v3"/></svg>',
});

export function recordPage({ navigate }) {
  const saved = store('pechu.settings', {});
  const cfg = { ...defaults, ...saved };
  if (saved.device === undefined && saved.tab !== undefined) cfg.device = !!saved.tab; // the old "meeting audio" setting
  const persist = () => save('pechu.settings', cfg);

  // ---------- greeting ----------
  const weekCount = () => state.meetings.filter((m) => Date.now() - new Date(m.createdAt) < 7 * 864e5).length;
  const subLine = h('p', { class: 'greeting-sub' });
  const setSub = () => {
    const n = weekCount();
    set(subLine, calendarIcon(), `${longDate()} • ${n === 0 ? 'No meetings recorded this week' : n === 1 ? '1 meeting this week' : `${n} meetings this week`}`);
  };
  setSub();

  // ---------- stage ----------
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const wave = createWave(canvas, { onLevel: (v) => { recWrap.style.setProperty('--lvl', Math.min(1, v * 1.6).toFixed(3)); } });
  const pill = h('span', { class: 'pill' });
  const providerLabel = h('span');
  const timer = h('div', { class: 'timer', role: 'timer', 'aria-live': 'off' }, '00:00');
  // idle: one coral record button. recording: a pause / resume button and a stop square.
  const recBtn = h('button', { class: 'rec-btn', type: 'button', 'aria-label': 'Start recording', onclick: onToggle }, h('i'));
  const recLabel = h('span', { class: 'rec-cap' }, 'Start recording');
  const pauseBtn = h('button', { class: 'rec-pause', type: 'button', 'aria-label': 'Pause recording', onclick: () => { if (rec.paused) resumeRecording(); else pauseRecording(); } }, h('i'));
  const pauseLabel = h('span', { class: 'rec-cap' }, 'Pause');
  const stopBtn = h('button', { class: 'rec-stop', type: 'button', 'aria-label': 'Stop and write notes', onclick: onToggle }, h('i'));
  const recWrap = h('div', { class: 'rec-wrap' },
    h('div', { class: 'rec-item rec-start' }, recBtn, recLabel),
    h('div', { class: 'rec-item rec-live' }, pauseBtn, pauseLabel),
    h('div', { class: 'rec-item rec-live' }, stopBtn, h('span', { class: 'rec-cap' }, 'Stop')));
  const hint = h('p', { class: 'stage-hint' });
  const noticeBox = h('div', { class: 'notice', hidden: true, role: 'status' });
  const errorBox = h('div', { class: 'notice err', hidden: true, role: 'alert' });

  const stage = h('section', { class: 'panel stage s9', 'aria-label': 'Recorder' },
    h('div', { class: 'stage-top' }, pill, h('span', { class: 'provider' }, providerLabel, h('i', { class: 'provider-dot', 'aria-hidden': 'true' }))),
    h('div', { class: 'wave-wrap' }, canvas),
    timer,
    recWrap,
    hint, noticeBox, errorBox);

  // ---------- sources ----------
  const micToggle = toggle({ checked: cfg.mic, label: 'Microphone', onChange: (v) => { cfg.mic = v; persist(); render(); } });
  // Device audio = everything this computer plays. Where the computer offers a "Monitor of ..." input (Ubuntu, or a
  // loopback tool) it is used directly, with no sharing prompt; otherwise the browser asks to share a tab or screen.
  const deviceToggle = toggle({ checked: cfg.device && canShare, label: 'Device audio', onChange: (v) => { cfg.device = v; persist(); render(); } });
  let devices = [];
  const monitorSel = h('select', { class: 'input', id: 'monitor-device', 'aria-label': 'Which device sound to record', onchange: () => { cfg.monitor = monitorSel.value; persist(); render(); } });
  const showInputs = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch { /* the person said no */ }
    await loadDevices();
  } }, 'Find the device’s audio');
  const monitors = () => devices.filter((d) => d.deviceId !== 'communications' && isLoopback(d.label));
  // the input to use: the chosen one, else the first
  const monitorId = () => { const m = monitors(); return (m.find((d) => d.deviceId === cfg.monitor) ?? m[0])?.deviceId ?? ''; };
  function paintDevices() {
    const m = monitors();
    monitorSel.replaceChildren(...m.map((d) => h('option', { value: d.deviceId }, d.label)));
    if (m.length) monitorSel.value = monitorId();
    monitorSel.hidden = m.length < 2;
    showInputs.hidden = devices.some((d) => d.label); // names only show once the browser has allowed the microphone
    deviceHint.textContent = !canShare && !m.length
      ? 'A phone cannot record other apps. Put the call on speaker, or record it in the app and use Upload.'
      : m.length ? 'Everything this computer plays, so people on a Zoom, Meet or Teams call are recorded.'
      : 'You will be asked to share a tab or screen: tick “Share audio”. On Windows, share the whole screen to get every app.';
  }
  async function loadDevices() {
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { devices = []; }
    paintDevices();
  }
  const deviceHint = h('div', { class: 'hint' });
  loadDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices);
  const noiseToggle = toggle({ checked: cfg.noise, label: 'Noise filter', onChange: (v) => { cfg.noise = v; persist(); } });
  const langSel = h('select', { class: 'input', id: 'lang', onchange: () => { cfg.lang = langSel.value; persist(); } },
    h('option', { value: 'auto' }, 'Detect automatically'),
    h('option', { value: 'ta-IN' }, 'Tamil'),
    h('option', { value: 'en-IN' }, 'English (India)'));
  langSel.value = cfg.lang;
  const modeSeg = segmented({
    options: [{ value: 'SMART', label: 'Clean' }, { value: 'VERBATIM', label: 'As spoken' }],
    value: cfg.mode, full: true, label: 'Transcript style',
    onChange: (v) => { cfg.mode = v; persist(); },
  });

  const sources = h('section', { class: 'panel s3 sources-panel', 'aria-label': 'Sources' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Sources')),
    h('div', { class: 'sources' },
      h('div', { class: 'switch-row' }, h('div', { class: 'txt' }, h('div', { class: 'ttl' }, icon('mic'), 'Microphone'), h('div', { class: 'hint' }, 'You, and anyone in the room')), micToggle),
      h('div', { class: 'switch-row' }, h('div', { class: 'txt' }, h('div', { class: 'ttl' }, icon('monitor'), 'Device audio'), deviceHint), deviceToggle),
      h('div', { class: 'field' }, monitorSel, showInputs),
      h('div', { class: 'switch-row' }, h('div', { class: 'txt' }, h('div', { class: 'ttl' }, icon('wave') , 'Noise filter'), h('div', { class: 'hint' }, 'Try it off in a quiet room if words get clipped')), noiseToggle),
      h('div', { class: 'divider' }),
      h('div', { class: 'field' }, h('label', { for: 'lang' }, 'Language'), langSel),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Transcript style'), modeSeg),
      h('p', { class: 'hint push', style: { paddingTop: '8px' } }, 'On an online call, wear headphones so the microphone does not record the speakers a second time.'),
      state.status?.transcriber === 'sarvam' ? h('p', { class: 'hint', style: { paddingTop: '8px' } }, 'Live captions become your transcript. You can improve it with AI on the meeting afterwards.') : null));

  // ---------- live transcript ----------
  const linesBox = h('div', { class: 'lines grow', role: 'log', 'aria-live': 'polite', 'aria-label': 'Live transcript' });
  const emptyBox = h('div', { class: 'empty fillbox' }, 'Words appear here as people speak.');
  const wordChip = h('span', { class: 'chip' }, '0 words');
  const copyBtn = h('button', { class: 'link', type: 'button', onclick: async () => {
    const ok = await copyText(rec.finals.map((f) => f.text).join('\n\n'));
    copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  } }, 'Copy');
  const live = h('section', { class: 'panel s9 fill', style: { minHeight: '260px' }, 'aria-label': 'Live transcript' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Live transcript'), wordChip, h('span', { class: 'spacer' }), copyBtn),
    emptyBox, linesBox);
  linesBox.hidden = true;

  let drawn = 0;
  let interimNode = null;
  const lineNode = (f, extra = '') => {
    const p = h('p', { class: 'line fade-in ' + extra, lang: hasTamil(f.text) ? 'ta' : 'en' },
      h('span', { class: 'stamp' }, f.t != null ? clock(f.t) : ''), h('span', null, f.text));
    return p;
  };
  function renderTranscript() {
    if (rec.finals.length < drawn) { linesBox.replaceChildren(); interimNode = null; drawn = 0; }
    const stick = linesBox.scrollTop + linesBox.clientHeight >= linesBox.scrollHeight - 40;
    if (interimNode) { interimNode.remove(); interimNode = null; }
    while (drawn < rec.finals.length) linesBox.append(lineNode(rec.finals[drawn++]));
    if (rec.interim) { interimNode = lineNode({ t: null, text: rec.interim }, 'interim'); interimNode.classList.remove('fade-in'); linesBox.append(interimNode); }
    const has = rec.finals.length > 0 || !!rec.interim;
    linesBox.hidden = !has; emptyBox.hidden = has;
    if (stick) linesBox.scrollTop = linesBox.scrollHeight;
    wordChip.textContent = `${wordCount(rec.finals.map((f) => f.text).join(' '))} words`;
  }

  // ---------- recent ----------
  const recentBox = h('div', { class: 'rows' });
  const recent = h('section', { class: 'panel s3', 'aria-label': 'Recent meetings' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Recent'), h('span', { class: 'spacer' }), h('a', { class: 'link', href: '#/meetings' }, 'View all')),
    recentBox);
  function renderRecent() {
    const items = state.meetings.slice(0, 4);
    recentBox.replaceChildren();
    if (!items.length) { recentBox.append(h('div', { class: 'empty' }, state.loaded ? 'No meetings yet. Your first one will show up here.' : 'Loading')); return; }
    for (const m of items) {
      recentBox.append(h('a', { class: 'rowcard', href: `#/meeting/${m.id}` },
        h('div', { class: 'grow' },
          h('div', { class: 't' }, m.title),
          h('div', { class: 'm' }, whenLabel(m.createdAt) + (m.durationSec ? ` · ${duration(m.durationSec)}` : '')),
          m.status !== 'ready' ? statusPill(m.status) : null)));
    }
  }

  // ---------- state -> view ----------
  function render() {
    const p = rec.phase;
    const on = p === 'recording';
    const paused = on && rec.paused;
    pill.className = 'pill' + (on ? (rec.reconnecting ? ' warn' : paused ? ' paused' : ' live') : '');
    set(pill, on ? h('span', { class: 'dot' }) : null,
      p === 'starting' ? 'Starting' : on ? (rec.reconnecting ? 'Reconnecting' : paused ? 'Paused' : 'Recording') : p === 'saving' ? 'Saving' : 'Ready');
    providerLabel.textContent = rec.provider || (state.status?.transcriber === 'sarvam' ? 'Sarvam Saaras v4' : 'Gemini 3.5 Transcribe Live');
    timer.textContent = clock(rec.elapsed);
    timer.classList.toggle('on', on);
    timer.classList.toggle('paused', paused);
    recWrap.classList.toggle('on', on);
    recWrap.classList.toggle('paused', paused);
    recWrap.classList.toggle('busy', p === 'starting' || p === 'saving');
    const none = !cfg.mic && !(cfg.device && (canShare || monitorId()));
    recBtn.disabled = p === 'starting' || p === 'saving' || (p === 'idle' && none);
    pauseBtn.disabled = rec.reconnecting;
    pauseBtn.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
    pauseLabel.textContent = paused ? 'Resume' : 'Pause';
    recLabel.textContent = p === 'starting' ? 'Starting…' : p === 'saving' ? 'Saving your meeting…' : 'Start recording';
    hint.textContent = p === 'idle' && none ? 'Turn on the microphone, the device audio, or both.' : '';
    hint.hidden = !hint.textContent;
    wave.setAnalyser(on && !paused ? rec.analyser : null);

    const locked = p !== 'idle';
    for (const t of [micToggle, deviceToggle, noiseToggle]) t.querySelector('input').disabled = locked;
    monitorSel.disabled = locked;
    deviceToggle.querySelector('input').disabled = locked || (!canShare && !monitorId());
    langSel.disabled = locked; modeSeg.setDisabled(locked);

    noticeBox.hidden = !rec.notice;
    noticeBox.replaceChildren(icon('alert'), rec.notice);
    errorBox.hidden = !rec.error;
    errorBox.replaceChildren(icon('alert'), rec.error);
    renderTranscript();
  }

  async function onToggle() {
    if (rec.phase === 'idle') {
      await startRecording({ mic: cfg.mic, tab: cfg.device && canShare && !monitorId(), sysDevice: cfg.device ? monitorId() : '', mode: cfg.mode, lang: cfg.lang, noise: cfg.noise });
      return;
    }
    if (rec.phase !== 'recording') return;
    const result = await stopRecording();
    if (!result) return;
    try {
      const title = `Meeting · ${new Date().toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`;
      const m = await api.createMeeting({ title, source: 'live', transcript: result.transcript, durationSec: result.durationSec, transcriber: result.provider });
      if (result.blob.size) await api.putAudio(m.id, result.blob);
      await api.writeNotes(m.id);
      finishSaving();
      await refreshMeetings();
      navigate(`#/meeting/${m.id}`);
    } catch (err) {
      finishSaving();
      rec.error = `The meeting could not be saved: ${err.message}`;
      render();
    }
  }

  const unsubRec = subscribe(render);
  const unsubState = subscribeState(() => { renderRecent(); setSub(); });
  wave.start();
  render(); renderRecent();

  const el = h('div', { class: 'col' },
    h('header', { class: 'head home' }, h('h1', { class: 'greeting' }, greeting(NAME)), subLine),
    h('div', { class: 'grid even' }, stage, sources, live, recent));

  return {
    el,
    mounted: () => { modeSeg.place(); },
    destroy() { unsubRec(); unsubState(); wave.destroy(); },
  };
}
