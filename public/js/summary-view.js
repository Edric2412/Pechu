// The Summary tab: headline, sections, key points, decisions, actions. Editable in place.
// normalizeNotes / applyEdit / notesToMarkdown are pure (no DOM) so they can be tested and reused.
import { h, add, clear, icon, clock, hasTamil } from './ui.js';

// ---------- pure helpers ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim();
function secs(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
// Old notes hold plain strings, v2 holds { text, at? }. Anything else is dropped.
function item(x) {
  const o = typeof x === 'string' ? { text: x } : isObj(x) ? x : null;
  const text = o && str(o.text);
  if (!text) return null;
  const out = { text };
  const at = secs(o.at);
  if (at !== undefined) out.at = at;
  return out;
}
const items = (v) => (Array.isArray(v) ? v : []).map(item).filter(Boolean);
function decision(x) {
  const out = item(x);
  if (out && isObj(x) && str(x.who)) out.who = str(x.who);
  return out;
}
function action(x) {
  const o = typeof x === 'string' ? { task: x } : isObj(x) ? x : null;
  const task = o && str(o.task);
  if (!task) return null;
  const out = { task };
  for (const k of ['owner', 'due']) if (str(o[k])) out[k] = str(o[k]);
  const at = secs(o.at);
  if (at !== undefined) out.at = at;
  return out;
}

// Old or v2 notes -> v2. Never throws; missing parts become empty. Old notes simply get `sections: []`.
export function normalizeNotes(notes) {
  const n = isObj(notes) ? notes : {};
  const out = {
    title: str(n.title),
    summary: str(n.summary),
    sections: (Array.isArray(n.sections) ? n.sections : []).filter(isObj)
      .map((s) => ({ heading: str(s.heading), bullets: items(s.bullets) })).filter((s) => s.heading || s.bullets.length),
    keyPoints: items(n.keyPoints),
    decisions: (Array.isArray(n.decisions) ? n.decisions : []).map(decision).filter(Boolean),
    actions: (Array.isArray(n.actions) ? n.actions : []).map(action).filter(Boolean),
  };
  if (isObj(n.flow)) out.flow = n.flow;
  if (isObj(n.process)) out.process = n.process;
  return out;
}

const OPTIONAL = new Set(['who', 'owner', 'due', 'at']);
function setIn(node, path, value) {
  if (!path.length) return value;
  const [k, ...rest] = path;
  if (k === '__proto__' || k === 'constructor' || k === 'prototype') return node;
  const child = node == null ? undefined : node[k];
  if (rest.length && !(Array.isArray(child) || isObj(child))) return node;
  if (Array.isArray(node)) {
    if (!Number.isInteger(k) || k < 0 || k >= node.length) return node;
    const copy = node.slice();
    copy[k] = setIn(child, rest, value);
    return copy;
  }
  if (isObj(node)) {
    const copy = { ...node };
    if (!rest.length && OPTIONAL.has(k) && (value === '' || value == null)) delete copy[k];
    else copy[k] = setIn(child, rest, value);
    return copy;
  }
  return node;
}
// Returns a NEW v2 notes object with `value` placed at `path` (e.g. ['actions', 2, 'owner']). The input is untouched.
// Clearing an optional field (who, owner, due, at) removes it. A path that does not exist leaves the notes unchanged.
export function applyEdit(notes, path, value) {
  return setIn(normalizeNotes(notes), Array.isArray(path) ? path : [], value);
}

const oneLine = (t) => String(t).replace(/\s+/g, ' ').trim();
export function notesToMarkdown(notes, title) {
  const n = normalizeNotes(notes);
  const out = [];
  const name = oneLine(title || n.title);
  if (name) out.push(`# ${name}`);
  if (n.summary) out.push(n.summary);
  const block = (heading, lines) => { if (lines.length) out.push(`## ${oneLine(heading)}\n\n${lines.join('\n')}`); };
  for (const s of n.sections) block(s.heading || 'Notes', s.bullets.map((b) => `- ${oneLine(b.text)}`));
  block('Key points', n.keyPoints.map((b) => `- ${oneLine(b.text)}`));
  block('Decisions', n.decisions.map((d) => `- ${oneLine(d.text)}${d.who ? ` (${oneLine(d.who)})` : ''}`));
  block('Actions', n.actions.map((a) => {
    const meta = [a.owner, a.due].filter(Boolean).map(oneLine).join(', ');
    return `- ${oneLine(a.task)}${meta ? ` (${meta})` : ''}`;
  }));
  return out.join('\n\n') + '\n';
}

// ---------- view ----------
const get = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function summaryView(notes, { onSeek, onEdit, editable } = {}) {
  let state = normalizeNotes(notes); // our own copy: the given notes are never touched
  const root = h('div', { class: 'sv' + (editable ? ' sv-editing' : '') });

  function commit(path, value, rerender) {
    state = applyEdit(state, path, value);
    onEdit?.(path, value);
    if (rerender) render();
  }
  const setLang = (el, t) => { if (hasTamil(t)) el.setAttribute('lang', 'ta'); else el.removeAttribute('lang'); };

  // A piece of text. When editable: Enter or leaving commits, Escape reverts. Empty text reverts unless `optional`.
  function field({ tag = 'span', cls = '', value, label, placeholder, optional, onCommit, onRevert }) {
    const el = h(tag, { class: 'sv-text ' + cls });
    el.textContent = value;
    setLang(el, value);
    if (!editable) return el;
    el.setAttribute('contenteditable', 'plaintext-only');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', label);
    if (placeholder) el.dataset.placeholder = placeholder;
    let base = value;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); el.textContent = base; el.blur(); }
    });
    el.addEventListener('blur', () => {
      const v = el.textContent.replace(/\s+/g, ' ').trim();
      if (v === base || (!v && !optional)) { el.textContent = base; if (!base && !optional) onRevert?.(); return; }
      el.textContent = v;
      base = v;
      setLang(el, v);
      onCommit(v);
    });
    return el;
  }

  const seekChip = (at) => {
    if (at == null) return null;
    if (!onSeek) return h('span', { class: 'sv-at' }, clock(at));
    return h('button', { class: 'sv-at', type: 'button', title: 'Play from here', 'aria-label': `Play from ${clock(at)}`, onclick: () => onSeek(at) }, clock(at));
  };
  const removeBtn = (path, i, text) => editable
    ? h('button', { class: 'sv-remove', type: 'button', 'aria-label': `Remove: ${text}`, title: 'Remove',
      onclick: () => commit(path, get(state, path).filter((_, j) => j !== i), true) }, icon('close', 12))
    : null;
  // A small labelled chip (owner, due, who). Hidden when empty unless editing.
  const metaChip = (k, value, path, cls, placeholder) => (!value && !editable ? null
    : h('span', { class: `sv-chip ${cls}${value ? '' : ' is-empty'}` }, k ? h('span', { class: 'sv-chip-k' }, k) : null,
      field({ value: value || '', label: `Edit ${k ? k.toLowerCase() : 'who'}`, placeholder, optional: true, onCommit: (v) => commit(path, v) })));
  const panelHead = (title, count) => h('div', { class: 'panel-head' }, h('h2', null, title), count == null ? null : h('span', { class: 'chip' }, String(count)));

  // A bullet list with an empty state and (when editable) "+ Add" and per-item remove.
  function listBlock(path, arr, row, emptyText, blank, addLabel) {
    const ul = h('ul', { class: 'sv-list' }, arr.map(row));
    const empty = h('div', { class: 'empty' }, emptyText);
    const sync = () => { empty.hidden = ul.children.length > 0; };
    sync();
    let adding = null;
    const addBtn = editable ? h('button', { class: 'sv-add', type: 'button', 'aria-label': addLabel, onclick: () => {
      if (adding?.isConnected) { adding.querySelector('.sv-text').focus(); return; }
      const li = adding = h('li', { class: 'sv-item sv-new' });
      li.append(field({ tag: 'div', cls: 'sv-grow', value: '', label: addLabel, placeholder: 'Type, then press Enter',
        onCommit: (v) => commit(path, [...get(state, path), blank(v)], true),
        onRevert: () => { li.remove(); sync(); } }));
      ul.append(li); sync();
      li.querySelector('.sv-text').focus();
    } }, '+ Add') : null;
    return [empty, ul, addBtn];
  }

  const bullet = (path) => (it, i) => h('li', { class: 'sv-item' },
    field({ tag: 'div', cls: 'sv-grow', value: it.text, label: 'Edit text', onCommit: (v) => commit([...path, i, 'text'], v) }),
    h('span', { class: 'sv-side' }, seekChip(it.at), removeBtn(path, i, it.text)));
  const decisionRow = (it, i) => h('li', { class: 'sv-item sv-decision' },
    h('div', { class: 'sv-grow' },
      field({ tag: 'div', value: it.text, label: 'Edit decision', onCommit: (v) => commit(['decisions', i, 'text'], v) }),
      metaChip('', it.who, ['decisions', i, 'who'], 'sv-who', 'Who')),
    h('span', { class: 'sv-side' }, seekChip(it.at), removeBtn(['decisions'], i, it.text)));
  const actionRow = (a, i) => h('li', { class: 'sv-item' },
    h('div', { class: 'sv-grow' },
      field({ tag: 'div', value: a.task, label: 'Edit action', onCommit: (v) => commit(['actions', i, 'task'], v) }),
      (a.owner || a.due || editable) ? h('div', { class: 'sv-meta' },
        metaChip('Owner', a.owner, ['actions', i, 'owner'], 'sv-owner', 'name'),
        metaChip('Due', a.due, ['actions', i, 'due'], 'sv-due', 'date')) : null),
    h('span', { class: 'sv-side' }, seekChip(a.at), removeBtn(['actions'], i, a.task)));

  function render() {
    clear(root);
    const n = state;
    const summary = (!n.summary && !editable) ? h('div', { class: 'empty' }, 'No summary was written.')
      : field({ tag: 'p', cls: 'sv-lead', value: n.summary, label: 'Edit summary', placeholder: 'Write a short summary', onCommit: (v) => commit(['summary'], v) });
    add(root, [
      h('section', { class: 'panel sv-card', 'aria-label': 'Summary' }, panelHead('Summary'), summary),
      n.sections.map((s, i) => h('section', { class: 'panel sv-card sv-section', 'aria-label': s.heading || 'Section' },
        h('div', { class: 'panel-head' },
          field({ tag: 'h3', cls: 'sv-h', value: s.heading, label: 'Edit heading', placeholder: 'Heading', onCommit: (v) => commit(['sections', i, 'heading'], v) })),
        listBlock(['sections', i, 'bullets'], s.bullets, bullet(['sections', i, 'bullets']), 'Nothing was noted here.', (t) => ({ text: t }), `Add a point to ${s.heading || 'this section'}`))),
      h('div', { class: 'sv-row' },
        h('section', { class: 'panel sv-card', 'aria-label': 'Key points' }, panelHead('Key points', n.keyPoints.length),
          listBlock(['keyPoints'], n.keyPoints, bullet(['keyPoints']), 'No key points were found.', (t) => ({ text: t }), 'Add a key point')),
        h('section', { class: 'panel sv-card', 'aria-label': 'Decisions' }, panelHead('Decisions', n.decisions.length),
          listBlock(['decisions'], n.decisions, decisionRow, 'No decisions were stated.', (t) => ({ text: t }), 'Add a decision'))),
      h('section', { class: 'panel sv-card', 'aria-label': 'Actions' }, panelHead('Actions', n.actions.length),
        listBlock(['actions'], n.actions, actionRow, 'No actions were assigned.', (t) => ({ task: t }), 'Add an action'))]);
  }
  render();
  return root;
}
