// One meeting: progress while it is being processed, then Transcript / Summary / Flow chart tabs.
import { h, icon, tabs, segmented, swap, fadeIn, whenLabel, duration, wordCount, tamilShare, copyText, store, save } from '../ui.js';
import { api } from '../api.js';
import { refreshMeetings, state } from '../store.js';
import { renderFlow, svgToString } from '../flow.js';
import { renderProcess, processToSvgString } from '../process-flow.js';
import { summaryView, normalizeNotes, applyEdit, notesToMarkdown } from '../summary-view.js';
import { transcriptBody, highlightAt, speakerList, renameSpeakerInText, parseTurns } from '../transcript-view.js';
import { svgToPngBlob, downloadBlob, printNotes } from '../export.js';
import { PER_MINUTE, PER_MINUTE_SPEAKERS, priceLabel } from '../sarvam-cost.js';

const AUTO_TITLE = /^Meeting · /;
const STAMP = /^\[(?:\d+:)?\d{1,2}:\d{2}\]\s+/gm;
const plain = (t) => (t || '').replace(STAMP, ''); // for counting words: the [mm:ss] stamps are not words
const toSvgElement = (text) => new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;

export function meetingPage({ params, navigate }) {
  const id = params[0];
  let m = null, tab = store('pechu.tab', 'transcript'), version = 'english', fit = window.innerWidth > 900; // on a phone the chart is shown full size and scrolls sideways
  let flowMode = store('pechu.flowmode', 'process'), editing = false;
  let poll = 0, destroyed = false, lastKey = '';
  let audioEl = null, transcriptRoot = null;

  const root = h('div', { class: 'col' });
  const top = h('div');       // header, audio, tabs
  const body = h('div');      // tab content or processing view
  root.append(top, body);

  const problem = (err) => body.prepend(h('div', { class: 'notice err', role: 'alert', style: { marginBottom: '14px' } }, icon('alert'), err.message));

  // ---------- data ----------
  async function load(first) {
    try {
      m = await api.meeting(id);
    } catch (err) {
      if (first) { top.replaceChildren(); body.replaceChildren(notFound(err.message)); }
      return;
    }
    if (destroyed) return;
    const key = `${m.status}|${m.title}|${!!m.notes}|${m.transcript?.length}|${m.transcriptEnglish?.length}|${m.error || ''}|${m.transcriber || ''}|${m.refineError || ''}|${m.transcriptLive ? 1 : 0}|${m.notes?.process ? 1 : 0}`;
    if (key !== lastKey) { lastKey = key; paint(first); }
    else bannerText(); // only the progress note changed: update it in place, without redrawing the page
    clearTimeout(poll);
    if (working()) poll = setTimeout(() => load(false), 1500);
    else if (m.notes && AUTO_TITLE.test(m.title) && m.notes.title) {
      // give a fresh recording the title the notes suggest, once
      const t = m.notes.title.trim();
      if (t) { api.patchMeeting(id, { title: t }).then(() => { m.title = t; lastKey = ''; refreshMeetings(); load(false); }).catch(() => {}); }
    } else if (first) refreshMeetings();
  }
  const working = () => m?.status === 'transcribing' || m?.status === 'writing-notes';

  const notFound = (msg) => h('div', { class: 'panel' }, h('div', { class: 'notice err' }, icon('alert'), msg || 'This meeting could not be found.'), h('p', { style: { marginTop: '14px' } }, h('a', { class: 'link', href: '#/meetings' }, 'Back to meetings')));

  // ---------- the recording: jump to a moment, and follow along ----------
  function seek(at) {
    if (!audioEl) return;
    audioEl.currentTime = at;
    audioEl.play().catch(() => {});
  }
  function follow() { if (transcriptRoot && tab === 'transcript') highlightAt(transcriptRoot, audioEl.currentTime, { follow: !audioEl.paused }); }

  // ---------- header ----------
  function header() {
    // An editable heading: still a real h1 for screen readers, edited in place.
    const titleIn = h('h1', { class: 'title-input greeting', contenteditable: 'plaintext-only', role: 'textbox', 'aria-label': 'Meeting title', spellcheck: 'false',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); titleIn.blur(); } if (e.key === 'Escape') { titleIn.textContent = m.title; titleIn.blur(); } },
      onblur: async () => {
        const v = titleIn.textContent.trim().replace(/\s+/g, ' ');
        if (!v) { titleIn.textContent = m.title; return; }
        if (v === m.title) { titleIn.textContent = m.title; return; }
        try { await api.patchMeeting(id, { title: v }); m.title = v; lastKey = ''; refreshMeetings(); } catch { titleIn.textContent = m.title; }
      } }, m.title);
    const actions = h('div', { class: 'actions' });
    const showActions = () => {
      actions.replaceChildren();
      if (m.audio && (m.status === 'ready' || m.status === 'error') && !parseTurns(m.transcript)?.names.length)
        actions.append(h('button', { class: 'btn sm', type: 'button', onclick: confirmSpeakers }, icon('mic'), 'Identify speakers'));
      if (m.status === 'ready' && m.transcript) actions.append(h('button', { class: 'btn sm', type: 'button', onclick: rewrite }, icon('refresh'), 'Rewrite notes'));
      actions.append(h('button', { class: 'btn sm text danger', type: 'button', onclick: confirmDelete }, icon('trash'), 'Delete'));
    };
    const confirmSpeakers = () => {
      actions.replaceChildren(
        h('span', { class: 'muted', style: { alignSelf: 'center', maxWidth: '340px', textAlign: 'right' } }, `Transcribe the recording again with speaker labels? ${viaSarvam() ? `Sarvam charges ${priceLabel(m.durationSec, true)} for this. ` : ''}This replaces the transcript and notes.`),
        h('button', { class: 'btn sm primary', type: 'button', onclick: identifySpeakers }, 'Identify speakers'),
        h('button', { class: 'btn sm', type: 'button', onclick: showActions }, 'Cancel'));
    };
    const confirmDelete = () => {
      actions.replaceChildren(
        h('span', { class: 'muted', style: { alignSelf: 'center' } }, `Delete “${m.title}” for good?`),
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { await api.deleteMeeting(id); await refreshMeetings(); navigate('#/meetings'); } }, 'Delete'),
        h('button', { class: 'btn sm', type: 'button', onclick: showActions }, 'Keep'));
    };
    showActions();

    const meta = [whenLabel(m.createdAt), m.durationSec ? duration(m.durationSec) : null, m.source === 'live' ? 'Recorded in Pechu' : 'Uploaded'].filter(Boolean).join(' · ');
    return h('header', { class: 'head home', style: { marginBottom: m.audio ? '16px' : '0' } },
      h('a', { class: 'crumb', href: '#/meetings' }, icon('chevron'), 'Meetings'),
      h('div', { class: 'titlerow' }, h('div', { class: 'grow' }, titleIn, h('p', { class: 'greeting-sub' }, meta)), actions));
  }

  // Start a background job on the server, then watch it.
  async function run(job) {
    try { m = await job(); lastKey = ''; await load(false); } catch (err) { problem(err); }
  }
  const identifySpeakers = () => run(() => api.transcribeAgain(id, true));
  const improveTranscript = () => run(() => api.transcribeAgain(id, false));
  const viaSarvam = () => state.status?.transcriber === 'sarvam'; // the paid transcriber is on
  const transcribeAgain = () => run(() => api.transcribeAgain(id));
  const rewrite = () => run(() => api.writeNotes(id));

  // ---------- paint ----------
  function paint(first) {
    const head = header();
    top.replaceChildren(head);
    audioEl = null;
    if (m.audio) {
      audioEl = h('audio', { controls: true, preload: 'metadata', src: api.audioUrl(id) });
      audioEl.addEventListener('timeupdate', follow);
      audioEl.addEventListener('seeked', follow);
      top.append(h('div', { class: 'panel audio-bar', 'aria-label': 'Recording' }, icon('mic'), audioEl));
    }
    const busy = working();
    if (busy && !m.transcript) { swap(body, processing()); return; } // nothing to read yet
    if (m.status === 'error') { swap(body, failed()); return; }
    if (busy) top.append(banner());
    const t = tabs({
      items: [{ id: 'transcript', label: 'Transcript' }, { id: 'summary', label: 'Summary' }, { id: 'flow', label: 'Flow chart' }],
      value: tab, onChange: (v) => { tab = v; save('pechu.tab', v); show(true); },
    });
    const host = h('div');
    top.append(t);
    body.replaceChildren(host);
    host.dataset.host = '1';
    show(false);
    if (first) fadeIn(root, { y: 6, ms: 440 });
  }
  // A slim bar shown above the tabs while work continues, so the transcript can be read in the meantime.
  let bannerNode = null;
  const bannerLabel = () => (m.status === 'transcribing' ? 'Improving the transcript with Sarvam' : 'Working on the notes') + (m.progress ? ` · ${m.progress}` : '');
  function banner() {
    bannerNode = h('div', { class: 'working', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'spinner' }), h('span', { class: 'txt' }, bannerLabel()));
    return bannerNode;
  }
  function bannerText() {
    const t = bannerNode?.querySelector('.txt');
    if (t && working()) t.textContent = bannerLabel();
  }
  function show(animate) {
    const host = body.firstElementChild;
    if (!host) return;
    transcriptRoot = null;
    const view = tab === 'summary' ? summaryTab() : tab === 'flow' ? flowView() : transcriptView();
    if (animate) swap(host, view); else { host.replaceChildren(view); }
  }

  // ---------- processing / error ----------
  function processing() {
    const upload = m.source === 'upload';
    const writing = m.status === 'writing-notes';
    const via = state.status?.transcriber === 'sarvam' ? 'Sarvam' : 'Gemini 3.5 Transcribe';
    const showListen = upload || m.status === 'transcribing' || !!m.transcriptLive || !!m.refineError; // a live call gets a second listen
    const step = (label, state) => h('div', { class: `step ${state}` }, h('span', { class: 'mk' }, state === 'done' ? icon('check', 12) : null), label);
    return h('section', { class: 'panel processing', 'aria-live': 'polite' },
      h('h2', null, writing ? 'Writing your notes' : 'Transcribing your audio'),
      h('p', { class: 'muted', style: { marginBottom: '22px' } }, 'This page updates by itself. You can leave and come back.'),
      h('div', { class: 'steps' },
        step(upload ? 'Audio received' : 'Recording saved', 'done'),
        showListen ? step(`Transcribing the recording with ${via}`, writing ? 'done' : 'now') : null,
        step('Writing the English transcript, summary and flow chart', writing ? 'now' : ''),
        h('div', { class: 'bar', style: { marginTop: '6px' } }, h('i')),
        m.progress ? h('p', { class: 'muted', style: { marginTop: '2px' } }, m.progress) : null));
  }
  function failed() {
    const canRetry = !!m.transcript;
    return h('section', { class: 'panel' },
      h('div', { class: 'notice err', role: 'alert' }, icon('alert'),
        h('div', null, h('strong', null, canRetry ? 'The notes could not be written. ' : 'The audio could not be transcribed. '), m.error || 'Something went wrong.'),
        canRetry ? h('button', { class: 'btn sm', type: 'button', onclick: rewrite }, icon('refresh'), 'Try again')
          : m.source === 'upload' && m.audio ? h('button', { class: 'btn sm', type: 'button', onclick: transcribeAgain }, icon('refresh'), 'Try again')
          : h('a', { class: 'btn sm', href: '#/upload' }, 'Upload again')),
      canRetry ? h('div', { style: { marginTop: '20px' } }, transcriptBody(m.transcript, { onSeek: audioEl ? seek : undefined })) : null);
  }

  // ---------- transcript ----------
  // Rename "Speaker 2" to a real name in both versions, then rewrite the notes so they use the name.
  async function renameSpeaker(oldName, newName) {
    const patch = { transcript: renameSpeakerInText(m.transcript, oldName, newName) };
    if (m.transcriptEnglish) patch.transcriptEnglish = renameSpeakerInText(m.transcriptEnglish, oldName, newName);
    if (patch.transcript === m.transcript && patch.transcriptEnglish === m.transcriptEnglish) return;
    try {
      await api.patchMeeting(id, patch);
      Object.assign(m, patch);
      if (m.notes && m.transcriptEnglish) m = await api.writeNotesOnly(id); // refresh the summary with the new name (fast: no translation)
      lastKey = '';
      await load(false);
    } catch (err) { problem(err); }
  }
  // A live recording is written up from its live captions. Listening to the saved audio again with Sarvam costs money, so it is
  // never automatic: this card is where the person chooses it, with the price on each button.
  function improveCard() {
    if (m.source !== 'live' || !m.audio || m.transcriptLive || working() || !viaSarvam()) return null;
    return h('div', { class: 'improve', role: 'region', 'aria-label': 'Improve this transcript' }, icon('wave'),
      h('div', null,
        h('strong', null, 'This transcript comes from the live captions. '),
        'For a more accurate one, Sarvam can listen to the saved recording again. It only runs when you press a button and takes a few minutes.',
        h('div', { class: 'acts' },
          h('button', { class: 'btn sm primary', type: 'button', onclick: improveTranscript }, `Improve transcript · ${priceLabel(m.durationSec, false)}`),
          h('button', { class: 'btn sm', type: 'button', onclick: identifySpeakers }, `Improve and identify speakers · ${priceLabel(m.durationSec, true)}`)),
        h('p', { class: 'hint' }, `Sarvam charges ₹${PER_MINUTE.toFixed(2)} a minute, or ₹${PER_MINUTE_SPEAKERS.toFixed(2)} with speaker labels, before tax. The live captions stay under “Live captions”, and the notes are rewritten from the new transcript.`)));
  }
  function transcriptView() {
    const hasEn = !!m.transcriptEnglish;
    const hasLive = !!m.transcriptLive;
    if (!hasEn && version === 'english') version = 'spoken';
    if (!hasLive && version === 'live') version = 'spoken';
    const text = () => (version === 'english' && hasEn ? m.transcriptEnglish : version === 'live' && hasLive ? m.transcriptLive : m.transcript);
    const content = h('div');
    const draw = () => { transcriptRoot = transcriptBody(text(), { onSeek: audioEl ? seek : undefined }); return transcriptRoot; };
    content.append(draw());
    const options = [hasEn ? { value: 'english', label: 'English' } : null, { value: 'spoken', label: 'As spoken' }, hasLive ? { value: 'live', label: 'Live captions' } : null].filter(Boolean);
    const seg = options.length > 1 ? segmented({
      options, value: version, label: 'Transcript version',
      onChange: (v) => { version = v; swap(content, draw()); },
    }) : null;
    const copyBtn = h('button', { class: 'btn sm', type: 'button', onclick: async () => { const ok = await copyText(text() || ''); copyBtn.lastChild.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { copyBtn.lastChild.textContent = 'Copy'; }, 1500); } }, icon('copy'), h('span', null, 'Copy'));
    const dl = h('button', { class: 'btn sm', type: 'button', onclick: () => downloadBlob(`${slug(m.title)}.txt`, new Blob([text() || ''], { type: 'text/plain' })) }, icon('download'), 'Download');
    const share = tamilShare(m.transcript);
    const turns = parseTurns(m.transcript);
    const names = turns?.names ?? [];
    return h('div', { class: 'grid' },
      h('section', { class: 'panel s9', 'aria-label': 'Transcript' },
        m.refineError ? h('div', { class: 'notice', role: 'status', style: { marginBottom: '14px' } }, icon('alert'), `The improved transcript could not be made, so the earlier one is shown: ${m.refineError}`) : null,
        improveCard(),
        h('div', { class: 'panel-head' }, seg, h('span', { class: 'spacer' }), copyBtn, dl),
        content),
      h('section', { class: 'panel s3 sticky', 'aria-label': 'About this transcript' },
        h('div', { class: 'panel-head' }, h('h2', null, 'About')),
        h('div', { class: 'kv' },
          kv('Words', wordCount(plain(text())).toLocaleString()),
          kv('Tamil script', share == null ? '—' : `${share}%`),
          kv('Length', duration(m.durationSec)),
          kv('Speakers', names.length ? String(names.length) : 'Not identified'),
          kv('Made with', m.transcriber || (m.source === 'live' ? 'Gemini Transcribe Live' : 'Gemini 3.5 Transcribe'))),
        names.length ? h('div', { class: 'speakers' }, h('h3', null, 'Who said what'), speakerList(names, { onRename: renameSpeaker })) : null));
  }
  const kv = (k, v) => h('div', { class: 'r' }, h('span', null, k), h('span', null, v));

  // ---------- summary ----------
  function needNotes() {
    if (working()) return h('section', { class: 'panel' }, h('div', { class: 'empty' }, 'This is being written now and will appear here by itself.'));
    return h('section', { class: 'panel' }, h('div', { class: 'empty' }, 'The notes have not been written yet.'),
      m.transcript ? h('p', { style: { marginTop: '14px', textAlign: 'center' } }, h('button', { class: 'btn primary', type: 'button', onclick: rewrite }, 'Write notes now')) : null);
  }
  function summaryTab() {
    if (!m.notes) return needNotes();
    let current = normalizeNotes(m.notes);
    const saved = h('span', { class: 'muted', style: { alignSelf: 'center', fontSize: '12px' }, 'aria-live': 'polite' });
    async function commit(path, value) {
      current = applyEdit(current, path, value);
      try {
        const r = await api.patchMeeting(id, { notes: current });
        m.notes = r.notes;
        saved.textContent = 'Saved';
        setTimeout(() => { saved.textContent = ''; }, 1500);
      } catch (err) { problem(err); }
    }
    const view = summaryView(current, { onSeek: audioEl ? seek : undefined, onEdit: editing ? commit : undefined, editable: editing });
    const md = () => notesToMarkdown(current, m.title);
    const copyBtn = h('button', { class: 'btn sm', type: 'button', onclick: async () => { const ok = await copyText(md()); copyBtn.lastChild.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { copyBtn.lastChild.textContent = 'Copy all'; }, 1500); } }, icon('copy'), h('span', null, 'Copy all'));
    const toolbar = h('div', { class: 'toolbar' },
      saved,
      h('button', { class: 'btn sm' + (editing ? ' primary' : ''), type: 'button', onclick: () => { editing = !editing; show(true); } }, editing ? [icon('check'), 'Done editing'] : 'Edit'),
      copyBtn,
      h('button', { class: 'btn sm', type: 'button', onclick: () => downloadBlob(`${slug(m.title)}.md`, new Blob([md()], { type: 'text/markdown' })) }, icon('download'), 'Markdown'),
      h('button', { class: 'btn sm', type: 'button', onclick: () => printNotes(m.title, view, current.process ? [toSvgElement(processToSvgString(renderProcess(current.process).svg))] : []).catch(problem) }, icon('file'), 'PDF'));
    return h('div', { class: 'stack' }, toolbar, view);
  }

  // ---------- flow chart ----------
  function flowView() {
    const n = m.notes && normalizeNotes(m.notes);
    if (!n?.flow) return needNotes();
    const hasProcess = !!n.process;
    const mode = hasProcess && flowMode === 'process' ? 'process' : 'map';
    const scroll = h('div', { class: 'flow-scroll', tabindex: '0', 'aria-label': 'Flow chart, scrollable' });
    let chart = null;
    const apply = () => {
      if (!chart) return;
      // "fit" only shrinks a chart that is wider than the panel; a narrow chart stays at its natural size, centred
      chart.svg.style.width = fit ? '100%' : `${chart.width}px`;
      chart.svg.style.maxWidth = fit ? `${chart.width}px` : 'none';
      chart.svg.style.margin = fit ? '0 auto' : '0';
      chart.svg.style.height = fit ? 'auto' : `${chart.height}px`;
    };
    document.fonts.ready.then(() => {
      chart = mode === 'process' ? renderProcess(n.process, { onSeek: audioEl ? seek : undefined }) : renderFlow(n.flow);
      scroll.replaceChildren(chart.svg);
      apply();
      fadeIn(chart.svg, { y: 0, ms: 560 });
    });
    // a standalone light copy for downloads
    const exportSvg = () => (mode === 'process' ? toSvgElement(processToSvgString(chart.svg)) : toSvgElement(svgToString(chart.svg)));
    const svgText = () => (mode === 'process' ? processToSvgString(chart.svg) : svgToString(chart.svg));
    const sw = (cls, label) => h('span', null, h('i', { class: cls }), label);
    const kind = h('div', { style: { display: 'contents' } });
    const modeSeg = hasProcess ? segmented({ options: [{ value: 'process', label: 'Process' }, { value: 'map', label: 'Topic map' }], value: mode, label: 'Chart type', onChange: (v) => { flowMode = v; save('pechu.flowmode', v); show(true); } }) : null;
    const zoomSeg = segmented({ options: [{ value: 'fit', label: 'Fit to width' }, { value: 'full', label: 'Full size' }], value: fit ? 'fit' : 'full', label: 'Zoom', onChange: (v) => { fit = v === 'fit'; apply(); } });
    const redraw = h('button', { class: 'btn sm', type: 'button', disabled: !m.transcriptEnglish || working(), onclick: () => run(() => api.redrawFlow(id)) }, icon('refresh'), hasProcess ? 'Redraw' : 'Draw step-by-step');
    return h('section', { class: 'panel', 'aria-label': 'Flow chart' },
      h('div', { class: 'flow-tools' },
        mode === 'map' ? h('div', { class: 'legend' }, sw('sw-topic', 'Topic'), sw('sw-point', 'Point'), sw('sw-decision', 'Decision'), sw('sw-action', 'Action')) : h('p', { class: 'muted', style: { fontSize: '12px' } }, n.process.steps.some((s) => s.at != null) ? 'Select a step with a time to jump the recording there.' : 'The steps in the order they happen.'),
        h('span', { class: 'spacer' }), modeSeg, zoomSeg, kind,
        redraw,
        h('button', { class: 'btn sm', type: 'button', onclick: () => chart && downloadBlob(`${slug(m.title)}-flow.svg`, new Blob([svgText()], { type: 'image/svg+xml' })) }, icon('download'), 'SVG'),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (!chart) return; try { downloadBlob(`${slug(m.title)}-flow.png`, await svgToPngBlob(exportSvg(), { scale: 2 })); } catch (err) { problem(err); } } }, icon('download'), 'PNG')),
      scroll);
  }

  const slug = (s) => (s || 'meeting').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting';

  load(true);
  return {
    el: root,
    mounted: () => {},
    destroy() { destroyed = true; clearTimeout(poll); audioEl?.pause(); },
  };
}
