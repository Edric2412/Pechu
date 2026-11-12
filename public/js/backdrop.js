// The page backdrop: a calm base, 3 large silk ribbons sweeping in from the top right, and a soft coral rim light.
// Everything is drawn once (inline SVG, blurred once); the only motion is a slow CSS transform on each layer.
// Colours come from the --bd-* custom properties in css/backdrop.css, so a theme switch needs no JS.
const NS = 'http://www.w3.org/2000/svg';
const W = 1600, H = 1000;

const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  n.append(...kids);
  return n;
};
const stop = (offset, color, opacity = 1) => el('stop', { offset, style: `stop-color:${color};stop-opacity:${opacity}` });
const grad = (id, [x1, y1, x2, y2], stops) =>
  el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1, y1, x2, y2 }, stops.map((s) => stop(...s)));
const blur = (id, sd) => el('filter', { id, filterUnits: 'userSpaceOnUse', x: -300, y: -300, width: W + 600, height: H + 600 },
  [el('feGaussianBlur', { stdDeviation: sd })]);

// Each ribbon: `top` is the crest (the lit upper edge, open path), `rest` closes the body back along its underside.
const RIBBONS = [
  { // back: broad, deep, quiet
    id: 'a', depth: 0.9, rimOp: 0.4, shift: 90,
    top: 'M1760,-140 C1330,-110 1190,170 960,320 C760,450 500,440 260,570 C130,640 20,720 -140,780',
    rest: 'C260,760 580,700 880,570 C1180,440 1460,400 1760,230 Z',
  },
  { // middle: the main silk, highest crest and the strongest light
    id: 'b', depth: 1, rimOp: 1, shift: 70,
    top: 'M1760,-230 C1500,-180 1260,-30 1070,150 C910,300 720,390 480,350 C330,285 170,380 -80,560',
    rest: 'C220,560 500,470 780,420 C1080,375 1420,230 1760,40 Z',
  },
  { // front: a pale translucent fold that carries the light down towards the middle
    id: 'c', depth: 0.7, rimOp: 0.5, shift: 60,
    top: 'M1760,230 C1500,260 1330,500 1100,620 C900,720 650,720 450,820 C330,880 220,940 140,1010',
    rest: 'C560,960 900,890 1180,770 C1430,665 1580,500 1760,440 Z',
  },
];

function ribbonSvg({ id, depth, rimOp, shift, top, rest }) {
  const dir = [1700, 0, 300, 700]; // the flow: strongest at the top right, fading down-left
  const across = [1000, 80, 1150, 700]; // across the ribbon, crest to underside
  const defs = el('defs', {}, [
    blur(`bd-soft-${id}`, 4),
    blur(`bd-core-${id}`, 8),
    blur(`bd-glow-${id}`, 26),
    blur(`bd-wide-${id}`, 34),
    grad(`bd-body-${id}`, across, [
      [0, 'var(--bd-crest)', depth],
      [0.35, 'var(--bd-mid)', depth],
      [1, 'var(--bd-deep)', depth],
    ]),
    grad(`bd-rim-${id}`, dir, [
      [0, 'var(--bd-rim)', 0.35],
      [0.16, 'var(--bd-rim)', 1],
      [0.34, 'var(--bd-rim)', 0.4],
      [0.52, 'var(--bd-rim)', 0],
    ]),
    grad(`bd-sheen-${id}`, dir, [
      [0, 'var(--bd-sheen)', 1],
      [0.5, 'var(--bd-sheen)', 0.45],
      [1, 'var(--bd-sheen)', 0],
    ]),
  ]);
  const body = el('path', { d: `${top} ${rest}`, fill: `url(#bd-body-${id})`, filter: `url(#bd-soft-${id})` });
  // soft light bands that follow the crest (volumes of light, not lines)
  const sheen = el('path', {
    d: top, fill: 'none', stroke: `url(#bd-sheen-${id})`, 'stroke-width': 90, 'stroke-linecap': 'round',
    transform: `translate(0 ${shift})`, filter: `url(#bd-wide-${id})`, opacity: 0.8 * depth,
  });
  const rimWide = el('path', {
    d: top, fill: 'none', stroke: `url(#bd-rim-${id})`, 'stroke-width': 70, 'stroke-linecap': 'round',
    transform: 'translate(0 20)', filter: `url(#bd-glow-${id})`, opacity: 0.7 * rimOp, class: 'bd-fine',
  });
  const rimCore = el('path', {
    d: top, fill: 'none', stroke: `url(#bd-rim-${id})`, 'stroke-width': 22, 'stroke-linecap': 'round',
    transform: 'translate(0 10)', filter: `url(#bd-core-${id})`, opacity: 0.95 * rimOp, class: 'bd-fine',
  });
  return el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMaxYMin slice', focusable: 'false' }, [defs, body, sheen, el('g', { class: 'bd-rimg' }, [rimWide, rimCore])]);
}

export function mountBackdrop() {
  if (document.getElementById('backdrop')) return;
  const root = document.createElement('div');
  root.id = 'backdrop';
  root.className = 'backdrop';
  root.setAttribute('aria-hidden', 'true');
  for (const r of RIBBONS) {
    const layer = document.createElement('div');
    layer.className = `bd-layer bd-${r.id}`;
    layer.append(ribbonSvg(r));
    root.append(layer);
  }
  const veil = document.createElement('div'); // calms the area behind the panels so their text keeps its contrast
  veil.className = 'bd-veil';
  const grain = document.createElement('div');
  grain.className = 'bd-grain';
  root.append(veil, grain);
  document.body.prepend(root);
}
