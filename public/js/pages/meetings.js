// All meetings, newest first, with a quick filter.
import { h, icon, whenLabel, duration, statusPill } from '../ui.js';
import { state, subscribeState, refreshMeetings } from '../store.js';

export function meetingsPage() {
  let q = '';
  const subLine = h('p', { class: 'greeting-sub' });
  const body = h('div', { class: 'table' });
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Search titles', 'aria-label': 'Search meetings', oninput: () => { q = input.value.trim().toLowerCase(); paint(); } });

  function paint() {
    const all = state.meetings;
    const list = q ? all.filter((m) => m.title.toLowerCase().includes(q)) : all;
    const total = all.reduce((s, m) => s + (m.durationSec || 0), 0);
    subLine.textContent = all.length
      ? `${all.length} ${all.length === 1 ? 'meeting' : 'meetings'} · ${duration(total)} recorded`
      : 'Nothing recorded yet';
    body.replaceChildren();
    if (!all.length) {
      body.append(h('div', { class: 'empty' }, state.loaded ? 'No meetings yet. Record one or upload an audio file and it will appear here.' : 'Loading'));
      return;
    }
    if (!list.length) { body.append(h('div', { class: 'empty' }, `No meeting title contains “${input.value.trim()}”.`)); return; }
    body.append(h('div', { class: 'thead' }, h('span', null, 'Meeting'), h('span', null, 'Source'), h('span', null, 'Date'), h('span', { class: 'r' }, 'Length'), h('span', { class: 'r' }, 'Status')));
    for (const m of list) {
      body.append(h('a', { class: 'trow', href: `#/meeting/${m.id}` },
        h('span', { class: 'name' }, m.title),
        h('span', { class: 'c-src muted' }, m.source === 'live' ? 'Recorded' : 'Uploaded'),
        h('span', { class: 'c-date muted' }, whenLabel(m.createdAt)),
        h('span', { class: 'c-len r muted' }, duration(m.durationSec)),
        h('span', { class: 'c-status r' }, statusPill(m.status))));
    }
  }

  const unsub = subscribeState(paint);
  refreshMeetings();
  paint();
  return {
    el: h('div', { class: 'col' },
      h('header', { class: 'head home' }, h('h1', { class: 'greeting' }, 'Your meetings.'), subLine),
      h('section', { class: 'panel', 'aria-label': 'All meetings' },
        h('div', { class: 'panel-head' }, h('div', { class: 'search' }, icon('search'), input)),
        body)),
    destroy: unsub,
  };
}
