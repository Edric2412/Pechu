// Draws a Process (steps joined by arrows, decisions that branch, loops that go back) as a
// top-to-bottom flow chart in SVG. layoutProcess() is pure so it runs in tests without a DOM.
//
// Layout: longest-path layers (loops are cut open first), long arrows get invisible stepping
// stones so they run between boxes, barycenter sweeps order each layer, then x positions are
// pulled toward their neighbours without ever letting two boxes touch.

const NS = 'http://www.w3.org/2000/svg';
const FONT = (weight, size) => `${weight} ${size}px "Instrument Sans", "Noto Sans Tamil", system-ui, sans-serif`;
const LABEL_FONT = FONT(500, 14), WHO_FONT = FONT(400, 12), EDGE_FONT = FONT(600, 12);
const KINDS = new Set(['start', 'step', 'decision', 'end']);

const STEP_W = 240, DECISION_W = 264, PILL_MIN_W = 120, PILL_PAD = 22;
const PAD_X = 16, PAD_Y = 12, LINE_H = 19, WHO_H = 17, CUT = 22, MAX_LINES = 7;
const MIN_H = { start: 44, end: 44, step: 52, decision: 76 };
const H_GAP = 40, DUMMY_GAP = 18, V_GAP = 52, PAD = 28;
const LANE_GAP = 26, LANE_STEP = 14, CHIP_W = 42, CHIP_H = 18, CHIP_OVER = 9;

// ---------- text measuring ----------
let canvasCtx;
// Canvas when there is a document (same approach as flow.js); a character-count estimate otherwise.
export function defaultMeasure(text, font) {
  if (typeof document !== 'undefined') {
    canvasCtx ||= document.createElement('canvas').getContext('2d');
    if (canvasCtx) { canvasCtx.font = font; return canvasCtx.measureText(text).width; }
  }
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 14;
  return [...text].length * size * 0.55;
}

// Whole characters (a Tamil letter with its vowel sign stays together).
const graphemes = (s) => (typeof Intl !== 'undefined' && Intl.Segmenter
  ? Array.from(new Intl.Segmenter().segment(s), (x) => x.segment) : [...s]);

function ellipsize(text, maxW, font, measure) {
  if (measure(text, font) <= maxW) return text;
  const g = graphemes(text);
  while (g.length > 1 && measure(g.join('') + '…', font) > maxW) g.pop();
  return g.join('').trimEnd() + '…';
}

function wrapText(text, maxW, font, measure) {
  const lines = [];
  let cur = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const test = cur ? cur + ' ' + word : word;
    if (measure(test, font) <= maxW) { cur = test; continue; }
    if (cur) lines.push(cur);
    let rest = graphemes(word); // a word wider than the box is broken, never allowed to spill out
    while (rest.length > 1 && measure(rest.join(''), font) > maxW) {
      let k = rest.length - 1;
      while (k > 1 && measure(rest.slice(0, k).join(''), font) > maxW) k--;
      lines.push(rest.slice(0, k).join(''));
      rest = rest.slice(k);
    }
    cur = rest.join('');
  }
  if (cur) lines.push(cur);
  if (!lines.length) return [''];
  if (lines.length > MAX_LINES) {
    const kept = lines.slice(0, MAX_LINES - 1);
    kept.push(ellipsize(lines.slice(MAX_LINES - 1).join(' '), maxW, font, measure));
    return kept;
  }
  return lines;
}

const validAt = (at) => (Number.isFinite(at) && at >= 0 ? Math.floor(at) : undefined);
const even = (v) => Math.ceil(v / 2) * 2;

function boxFor(step, measure) {
  const kind = KINDS.has(step.kind) ? step.kind : 'step';
  const label = String(step.label ?? '').trim();
  const whoRaw = typeof step.who === 'string' ? step.who.trim() : '';
  let w = kind === 'decision' ? DECISION_W : STEP_W;
  const textW = kind === 'decision' ? w - 2 * CUT - 8 : kind === 'step' ? w - 2 * PAD_X : w - 2 * PILL_PAD;
  const lines = wrapText(label, textW, LABEL_FONT, measure);
  const who = whoRaw ? ellipsize(whoRaw, textW, WHO_FONT, measure) : undefined;
  if (kind === 'start' || kind === 'end') { // pills hug their text
    const widest = Math.max(...lines.map((l) => measure(l, LABEL_FONT)), who ? measure(who, WHO_FONT) : 0);
    w = Math.min(STEP_W, Math.max(PILL_MIN_W, even(widest + 2 * PILL_PAD)));
  }
  const h = Math.max(MIN_H[kind], even(lines.length * LINE_H + (who ? WHO_H : 0) + 2 * PAD_Y + (kind === 'decision' ? 8 : 0)));
  return { id: String(step.id), kind, label, who, at: validAt(step.at), lines, w: even(w), h };
}

// ---------- layout ----------
export function layoutProcess(process, measure = defaultMeasure) {
  const ids = new Map();
  const steps = [];
  for (const s of Array.isArray(process?.steps) ? process.steps : []) {
    const id = s && s.id != null ? String(s.id) : '';
    if (!id || ids.has(id)) continue; // ids are unique; a repeat cannot be told apart, so it is ignored
    ids.set(id, steps.length);
    steps.push(s);
  }
  const n = steps.length;
  if (!n) return { nodes: [], edges: [], width: PAD * 2, height: PAD * 2 };

  const items = steps.map((s, i) => ({ real: true, idx: i, up: [], down: [], rank: Infinity, ...boxFor(s, measure) }));
  const out = items.map(() => []);
  const edges = [];
  steps.forEach((s, i) => {
    const seen = new Set();
    for (const nx of Array.isArray(s.next) ? s.next : []) {
      const j = ids.get(String(nx?.to));
      if (j == null || seen.has(j)) continue;
      seen.add(j);
      const label = typeof nx.label === 'string' ? nx.label.trim() : '';
      const e = { from: i, to: j, label, back: false, chain: null, points: [] };
      out[i].push(e);
      edges.push(e);
    }
  });

  // 1. DFS from the start finds loops (edges to a step still on the stack), then from each step it never reached.
  const state = new Array(n).fill(0); // 0 new, 1 on the stack, 2 done
  const dfs = (root, order) => {
    const stack = [[root, 0]];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const v = top[0];
      if (top[1] < out[v].length) {
        const e = out[v][top[1]++];
        if (state[e.to] === 1) e.back = true;
        else if (state[e.to] === 0) { state[e.to] = 1; stack.push([e.to, 0]); }
      } else { state[v] = 2; order.push(v); stack.pop(); }
    }
  };
  const post1 = [], post2 = [];
  dfs(0, post1);
  const reached = state.map((s) => s !== 0);
  for (let i = 0; i < n; i++) if (state[i] === 0) dfs(i, post2);

  // 2. longest-path layers. Unreached steps start below everything reachable.
  const layer = new Array(n).fill(0);
  const relax = (order, inSet) => {
    for (const v of order.slice().reverse()) {
      for (const e of out[v]) if (!e.back && inSet(e.to)) layer[e.to] = Math.max(layer[e.to], layer[v] + 1);
    }
  };
  relax(post1, (v) => reached[v]);
  const base = Math.max(...layer.filter((_, i) => reached[i])) + 1;
  for (let i = 0; i < n; i++) if (!reached[i]) layer[i] = base;
  relax(post2, (v) => !reached[v]);
  for (const e of edges) if (layer[e.to] <= layer[e.from]) e.back = true;
  items.forEach((it, i) => { it.layer = layer[i]; });

  // 3. stepping stones: an arrow that skips layers passes through one invisible item per layer.
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (const e of out[i]) {
      if (e.back) continue;
      const chain = [items[i]];
      for (let l = layer[i] + 1; l < layer[e.to]; l++) {
        const d = { real: false, idx: items.length, layer: l, w: 0, h: 0, up: [], down: [], rank: k };
        items.push(d);
        chain.push(d);
      }
      chain.push(items[e.to]);
      chain[1].rank = Math.min(chain[1].rank, k);
      for (let c = 0; c + 1 < chain.length; c++) { chain[c].down.push(chain[c + 1]); chain[c + 1].up.push(chain[c]); }
      e.chain = chain;
      k++;
    }
  }
  for (const it of items) if (it.rank === Infinity) it.rank = 0;

  // 4. order inside each layer: build top-down, then a few barycenter sweeps both ways.
  const depth = Math.max(...items.map((it) => it.layer)) + 1;
  const layers = Array.from({ length: depth }, () => []);
  for (const it of items) layers[it.layer].push(it);
  const setPos = (list) => list.forEach((it, i) => { it.pos = i; });
  const mean = (list) => list.reduce((s, it) => s + it.pos, 0) / list.length;
  layers.forEach(setPos);
  for (let l = 1; l < depth; l++) {
    for (const it of layers[l]) it.key = it.up.length ? mean(it.up) : 1e9;
    layers[l].sort((a, b) => a.key - b.key || a.rank - b.rank || a.idx - b.idx);
    setPos(layers[l]);
  }
  const sweep = (l, nbrs) => {
    for (const it of layers[l]) it.key = it[nbrs].length ? mean(it[nbrs]) : it.pos;
    layers[l].sort((a, b) => a.key - b.key || a.pos - b.pos);
    setPos(layers[l]);
  };
  for (let round = 0; round < 3; round++) {
    for (let l = depth - 2; l >= 0; l--) sweep(l, 'down');
    for (let l = 1; l < depth; l++) sweep(l, 'up');
  }

  // 5. x: pack each layer, then pull every item toward the middle of its neighbours (order kept, gaps kept).
  const sep = (a, b) => (a.w + b.w) / 2 + (a.real && b.real ? H_GAP : DUMMY_GAP);
  for (const list of layers) {
    let x = 0;
    list.forEach((it, i) => { x += i ? sep(list[i - 1], it) : 0; it.x = x; });
    const shift = x / 2;
    list.forEach((it) => { it.x -= shift; });
  }
  const settle = (list, want) => {
    const off = [0];
    for (let i = 1; i < list.length; i++) off[i] = off[i - 1] + sep(list[i - 1], list[i]);
    const blocks = []; // pool-adjacent-violators: the closest positions that keep the order
    list.forEach((_, i) => {
      blocks.push({ sum: want[i] - off[i], n: 1, from: i });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.sum / a.n <= b.sum / b.n) break;
        a.sum += b.sum; a.n += b.n; blocks.pop();
      }
    });
    for (const b of blocks) for (let i = b.from; i < b.from + b.n; i++) list[i].x = b.sum / b.n + off[i];
  };
  const pull = (l, nbrs) => settle(layers[l], layers[l].map((it) => (it[nbrs].length ? it[nbrs].reduce((s, o) => s + o.x, 0) / it[nbrs].length : it.x)));
  for (let round = 0; round < 4; round++) {
    for (let l = 1; l < depth; l++) pull(l, 'up');
    for (let l = depth - 2; l >= 0; l--) pull(l, 'down');
  }
  for (const it of items) it.x = Math.round(it.x);

  // 6. y: each layer is a band as tall as its tallest box; boxes sit in the middle of the band.
  const top = [], bottom = [];
  let y = 0;
  layers.forEach((list, l) => {
    const bandH = Math.max(0, ...list.map((it) => it.h));
    top[l] = y; bottom[l] = y + bandH;
    for (const it of list) { it.y = it.real ? Math.round(y + (bandH - it.h) / 2) : y; if (!it.real) it.h = bandH; }
    y += bandH + V_GAP;
  });

  // 7. forward arrows: down from the box, across the middle of the gap, down into the next one.
  const labelPos = new Map();
  for (const e of edges) {
    if (e.back) continue;
    const pts = [];
    e.chain.forEach((a, c) => {
      const b = e.chain[c + 1];
      if (!b) return;
      const mid = bottom[a.layer] + 20; // close to the source so a loop arriving above its target has room
      const hop = [{ x: a.x, y: a.y + a.h }, { x: a.x, y: mid }, { x: b.x, y: mid }, { x: b.x, y: b.y }];
      pts.push(...hop);
      if (c === 0) {
        const dx = b.x - a.x;
        labelPos.set(e, Math.abs(dx) >= 48 ? { x: (a.x + b.x) / 2, y: mid }
          : dx === 0 ? { x: a.x, y: (hop[0].y + b.y) / 2 } : { x: b.x, y: (mid + b.y) / 2 });
      }
    });
    e.points = tidy(pts);
  }

  // 8. loops leave from the side of the box, run down the margin and come back in above the target.
  const lanes = [];
  const backs = edges.filter((e) => e.back).sort((a, b) => Math.abs(layer[a.from] - layer[a.to]) - Math.abs(layer[b.from] - layer[b.to]));
  for (const e of backs) {
    const s = items[e.from], t = items[e.to];
    const lo = Math.min(s.layer, t.layer), hi = Math.max(s.layer, t.layer);
    const right = layers[s.layer].filter((it) => it.x > s.x).length, left = layers[s.layer].filter((it) => it.x < s.x).length;
    const side = right <= left ? 1 : -1;
    const k = lanes.filter((o) => o.side === side && o.lo <= hi && lo <= o.hi).length;
    lanes.push({ side, lo, hi });
    if (side === 1) t.chipLeft = true; // the loop comes in on the right, so the time chip moves to the left
    let edge = side === 1 ? -Infinity : Infinity;
    for (let l = lo; l <= hi; l++) for (const it of layers[l]) edge = side === 1 ? Math.max(edge, it.x + it.w / 2) : Math.min(edge, it.x - it.w / 2);
    const laneX = edge + side * (LANE_GAP + k * LANE_STEP);
    const sy = s.y + s.h / 2, ty = top[t.layer] - 12, tx = t.x + side * Math.round(t.w / 4);
    e.points = [{ x: s.x + side * s.w / 2, y: sy }, { x: laneX, y: sy }, { x: laneX, y: ty }, { x: tx, y: ty }, { x: tx, y: t.y }];
    labelPos.set(e, { x: laneX, y: (sy + ty) / 2 });
  }

  // 9. move everything so the drawing starts at (PAD, PAD).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x0, y0, x1, y1) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };
  for (const it of items.slice(0, n)) grow(it.x - it.w / 2, it.y - (it.at != null ? CHIP_OVER : 0), it.x + it.w / 2, it.y + it.h);
  for (const e of edges) for (const p of e.points) grow(p.x, p.y, p.x, p.y);
  for (const p of labelPos.values()) grow(p.x - 24, p.y - CHIP_H / 2, p.x + 24, p.y + CHIP_H / 2);
  const dx = PAD - minX, dy = PAD - minY;

  const nodes = items.slice(0, n).map((it) => ({
    id: it.id, x: Math.round(it.x - it.w / 2 + dx), y: Math.round(it.y + dy), w: it.w, h: it.h,
    lines: it.lines, kind: it.kind, who: it.who, at: it.at, label: it.label, chipLeft: !!it.chipLeft,
  }));
  return {
    nodes,
    edges: edges.map((e) => ({
      from: items[e.from].id, to: items[e.to].id, label: e.label, back: e.back,
      points: e.points.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) })),
      labelAt: labelPos.has(e) ? { x: Math.round(labelPos.get(e).x + dx), y: Math.round(labelPos.get(e).y + dy) } : undefined,
    })),
    width: Math.ceil(maxX - minX + 2 * PAD),
    height: Math.ceil(maxY - minY + 2 * PAD),
  };
}

// Drop repeated points and points in the middle of a straight run.
function tidy(pts) {
  const res = [];
  for (const p of pts) {
    const last = res[res.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    res.push(p);
  }
  return res.filter((p, i) => {
    const a = res[i - 1], b = res[i + 1];
    return !a || !b || !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

// ---------- drawing ----------
const el = (name, attrs = {}, text) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

// 75 -> "01:15", 3725 -> "1:02:05" (same as the transcript view)
const stamp = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (v) => String(v).padStart(2, '0');
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
};

// Rounded corners on an orthogonal polyline.
function pathD(pts, r = 9) {
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], p = pts[i], b = pts[i + 1];
    const l1 = Math.hypot(p.x - a.x, p.y - a.y), l2 = Math.hypot(b.x - p.x, b.y - p.y);
    const r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2);
    d += ` L${p.x - ((p.x - a.x) / l1) * r1} ${p.y - ((p.y - a.y) / l1) * r1}`;
    d += ` Q${p.x} ${p.y} ${p.x + ((b.x - p.x) / l2) * r2} ${p.y + ((b.y - p.y) / l2) * r2}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last.x} ${last.y}`;
}

let uid = 0;
export function renderProcess(process, { onSeek } = {}) {
  const { nodes, edges, width, height } = layoutProcess(process);
  const uniq = `pf${++uid}`; // marker ids must differ between charts on one page
  const first = nodes[0];
  const svg = el('svg', {
    xmlns: NS, class: 'pf-svg', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-labelledby': `${uniq}-title`,
  });
  svg.append(el('title', { id: `${uniq}-title` }, first
    ? `Process flow chart, ${nodes.length} ${nodes.length === 1 ? 'step' : 'steps'}, starting with: ${first.label}` : 'Process flow chart, no steps'));

  const defs = el('defs');
  for (const [name, cls] of [['arrow', 'pf-arrow'], ['arrow-back', 'pf-arrow pf-arrow-back']]) {
    const m = el('marker', { id: `${uniq}-${name}`, markerWidth: 10, markerHeight: 8, refX: 9, refY: 4, orient: 'auto', markerUnits: 'userSpaceOnUse' });
    m.append(el('path', { class: cls, d: 'M0 0.5 L10 4 L0 7.5 Z' }));
    defs.append(m);
  }
  const edgeLayer = el('g'), labelLayer = el('g'), nodeLayer = el('g');
  svg.append(defs, edgeLayer, labelLayer, nodeLayer);

  for (const e of edges) {
    edgeLayer.append(el('path', {
      class: e.back ? 'pf-edge pf-back' : 'pf-edge', d: pathD(e.points),
      'marker-end': `url(#${uniq}-${e.back ? 'arrow-back' : 'arrow'})`,
    }));
    if (e.label && e.labelAt) {
      const w = Math.ceil(defaultMeasure(e.label, EDGE_FONT)) + 16;
      const g = el('g', { class: e.back ? 'pf-elabel pf-back' : 'pf-elabel' });
      g.append(
        el('rect', { x: e.labelAt.x - w / 2, y: e.labelAt.y - CHIP_H / 2, width: w, height: CHIP_H, rx: CHIP_H / 2 }),
        el('text', { x: e.labelAt.x, y: e.labelAt.y + 4.5 }, e.label),
      );
      labelLayer.append(g);
    }
  }

  for (const n of nodes) {
    const g = el('g', { class: `pf-node pf-${n.kind}`, 'data-id': n.id });
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    if (n.kind === 'decision') {
      const pts = [[n.x, cy], [n.x + CUT, n.y], [n.x + n.w - CUT, n.y], [n.x + n.w, cy], [n.x + n.w - CUT, n.y + n.h], [n.x + CUT, n.y + n.h]];
      g.append(el('polygon', { class: 'pf-shape', points: pts.map((p) => p.join(',')).join(' '), 'stroke-linejoin': 'round' }));
    } else {
      g.append(el('rect', { class: 'pf-shape', x: n.x, y: n.y, width: n.w, height: n.h, rx: n.kind === 'step' ? 12 : n.h / 2 }));
    }
    const textH = n.lines.length * LINE_H + (n.who ? WHO_H : 0);
    const ty = n.y + (n.h - textH) / 2;
    n.lines.forEach((ln, i) => g.append(el('text', { class: 'pf-text', x: cx, y: ty + i * LINE_H + 14 }, ln)));
    if (n.who) g.append(el('text', { class: 'pf-who', x: cx, y: ty + n.lines.length * LINE_H + 13 }, n.who));
    if (n.at != null) {
      const label = stamp(n.at);
      const cw = label.length > 5 ? CHIP_W + 10 : CHIP_W;
      const right = n.kind === 'decision' ? CUT + 6 : n.kind === 'step' ? 16 : 20;
      const chip = el('g', { class: 'pf-chip' });
      const cl = n.chipLeft ? n.x + right : n.x + n.w - right - cw;
      chip.append(
        el('rect', { x: cl, y: n.y - CHIP_OVER, width: cw, height: CHIP_H, rx: CHIP_H / 2 }),
        el('text', { x: cl + cw / 2, y: n.y - CHIP_OVER + 12.5 }, label),
      );
      g.append(chip);
      if (onSeek) {
        g.classList.add('pf-seek');
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', `Jump to ${label}: ${n.label}`);
        g.addEventListener('click', () => onSeek(n.at));
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSeek(n.at); }
        });
      }
    }
    nodeLayer.append(g);
  }
  return { svg, width, height };
}

// Standalone copy for download: light palette written out in full, white page behind it.
const EXPORT_CSS = `.pf-svg text{font-family:"Instrument Sans","Noto Sans Tamil",system-ui,sans-serif;text-anchor:middle}
.pf-text{font-size:14px;font-weight:500;fill:#1f201d}.pf-who{font-size:12px;fill:#5f625e}
.pf-shape{stroke-width:1.25}
.pf-step .pf-shape{fill:#ffffff;stroke:#d3dcd5}
.pf-start .pf-shape{fill:#1f201d;stroke:#1f201d}.pf-start .pf-text{fill:#ffffff}.pf-start .pf-who{fill:#d6dbd7}
.pf-decision .pf-shape{fill:#d5e8e4;stroke:#1b6e66}
.pf-end .pf-shape{fill:#e8eee9;stroke:#bcc7bf}
.pf-chip rect{fill:#f6f9f6;stroke:#d3dcd5}.pf-chip text{font-size:11px;font-weight:600;fill:#5f625e}
.pf-edge{fill:none;stroke:#6f726e;stroke-width:1.5;stroke-linejoin:round}.pf-edge.pf-back{stroke:#1b6e66;stroke-dasharray:6 5}
.pf-arrow{fill:#6f726e}.pf-arrow.pf-arrow-back{fill:#1b6e66}
.pf-elabel rect{fill:#ffffff;stroke:#d3dcd5}.pf-elabel text{font-size:12px;font-weight:600;fill:#1f201d}.pf-elabel.pf-back text{fill:#1b6e66}`;

export function processToSvgString(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', NS);
  clone.querySelectorAll('[tabindex]').forEach((n) => n.removeAttribute('tabindex'));
  const doc = clone.ownerDocument;
  const style = doc.createElementNS(NS, 'style');
  style.textContent = EXPORT_CSS;
  const bg = doc.createElementNS(NS, 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#ffffff');
  const title = clone.querySelector('title');
  clone.insertBefore(style, title ? title.nextSibling : clone.firstChild);
  clone.insertBefore(bg, style.nextSibling);
  return new XMLSerializer().serializeToString(clone);
}
