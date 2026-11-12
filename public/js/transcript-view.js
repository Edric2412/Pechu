// Timed transcript reader: speaker turns, clickable time chips, follow-the-audio highlight, speaker renaming.
// Pure parsing helpers are exported for the tests; DOM is only touched inside the render functions.
import { h, hasTamil } from './ui.js';

const HUES = [172, 12, 205, 150, 335, 230, 190, 120]; // pale tints for people; identity only, never data
const STAMP = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s+/;
const LABEL = /^([^\s:][^:\n]{0,28}):\s+([\s\S]+)$/;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 75 -> "01:15", 3725 -> "1:02:05"
export function fmtAt(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hr = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
  const two = (n) => String(n).padStart(2, '0');
  return hr ? `${hr}:${two(mi)}:${two(se)}` : `${two(mi)}:${two(se)}`;
}

// "[01:15] hello" -> { at: 75, rest: "hello" }; anything else -> null
export function parseStamp(line) {
  const m = STAMP.exec(line || '');
  if (!m) return null;
  return { at: (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]), rest: line.slice(m[0].length) };
}

// Each non-empty line is a paragraph: { at?, who (label or null), text (without the label), rest (with it) }.
function paragraphs(text) {
  return (text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean).map((p) => {
    const st = parseStamp(p);
    const rest = st ? st.rest.trim() : p;
    const m = LABEL.exec(rest);
    const out = m ? { who: m[1].trim(), text: m[2].trim(), rest } : { who: null, text: rest, rest };
    if (st) out.at = st.at;
    return out;
  });
}

// { turns: [{ who, text, at? }], names } when most paragraphs carry a speaker label, or (who '' and names [])
// when most carry a time stamp; null for plain prose.
export function parseTurns(text) {
  const paras = paragraphs(text);
  if (paras.length < 2) return null;
  const labelled = paras.filter((p) => p.who);
  const names = [...new Set(labelled.map((p) => p.who))];
  const speakerOk = labelled.length >= paras.length * 0.6 && names.length <= 10
    && (names.length >= 2 || names.every((n) => /^Speaker \d+$/.test(n)));
  if (speakerOk) {
    let last = names[0];
    const turns = paras.map((p) => {
      if (p.who) last = p.who;
      return p.at == null ? { who: last, text: p.text } : { who: last, text: p.text, at: p.at };
    });
    return { turns, names };
  }
  if (paras.filter((p) => p.at != null).length >= paras.length * 0.6) {
    // no labels: keep the label text inside the turn, it was not a speaker
    return { turns: paras.map((p) => (p.at == null ? { who: '', text: p.rest } : { who: '', text: p.rest, at: p.at })), names: [] };
  }
  return null;
}

export function speakerNames(text) {
  return parseTurns(text)?.names ?? [];
}

// Rename the label at the start of each turn (after an optional stamp). Returns the text unchanged for an empty or equal name.
export function renameSpeakerInText(text, oldName, newName) {
  const name = String(newName ?? '').replace(/[:\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28).trim();
  if (!text || !oldName || !name || name === oldName) return text;
  const re = new RegExp(`^([ \\t]*(?:\\[(?:\\d+:)?\\d{1,2}:\\d{2}\\][ \\t]+)?)${escapeRe(oldName)}:(?=\\s)`, 'gm');
  return text.replace(re, (_, lead) => `${lead}${name}:`);
}

// ----- rendering -----
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const lang = (t) => (hasTamil(t) ? 'ta' : 'en');

function avatar(names, who) {
  const hue = HUES[Math.max(0, names.indexOf(who)) % HUES.length];
  const initial = /^Speaker (\d+)$/.exec(who)?.[1] ?? Array.from(who.trim())[0]?.toUpperCase() ?? '?';
  const a = el('span', 'tv-avatar', initial);
  a.setAttribute('aria-hidden', 'true');
  a.style.setProperty('--h', String(hue));
  return a;
}

function chip(at) {
  const b = el('button', 'tv-stamp', fmtAt(at));
  b.type = 'button';
  b.setAttribute('aria-label', `Play from ${fmtAt(at)}`);
  return b;
}

// Speaker turns when the text has speaker labels, otherwise paragraphs; both get time chips where there is a stamp.
// One delegated click handler on the container, so a 1000-turn transcript creates no per-turn listeners.
export function transcriptBody(text, { onSeek } = {}) {
  const parsed = parseTurns(text);
  const names = parsed?.names ?? [];
  const items = parsed ? parsed.turns : paragraphs(text).map((p) => ({ who: '', text: p.rest, ...(p.at != null ? { at: p.at } : {}) }));
  if (!items.length) return el('div', 'tv-empty', 'No speech was picked up in this recording.');
  const root = el('div', names.length ? 'tv-turns' : 'tv-prose');
  if (names.length && !items.some((t) => t.at != null)) root.classList.add('tv-untimed'); // no stamps: no time column
  const frag = document.createDocumentFragment();
  if (names.length) {
    // Consecutive turns by the same person share one block: name on the left, one line per turn with its time beside it.
    let group = null, lines = null, prev = null;
    for (const t of items) {
      if (t.who !== prev) {
        group = el('div', 'tv-turn');
        group.style.setProperty('--h', String(HUES[Math.max(0, names.indexOf(t.who)) % HUES.length]));
        const side = el('div', 'tv-side');
        const who = el('span', 'tv-who', t.who);
        who.lang = lang(t.who);
        side.append(avatar(names, t.who), who);
        lines = el('div', 'tv-lines');
        group.append(side, lines);
        frag.append(group);
        prev = t.who;
      }
      const line = el('div', 'tv-line');
      if (t.at != null) line.dataset.at = String(t.at);
      const time = el('span', 'tv-time');
      if (t.at != null) time.append(chip(t.at));
      const body = el('p', 'tv-text', t.text);
      body.lang = lang(t.text);
      line.append(time, body);
      lines.append(line);
    }
  } else {
    for (const t of items) {
      const turn = el('p', 'tv-para');
      if (t.at != null) turn.dataset.at = String(t.at);
      turn.lang = lang(t.text);
      if (t.at != null) turn.append(chip(t.at), ' ');
      turn.append(t.text);
      frag.append(turn);
    }
  }
  root.append(frag);
  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('.tv-stamp');
    const at = b?.closest('[data-at]')?.dataset.at;
    if (at != null && onSeek) onSeek(Number(at));
  });
  return root;
}

// ----- follow the audio -----
const cache = new WeakMap(); // container -> { els, ats, current }

function turnsOf(container) {
  let c = cache.get(container);
  if (!c || !c.els.length || !container.contains(c.els[0])) {
    const els = [...container.querySelectorAll('.tv-line[data-at], .tv-para[data-at]')];
    c = { els, ats: els.map((e) => Number(e.dataset.at)), current: null };
    cache.set(container, c);
  }
  return c;
}

function scrollParent(node) {
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

// Marks the last turn that started at or before `seconds`. Cheap enough to call 4 times a second.
export function highlightAt(container, seconds, { follow = false } = {}) {
  const c = turnsOf(container);
  let lo = 0, hi = c.ats.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (c.ats[mid] <= seconds) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  const next = idx >= 0 ? c.els[idx] : null;
  if (next === c.current) return; // same turn: nothing to repaint, and never fight a reader who scrolled away
  c.current?.classList.remove('tv-current');
  c.current = next;
  if (!next) return;
  next.classList.add('tv-current');
  if (!follow) return;
  const sp = scrollParent(next);
  const box = sp ? sp.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const r = next.getBoundingClientRect();
  if (r.top < box.top || r.bottom > box.bottom) {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    next.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' });
  }
}

// ----- "Who said what" -----
// Rows of avatar + name + Rename; Rename swaps the row to an input (Enter commits, Escape or leaving cancels).
export function speakerList(names, { onRename } = {}) {
  const list = el('div', 'tv-speakers');
  for (const who of names) {
    const row = el('div', 'tv-speaker-row');
    const show = (refocus) => {
      const name = el('span', 'tv-speaker-name', who);
      name.lang = lang(who);
      const btn = h('button', { class: 'tv-link', type: 'button', 'aria-label': `Rename ${who}`, onclick: edit }, 'Rename');
      row.replaceChildren(avatar(names, who), name, btn);
      if (refocus) btn.focus();
    };
    const edit = () => {
      let open = true;
      const close = (commit, viaKey) => {
        if (!open) return;
        open = false;
        const v = input.value.trim();
        if (commit && v && v !== who) onRename?.(who, v);
        show(viaKey);
      };
      const input = h('input', { class: 'tv-input', value: who, 'aria-label': `New name for ${who}`, maxlength: '28',
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); close(true, true); }
          else if (e.key === 'Escape') close(false, true);
        },
        onblur: () => close(false, false) });
      row.replaceChildren(avatar(names, who), input);
      input.focus(); input.select();
    };
    show(false);
    list.append(row);
  }
  return list;
}
