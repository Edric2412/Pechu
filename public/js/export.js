// Exports: SVG -> PNG, file download, and printing the notes. Browser only at call time (no top-level DOM access).

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", "Noto Sans Tamil", Roboto, Arial, sans-serif';
const MAX_SIDE = 12000; // canvases bigger than this fail silently in some browsers

// Keep the scaled image under MAX_SIDE on its longest side.
export function fitScale(width, height, scale) {
  const longest = Math.max(width, height, 1);
  return Math.max(0.1, Math.min(scale, MAX_SIDE / longest));
}

// A standalone copy of an svg: xmlns, a size taken from the viewBox, a background rect and a system font fallback.
function standaloneSvg(svgEl, background) {
  const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const rect = svgEl.getBoundingClientRect?.() || { width: 0, height: 0 };
  const [x, y, width, height] = hasBox ? vb : [0, 0, rect.width || Number(svgEl.getAttribute('width')) || 0, rect.height || Number(svgEl.getAttribute('height')) || 0];
  if (!(width > 0 && height > 0)) throw new Error('The chart has no size, so it cannot be exported.');
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (!hasBox) clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.removeAttribute('style');
  if (!clone.hasAttribute('font-family')) clone.setAttribute('font-family', FONT_STACK);
  const bg = clone.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [k, v] of Object.entries({ x, y, width, height, fill: background })) bg.setAttribute(k, String(v));
  clone.insertBefore(bg, clone.firstChild);
  return { text: new XMLSerializer().serializeToString(clone), width, height };
}
const svgDataUrl = (text) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);

export async function svgToPngBlob(svgEl, { scale = 2, background = '#ffffff' } = {}) {
  let svg;
  try { svg = standaloneSvg(svgEl, background); } catch (e) { throw e instanceof Error ? e : new Error('The chart could not be read.'); }
  const s = fitScale(svg.width, svg.height, scale);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('The browser could not draw the chart as an image.'));
    img.src = svgDataUrl(svg.text);
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(svg.width * s);
  canvas.height = Math.round(svg.height * s);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot create the image.');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image came out empty. The chart may be too large.'))), 'image/png');
    } catch { reject(new Error('The image could not be saved (the chart contains content the browser blocks).')); }
  });
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Light colours, no shadows, and no editing controls. Appended after the app's own stylesheets inside the print frame.
const PRINT_CSS = `
:root { color-scheme: light; --ground: #fff; --surface: #fff; --raised: #fff; --well: #f1f3f1; --text: #111; --muted: #444; --faint: #555; --border: #cfd5d1; --rule: #dfe3e0; --control: #aab1ac; --accent: #14594f; --accent-pale: #e3f0ed; --field: #fff; --wash: transparent; --line: #cfd5d1; --line-strong: #aab1ac; --shadow-panel: none; --shadow-raised: none; --shadow-well: none; --shadow-press: none; }
html, body { background: #fff !important; color: #111; }
body { padding: 0; font-size: 12pt; line-height: 1.5; }
* { box-shadow: none !important; text-shadow: none !important; transition: none !important; animation: none !important; }
h1.print-title { font: 600 20pt/1.25 var(--font); margin: 0 0 14pt; }
.panel, .sv-card { border: 1px solid #cfd5d1; background: #fff !important; break-inside: avoid; page-break-inside: avoid; margin: 0 0 10pt; }
.sv-row { display: block !important; }
.sv-add, .sv-remove, .sv-at { display: none !important; }
.sv-text { background: none !important; }
.print-figure { break-inside: avoid; page-break-inside: avoid; margin: 12pt 0; }
.print-figure img { display: block; max-width: 100%; height: auto; }
@page { margin: 14mm; }
`;

function stylesheetNodes(doc) {
  return [...document.querySelectorAll('link[rel~="stylesheet"], style')].map((node) => {
    const copy = doc.importNode(node, true);
    if (copy.tagName === 'LINK') copy.href = node.href; // absolute, the frame has its own base
    return copy;
  });
}

// Opens the print dialog for the notes only (light theme). `extraSvgs` are drawn as images below the notes.
export async function printNotes(title, element, extraSvgs = []) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.append(frame);
  const remove = () => frame.remove();
  try {
    const win = frame.contentWindow;
    const doc = win.document;
    doc.open();
    doc.write('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>');
    doc.close();
    doc.title = title || 'Notes';

    const links = stylesheetNodes(doc);
    const pending = links.filter((l) => l.tagName === 'LINK').map((l) => new Promise((resolve) => { l.onload = l.onerror = resolve; setTimeout(resolve, 4000); }));
    links.forEach((l) => doc.head.append(l));
    const print = doc.createElement('style');
    print.textContent = PRINT_CSS;
    doc.head.append(print);

    const heading = doc.createElement('h1');
    heading.className = 'print-title';
    heading.textContent = title || 'Notes';
    const body = doc.importNode(element, true);
    body.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    doc.body.append(heading, body);
    for (const svg of extraSvgs) {
      if (!svg) continue;
      const { text, width, height } = standaloneSvg(svg, '#ffffff');
      const fig = doc.createElement('figure');
      fig.className = 'print-figure';
      const img = doc.createElement('img');
      img.alt = '';
      img.width = width;
      img.height = height;
      img.src = svgDataUrl(text);
      fig.append(img);
      doc.body.append(fig);
      pending.push(new Promise((resolve) => { img.onload = img.onerror = resolve; setTimeout(resolve, 4000); }));
    }
    await Promise.all(pending);
    win.addEventListener('afterprint', remove, { once: true });
    setTimeout(remove, 120000); // in case afterprint never fires
    win.focus();
    win.print();
  } catch (e) {
    remove();
    throw e instanceof Error ? e : new Error('Printing failed.');
  }
}
