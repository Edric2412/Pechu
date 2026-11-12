// Small DOM helpers, icons, controls and formatters. No framework.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val; } }
    else if (k === 'html') el.innerHTML = v; // only ever used with the static icon strings below
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  add(el, kids);
  return el;
}
// A small confirmation pop-up. Resolves true when the person confirms and false for anything else (Cancel, Escape, a click outside).
// Cancel has the focus first, so pressing Enter never confirms something that costs money by accident.
export function confirmDialog({ title, lines = [], confirmLabel = 'Continue', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'modal-title' },
      h('h2', { id: 'modal-title' }, title),
      ...lines.map((t) => h('p', null, t)),
      h('div', { class: 'acts' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => dlg.close('cancel') }, cancelLabel),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => dlg.close('ok') }, confirmLabel)));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'ok'); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
// Replace an element's children; unlike replaceChildren it skips null/false instead of printing "null".
export const set = (el, ...kids) => add(clear(el), kids);

// ---------- icons: 16px outline, 1.5px stroke ----------
const ICONS = {
  mic: '<rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5"/>',
  monitor: '<rect x="2" y="2.5" width="12" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11v3"/>',
  wave: '<path d="M2.5 8h1M5.5 5v6M8.5 2.5v11M11.5 5v6M14 8h-.5"/>',
  upload: '<path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
  key: '<circle cx="5" cy="10.5" r="2.5"/><path d="M7 8.8l6-6M11 4.8l1.5 1.5M9.3 6.5l1.2 1.2"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.8"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4.5 4.5l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8"/>',
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  refresh: '<path d="M13 3.5v3h-3M3 12.5v-3h3M12.4 6.5A5 5 0 0 0 3.6 5M3.6 9.5a5 5 0 0 0 8.8 1.5"/>',
  download: '<path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1"/>',
  chevron: '<path d="M6 3.5l4.5 4.5L6 12.5"/>',
  alert: '<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11h.01"/>',
  file: '<path d="M4 1.8h5l3.5 3.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z"/><path d="M9 1.8v3.5h3.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  moon: '<path d="M13 9.2A5.5 5.5 0 0 1 6.8 3a5.5 5.5 0 1 0 6.2 6.2z"/>',
};
export function icon(name, size = 16) {
  return h('span', {
    class: 'icon', 'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}
export function brandMark(size = 30) {
  return h('span', {
    class: 'brand-mark', style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true',
    html: '<svg width="18" height="18" viewBox="0 0 18 18" fill="#fff"><rect x="2" y="7" width="3" height="4" rx="1.5"/><rect x="7.5" y="3" width="3" height="12" rx="1.5"/><rect x="13" y="6" width="3" height="6" rx="1.5"/></svg>',
  });
}

// ---------- controls ----------
export function toggle({ checked, onChange, label, disabled }) {
  const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label, checked: checked || null, disabled: disabled || null,
    onchange: () => onChange?.(input.checked) });
  input.checked = !!checked;
  return h('span', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', { class: 'thumb' }));
}

// Segmented control with a sliding thumb.
export function segmented({ options, value, onChange, full, label }) {
  const thumb = h('span', { class: 'thumb' });
  const root = h('div', { class: 'seg' + (full ? ' full' : ''), role: 'group', 'aria-label': label || null }, thumb);
  const btns = options.map((o) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value), onclick: () => set(o.value, true) }, o.label);
    b.dataset.v = o.value;
    root.append(b);
    return b;
  });
  function place() {
    const on = btns.find((b) => b.getAttribute('aria-pressed') === 'true');
    if (!on || !on.offsetWidth) return;
    thumb.style.width = on.offsetWidth + 'px';
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  function set(v, fire) {
    btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    place();
    if (fire) onChange?.(v);
  }
  root.set = (v) => set(v, false);
  root.setDisabled = (d) => btns.forEach((b) => { b.disabled = d; });
  root.place = place;
  new ResizeObserver(place).observe(root);
  requestAnimationFrame(place);
  return root;
}

// Underline tabs with a sliding indicator.
export function tabs({ items, value, onChange }) {
  const ind = h('span', { class: 'ind' });
  const root = h('div', { class: 'tabs', role: 'tablist' }, ind);
  const btns = items.map((it) => {
    const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(it.id === value), onclick: () => set(it.id, true) }, it.label);
    b.dataset.id = it.id;
    root.append(b);
    return b;
  });
  function place() {
    const on = btns.find((b) => b.getAttribute('aria-selected') === 'true');
    if (!on || !on.offsetWidth) return;
    ind.style.width = on.offsetWidth + 'px';
    ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  function set(id, fire) {
    btns.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
    place();
    if (fire) onChange?.(id);
  }
  root.set = (id) => set(id, false);
  root.place = place;
  new ResizeObserver(place).observe(root);
  requestAnimationFrame(place);
  return root;
}

// ---------- motion ----------
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

export function fadeIn(el, { y = 8, ms = 420, delay = 0 } = {}) {
  if (reduceMotion()) return;
  el.animate([{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }],
    { duration: ms, delay, easing: EASE, fill: 'backwards' });
}
// Fades `el` to invisible and leaves it at opacity 0 (callers that reuse the element reset el.style.opacity).
export async function fadeOut(el, ms = 220) {
  if (reduceMotion() || !el) return;
  const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE, fill: 'forwards' });
  await a.finished.catch(() => {});
  el.style.opacity = '0';
  a.cancel();
}
// Cross-fade the contents of `host` from the old node to `next`.
export async function swap(host, next) {
  const old = host.firstElementChild;
  if (old) await fadeOut(old, 200);
  clear(host);
  host.append(next);
  fadeIn(next);
}

// ---------- formatters ----------
const pad = (n) => String(n).padStart(2, '0');
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hrs = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return hrs ? `${hrs}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
export function duration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}
export function whenLabel(iso) {
  const d = new Date(iso), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + `, ${time}`;
}
export const longDate = (d = new Date()) => d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
export function greeting(name) {
  const hr = new Date().getHours();
  const part = hr < 5 ? 'Late night' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}.`;
}
export const wordCount = (t) => (t || '').trim().split(/\s+/).filter(Boolean).length;
export const hasTamil = (t) => /[஀-௿]/.test(t || '');
export function tamilShare(t) {
  const letters = (t || '').match(/\p{L}/gu) || [];
  if (!letters.length) return null;
  const ta = letters.filter((c) => /[஀-௿]/.test(c)).length;
  return Math.round((ta / letters.length) * 100);
}
export function fileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
export function statusPill(status) {
  const map = {
    ready: ['ok', 'Ready'], transcribing: ['live', 'Transcribing'], 'writing-notes': ['live', 'Writing notes'], error: ['bad', 'Needs attention'],
  };
  const [cls, text] = map[status] || ['', status];
  return h('span', { class: `pill ${cls}` }, cls === 'live' ? h('span', { class: 'dot' }) : null, text);
}

export function copyText(text) {
  return navigator.clipboard.writeText(text).then(() => true, () => false);
}
export function store(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }
