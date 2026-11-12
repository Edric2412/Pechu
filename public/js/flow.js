// Draws the notes tree (root > topics > points / decisions / actions) as a left-to-right
// flow chart in SVG. Text is measured with canvas so boxes fit Tamil and English alike.

const NS = 'http://www.w3.org/2000/svg';
const FONT = '400 14px "Instrument Sans", "Noto Sans Tamil", system-ui, sans-serif';
const COL_W = 252, ROOT_W = 224, COL_GAP = 56, ROW_GAP = 10, PAD = 20, LINE_H = 19, PAD_X = 14, PAD_Y = 10, KIND_H = 16;
const KIND_LABEL = { decision: 'Decision', action: 'Action' };

const measure = (() => {
  const c = document.createElement('canvas').getContext('2d');
  return (text, font) => { c.font = font; return c.measureText(text).width; };
})();

function wrap(text, maxW, font) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (measure(test, font) <= maxW || !cur) cur = test;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function el(name, attrs = {}, text) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function build(node, depth) {
  const kind = node.kind || (depth === 0 ? 'root' : depth === 1 ? 'topic' : 'point');
  const w = depth === 0 ? ROOT_W : COL_W;
  const weight = kind === 'root' || kind === 'topic' ? '600' : '400';
  const font = FONT.replace('400', weight);
  const lines = wrap(node.label, w - PAD_X * 2, font);
  const hasKind = !!KIND_LABEL[kind];
  const h = PAD_Y * 2 + lines.length * LINE_H + (hasKind ? KIND_H : 0);
  const kids = (node.children || []).map((c) => build(c, depth + 1));
  return { kind, w, h, lines, hasKind, depth, kids, label: node.label };
}

const kidsHeight = (node) => node.kids.reduce((s, k) => s + k.sh, 0) + Math.max(0, node.kids.length - 1) * ROW_GAP;

// sh = the vertical room a node's whole subtree needs; each parent is centred on its children.
function layout(n, top) {
  (function measureTree(node) {
    node.kids.forEach(measureTree);
    node.sh = Math.max(node.h, kidsHeight(node));
  })(n);
  (function place(node, t) {
    node.y = t + (node.sh - node.h) / 2;
    let cursor = t + (node.sh - kidsHeight(node)) / 2;
    for (const k of node.kids) { place(k, cursor); cursor += k.sh + ROW_GAP; }
  })(n, top);
}

function xFor(depth) {
  return PAD + (depth === 0 ? 0 : ROOT_W + COL_GAP + (depth - 1) * (COL_W + COL_GAP));
}

export function renderFlow(tree) {
  const root = build(tree, 0);
  layout(root, PAD);
  let maxDepth = 0;
  (function walk(n) { maxDepth = Math.max(maxDepth, n.depth); n.kids.forEach(walk); })(root);
  const width = xFor(maxDepth) + (maxDepth === 0 ? ROOT_W : COL_W) + PAD;
  const height = root.sh + PAD * 2;

  const svg = el('svg', { xmlns: NS, viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': 'Flow chart of the meeting: ' + (tree.label || '') });
  const links = el('g'); const nodes = el('g');
  svg.append(links, nodes);

  (function draw(n) {
    const x = xFor(n.depth);
    for (const k of n.kids) {
      const x2 = xFor(k.depth);
      const y1 = n.y + n.h / 2, y2 = k.y + k.h / 2, mx = (x + n.w + x2) / 2;
      links.append(el('path', { class: 'flow-link', d: `M${x + n.w} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}` }));
    }
    const g = el('g', { class: `fn fn-${n.kind}` });
    g.append(el('rect', { x, y: n.y, width: n.w, height: n.h, rx: n.kind === 'root' ? 14 : 12 }));
    if (n.hasKind) g.append(el('rect', { class: 'edge', x, y: n.y + 8, width: 3, height: n.h - 16, rx: 1.5 }));
    let ty = n.y + PAD_Y;
    if (n.hasKind) { g.append(el('text', { class: 'k', x: x + PAD_X, y: ty + 11 }, KIND_LABEL[n.kind])); ty += KIND_H; }
    n.lines.forEach((ln, i) => g.append(el('text', { x: x + PAD_X, y: ty + 14 + i * LINE_H }, ln)));
    nodes.append(g);
    n.kids.forEach(draw);
  })(root);

  return { svg, width, height };
}

export function svgToString(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', NS);
  const css = `.fn text{font:400 14px "Instrument Sans","Noto Sans Tamil",sans-serif;fill:#1f201d}.fn .k{font-size:11px;fill:#5f625e}
.fn-root rect{fill:#1f201d}.fn-root text{fill:#fff;font-weight:600}.fn-topic rect{fill:#f5f7f5;stroke:#e6e9e6}.fn-topic text{font-weight:600}
.fn-point rect{fill:#fff;stroke:#e6e9e6}.fn-decision rect{fill:#e3efed;stroke:#bfd9d5}.fn-decision .edge{fill:#1b6e66}
.fn-action rect{fill:#fff;stroke:#1f201d}.fn-action .edge{fill:#1f201d}.flow-link{fill:none;stroke:#c9cfca;stroke-width:1.2}`;
  const style = document.createElementNS(NS, 'style');
  style.textContent = css;
  clone.prepend(style);
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#ffffff');
  clone.insertBefore(bg, style.nextSibling);
  return new XMLSerializer().serializeToString(clone);
}
