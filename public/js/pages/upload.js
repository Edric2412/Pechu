// Upload an existing recording. The server transcribes it with Gemini 3.5 Transcribe, then writes the notes.
import { h, icon, segmented, toggle, fileSize } from '../ui.js';
import { api } from '../api.js';
import { state } from '../store.js';
import { refreshMeetings } from '../store.js';

const ACCEPT = '.mp3,.m4a,.wav,.ogg,.oga,.opus,.webm,.aac,.flac,.mp4,audio/*';
const MAX = 200 * 1024 * 1024;

export function uploadPage({ navigate }) {
  let file = null, mode = 'smart', speakers = true, busy = false;

  const picker = h('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: () => choose(picker.files[0]) });
  const titleIn = h('input', { class: 'input', id: 'u-title', placeholder: 'Taken from the file name', autocomplete: 'off' });
  const modeSeg = segmented({
    options: [{ value: 'smart', label: 'Clean' }, { value: 'verbatim', label: 'As spoken' }],
    value: mode, full: true, label: 'Transcript style', onChange: (v) => { mode = v; },
  });
  const speakerToggle = toggle({ checked: speakers, label: 'Identify speakers', onChange: (v) => { speakers = v; modeSeg.setDisabled(v); styleHint.hidden = !v; } });
  const styleHint = h('p', { class: 'hint', id: 'style-hint' }, 'Speaker labels use the as-spoken style.');
  modeSeg.setDisabled(true);
  const errBox = h('div', { class: 'notice err', hidden: true, role: 'alert' });
  const progress = h('div', { class: 'bar det', hidden: true, role: 'progressbar', 'aria-label': 'Upload progress' }, h('i'));
  const startBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: start }, 'Transcribe and write notes');

  const drop = h('div', { class: 'drop', role: 'group', 'aria-label': 'Audio file' });
  function paintDrop() {
    drop.replaceChildren();
    if (!file) {
      drop.append(
        icon('upload', 22),
        h('div', { class: 'big' }, 'Drop an audio file here'),
        h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, 'Choose a file'),
        h('p', { class: 'hint', id: 'u-help' }, 'MP3, M4A, WAV, OGG, WebM or FLAC, up to 200 MB.'));
    } else {
      drop.append(
        h('div', { class: 'filecard', style: { width: '100%', maxWidth: '460px', textAlign: 'left' } },
          icon('file', 20),
          h('div', { class: 'grow' }, h('div', { class: 't' }, file.name), h('div', { class: 'hint' }, fileSize(file.size))),
          h('button', { class: 'btn text sm', type: 'button', disabled: busy, onclick: () => choose(null) }, 'Remove')),
        h('p', { class: 'hint' }, 'Long meetings can take a few minutes to transcribe.'));
    }
    startBtn.disabled = !file || busy;
  }

  function choose(f) {
    errBox.hidden = true;
    if (f && f.size > MAX) { show('That file is larger than 200 MB. Trim it or export a smaller version.'); f = null; }
    else if (f && !/^audio\//.test(f.type) && !/\.(mp3|m4a|wav|ogg|oga|opus|webm|aac|flac|mp4)$/i.test(f.name)) { show('That does not look like an audio file.'); f = null; }
    file = f; picker.value = '';
    paintDrop();
  }
  function show(msg) { errBox.hidden = false; errBox.replaceChildren(icon('alert'), msg); }

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (!busy) choose(e.dataTransfer.files[0]); });

  async function start() {
    if (!file || busy) return;
    busy = true; errBox.hidden = true; progress.hidden = false;
    startBtn.disabled = true; startBtn.replaceChildren(h('span', { class: 'spinner' }), 'Uploading');
    paintDrop();
    try {
      const m = await api.upload(file, { title: titleIn.value.trim(), mode, speakers }, (p) => progress.style.setProperty('--p', `${Math.round(p * 100)}%`));
      await refreshMeetings();
      navigate(`#/meeting/${m.id}`);
    } catch (err) {
      busy = false; progress.hidden = true;
      show(err.message);
      startBtn.replaceChildren('Transcribe and write notes');
      paintDrop();
    }
  }

  paintDrop();
  return {
    el: h('div', { class: 'col' },
      h('header', { class: 'head home' },
        h('h1', { class: 'greeting' }, 'Upload a recording.'),
        h('p', { class: 'greeting-sub' }, `Transcribed with ${state.status?.transcriber === 'sarvam' ? 'Sarvam Saaras' : 'Gemini 3.5 Transcribe'}, then turned into a clean English transcript, a summary and a flow chart.`)),
      h('div', { class: 'grid even' },
        h('section', { class: 'panel s9 fill', 'aria-label': 'Choose a recording' }, drop, picker),
        h('section', { class: 'panel s3 fill', 'aria-label': 'Options' },
          h('div', { class: 'panel-head' }, h('h2', null, 'Options')),
          h('div', { class: 'stack grow' },
            h('div', { class: 'field' }, h('label', { for: 'u-title' }, 'Title'), titleIn),
            h('div', { class: 'switch-row' }, h('div', { class: 'txt' }, h('div', { class: 'ttl' }, 'Identify speakers'), h('div', { class: 'hint' }, 'Labels each turn Speaker 1, Speaker 2')), speakerToggle),
            h('div', { class: 'field' }, h('span', { class: 'label' }, 'Transcript style'), modeSeg, styleHint),
            progress, errBox, h('div', { class: 'push' }, startBtn))))),
    mounted: () => modeSeg.place(),
  };
}
