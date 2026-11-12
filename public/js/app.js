// Shell and router. Pages are plain modules that return { el, mounted?, destroy?, bare? }.
import { h, set, icon, brandMark, clock, fadeIn, fadeOut, reduceMotion, toggle } from './ui.js';
import { theme, setTheme, onTheme } from './theme.js';
import { mountBackdrop } from './backdrop.js';
import { mountSmoothScroll, scrollToTop } from './smooth-scroll.js';
import { state, subscribeState, refreshStatus, refreshMeetings } from './store.js';
import { rec, subscribe as subscribeRec } from './recorder.js';
import { recordPage } from './pages/record.js';
import { uploadPage } from './pages/upload.js';
import { meetingsPage } from './pages/meetings.js';
import { meetingPage } from './pages/meeting.js';
import { setupPage } from './pages/setup.js';
import { loginPage } from './pages/login.js';
import { api } from './api.js';

const app = document.getElementById('app');
const navigate = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

const ROUTES = [
  { re: /^#?\/?$/, name: 'record', page: recordPage },
  { re: /^#\/upload$/, name: 'upload', page: uploadPage },
  { re: /^#\/meetings$/, name: 'meetings', page: meetingsPage },
  { re: /^#\/meeting\/([a-z0-9-]+)$/, name: 'meeting', page: meetingPage },
  { re: /^#\/setup$/, name: 'setup', page: setupPage },
];

let current = null;     // { page, bare }
let shell = null;       // sidebar + canvas refs
let busy = false, pending = false;
let auth = null;       // { authRequired, authed } from the server

// ---------- shell ----------
function navItem(href, label, ico, name) {
  return h('a', { href, 'data-name': name }, icon(ico), label);
}
function buildNav() {
  const recents = h('div', { class: 'nav' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    navItem('#/', 'Record', 'mic', 'record'),
    navItem('#/upload', 'Upload', 'upload', 'upload'),
    navItem('#/meetings', 'Meetings', 'list', 'meetings'),
    h('div', { class: 'nav-group' }, 'Recent'),
    recents);
  const chip = h('a', { class: 'rec-chip', href: '#/', hidden: true }, h('span', { class: 'dot' }), 'Recording', h('time', null, '00:00'));
  const keyState = h('span', { class: 'state' });
  const keyRow = h('a', { class: 'nav-row key-row', href: '#/setup', style: { display: 'flex', alignItems: 'center', gap: '10px', height: '34px', padding: '0 10px', borderRadius: '10px', textDecoration: 'none', color: 'var(--muted)' } }, icon('key'), 'Gemini key', keyState);
  // light / dark switch; stays in step if the theme changes elsewhere (the other menu, or the system setting)
  const dark = toggle({ checked: theme() === 'dark', label: 'Dark mode', onChange: (on) => setTheme(on ? 'dark' : 'light') });
  onTheme((t) => { dark.querySelector('input').checked = t === 'dark'; });
  const themeRow = h('div', { class: 'nav-row theme-row' }, icon('moon'), 'Dark mode', h('span', { class: 'state' }, dark));
  const outRow = auth?.authRequired ? h('button', { class: 'nav-row key-row', type: 'button', style: { display: 'flex', alignItems: 'center', gap: '10px', height: '34px', padding: '0 10px', borderRadius: '10px', border: '0', background: 'none', color: 'var(--muted)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }, onclick: async () => { try { await api.logout(); } catch { /* signing out anyway */ } auth.authed = false; state.status = null; location.reload(); } }, icon('lock'), 'Sign out') : null;
  const foot = h('div', { class: 'sidebar-foot' }, chip, themeRow, keyRow, outRow);

  function paint() {
    recents.replaceChildren();
    const items = state.meetings.slice(0, 5);
    if (!items.length) recents.append(h('div', { class: 'nav-empty' }, state.loaded ? 'Nothing yet' : ''));
    for (const m of items) recents.append(h('a', { class: 'recent-link', href: `#/meeting/${m.id}`, 'data-name': 'meeting', 'data-id': m.id }, h('span', { class: 't' }, m.title)));
    set(keyState, state.status?.hasKey ? h('i') : null, state.status?.hasKey ? 'Connected' : 'Not set');
    mark();
  }
  function mark() {
    const hash = location.hash || '#/';
    nav.querySelectorAll('a').forEach((a) => {
      if (a.getAttribute('href') === hash) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function recChip() {
    const on = rec.phase === 'recording' || rec.phase === 'saving';
    chip.hidden = !on || (location.hash === '' || location.hash === '#/' || location.hash === '#');
    chip.querySelector('time').textContent = clock(rec.elapsed);
  }
  return { nav, foot, paint, mark, recChip };
}

function buildShell() {
  const side = buildNav();
  const sidebar = h('aside', { class: 'sidebar' },
    h('a', { class: 'brand', href: '#/', 'aria-label': 'Pechu home' }, brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'Pechu'), h('div', { class: 'brand-scope' }, 'Personal'))),
    side.nav, side.foot);

  // phone / tablet: top bar + slide-in sheet carrying the same nav
  const sheetNav = buildNav();
  let sheet = null, backdrop = null;
  const closeSheet = () => { sheet?.remove(); backdrop?.remove(); sheet = backdrop = null; };
  const openSheet = () => {
    if (sheet) return closeSheet();
    backdrop = h('div', { class: 'sheet-backdrop', onclick: closeSheet });
    sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Menu' },
      h('div', { class: 'brand' }, brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'Pechu'), h('div', { class: 'brand-scope' }, 'Personal'))),
      sheetNav.nav, sheetNav.foot);
    sheet.addEventListener('click', (e) => { if (e.target.closest('a')) closeSheet(); });
    document.body.append(backdrop, sheet);
    sheetNav.paint(); sheetNav.recChip();
    if (!reduceMotion()) { sheet.animate([{ transform: 'translateX(-24px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.4,0,0.2,1)' }); backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 }); }
  };
  const topbar = h('div', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, brandMark(26), h('div', { class: 'brand-name' }, 'Pechu')),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Open menu', onclick: openSheet }, icon('menu', 20)));

  const view = h('div', { class: 'view' });
  const canvas = h('main', { class: 'canvas', id: 'main' }, view);
  const wrap = h('div', { class: 'app' }, sidebar, h('div', { style: { minWidth: 0 } }, topbar, canvas));

  const paintAll = () => { side.paint(); sheetNav.paint(); };
  const markAll = () => { side.mark(); sheetNav.mark(); closeSheet(); side.recChip(); };
  subscribeState(paintAll);
  subscribeRec(() => { side.recChip(); sheetNav.recChip(); });
  return { wrap, view, canvas, paintAll, markAll };
}

// ---------- router ----------
async function route() {
  if (busy) { pending = true; return; }
  busy = true;
  try {
    do {
      pending = false;
      await render();
    } while (pending);
  } finally { busy = false; }
}

async function render() {
  const hash = location.hash || '#/';
  let match = ROUTES.map((r) => ({ r, m: hash.match(r.re) })).find((x) => x.m);
  if (!match) { location.replace('#/'); return; }

  if (!auth) { try { auth = await api.auth(); } catch { auth = { authRequired: false, authed: true }; } }
  const needLogin = auth.authRequired && !auth.authed;

  // first run: nothing works without a key
  if (!needLogin && !state.status) { try { await refreshStatus(); } catch { app.replaceChildren(h('p', { style: { padding: '40px' } }, 'Pechu cannot reach its server. Is it running?')); return; } }
  if (!needLogin && !state.status.hasKey && match.r.name !== 'setup') { location.replace('#/setup'); return; }

  const next = needLogin
    ? loginPage({ onDone: () => { auth.authed = true; state.status = null; location.reload(); } })
    : match.r.page({ params: match.m.slice(1), navigate });
  const bare = !!next.bare;

  // switch between the bare gate and the full shell
  if (bare) {
    if (current && !current.bare) { await fadeOut(app.firstElementChild, 220); }
    current?.page.destroy?.();
    shell = null;
    app.replaceChildren(next.el);
    fadeIn(next.el, { y: 10, ms: 520 });
    next.focus?.();
    current = { page: next, bare: true };
    return;
  }
  if (!shell) {
    if (current?.bare) await fadeOut(app.firstElementChild, 220);
    shell = buildShell();
    app.replaceChildren(shell.wrap);
    fadeIn(shell.wrap, { y: 0, ms: 520 });
    refreshMeetings();
  } else if (shell.view.firstElementChild) {
    await fadeOut(shell.view, 130);
  }
  current?.page.destroy?.();
  shell.view.replaceChildren(next.el);
  shell.view.style.opacity = '';
  shell.paintAll(); shell.markAll();
  scrollToTop();
  next.mounted?.();
  fadeIn(shell.view, { y: 8, ms: 300 });
  current = { page: next, bare: false };
  document.title = 'Pechu';
}

mountBackdrop();
mountSmoothScroll();
window.addEventListener('pechu:signin', () => { if (auth) { auth.authed = false; shell = null; route(); } });
window.addEventListener('hashchange', route);
route();
