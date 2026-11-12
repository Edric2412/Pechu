// The voice wave. Four soft, overlapping ribbons (teal in the body, blending to coral at the right end)
// with a brighter core line. Their heights follow the loudness of the audio: low voices drive the first,
// mid the second, high the third. Louder sound makes taller ribbons; a whisper makes small ripples;
// silence settles to a gentle breathing ripple.
import { reduceMotion } from './ui.js';

const hex = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  const r = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c);
  return r ? [+r[1], +r[2], +r[3]] : [128, 150, 140];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function createWave(canvas, { onLevel } = {}) {
  const ctx = canvas.getContext('2d');
  let analyser = null, bins = null, raf = 0, last = 0;
  let w = 0, h = 0, dpr = 1;
  const lvl = [0, 0, 0];     // smoothed band levels, 0..1
  let loud = 0;              // smoothed overall level, 0..1
  let live = 0;              // 0 = idle, muted; 1 = recording, full colour (eased)
  let liveTarget = 0;
  // colours come from the theme, and are read again whenever the theme switches
  let accent = hex('#287f75'), coral = hex('#b86f62'), idle = hex('#8fa39a'), dark = false;
  const readColors = () => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    accent = hex(css.getPropertyValue('--accent') || '#287f75');
    coral = hex(css.getPropertyValue('--coral') || '#b86f62');
    idle = hex(css.getPropertyValue('--wave-idle') || '#8fa39a');
    dark = root.dataset.theme === 'dark';
  };
  readColors();
  const themeWatch = new MutationObserver(readColors);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const ro = new ResizeObserver(() => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pts = Math.max(2, Math.ceil(w / STEP) + 1);
    ys = RIBBONS.map(() => new Float32Array(pts));
  });
  ro.observe(canvas);

  // Loudness comes from the signal's actual strength (RMS in decibels), which grows smoothly from a
  // whisper to a shout. The frequency bands only decide how the energy is shared between the ribbons.
  const DB_FLOOR = -60, DB_CEIL = -6;
  let wavBuf = null;
  function bands() {
    if (!analyser) return [0, 0, 0];
    analyser.getFloatTimeDomainData(wavBuf);
    let sum = 0;
    for (let i = 0; i < wavBuf.length; i++) sum += wavBuf[i] * wavBuf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / wavBuf.length) + 1e-6);
    const level = Math.min(1, Math.max(0, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
    analyser.getByteFrequencyData(bins);
    const hz = analyser.context.sampleRate / analyser.fftSize; // Hz per bin
    const avg = (lo, hi) => {
      const a = Math.max(1, Math.floor(lo / hz)), b = Math.min(bins.length - 1, Math.ceil(hi / hz));
      let s = 0; for (let i = a; i <= b; i++) s += bins[i];
      return s / ((b - a + 1) * 255);
    };
    const e = [avg(80, 400), avg(400, 2000), avg(2000, 6000)];
    const top = Math.max(...e, 1e-6);
    return e.map((v) => level * (0.55 + 0.45 * (v / top)));
  }

  // band: which smoothed level drives the ribbon; gain: its share of the full height
  const RIBBONS = [
    { f: 1.5, speed: 0.9, band: 0, gain: 1, phase: 0 },
    { f: 2.2, speed: -1.3, band: 1, gain: 0.82, phase: 1.7 },
    { f: 2.9, speed: 1.7, band: 1, gain: 0.62, phase: 3.1 },
    { f: 3.8, speed: -2.1, band: 2, gain: 0.45, phase: 4.6 },
  ];
  const STEP = 4;
  let pts = 0, ys = [];

  function trace(a, b) { // closed shape between ribbon a and ribbon b
    ctx.beginPath();
    for (let i = 0; i < pts; i++) i ? ctx.lineTo(i * STEP, ys[a][i]) : ctx.moveTo(0, ys[a][0]);
    for (let i = pts - 1; i >= 0; i--) ctx.lineTo(i * STEP, ys[b][i]);
    ctx.closePath();
  }
  function line(a) {
    ctx.beginPath();
    for (let i = 0; i < pts; i++) i ? ctx.lineTo(i * STEP, ys[a][i]) : ctx.moveTo(0, ys[a][0]);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const target = bands();
    const idleBreath = reduceMotion() ? 0.3 : 0.32 + 0.06 * Math.sin(now / 1500);
    for (let i = 0; i < 3; i++) {
      const t = Math.max(target[i], liveTarget ? 0.03 : idleBreath);
      lvl[i] += (t - lvl[i]) * (t > lvl[i] ? 0.2 : 0.035); // quick-ish attack, slow release
    }
    const overall = (lvl[0] * 0.5 + lvl[1] * 0.35 + lvl[2] * 0.15);
    loud += (overall - loud) * 0.18;
    live += (liveTarget - live) * 0.05;
    onLevel?.(liveTarget ? loud : loud * live);

    ctx.clearRect(0, 0, w, h);
    if (!w || !h) return;
    const mid = h / 2, maxAmp = h * 0.44;
    const still = reduceMotion() && !liveTarget; // reduce-motion: no idle drift, levels are still shown
    RIBBONS.forEach((r, i) => {
      if (!still) r.phase += dt * r.speed * (0.7 + loud * 2.4);
      const amp = Math.max(1.5, maxAmp * r.gain * Math.pow(lvl[r.band], 0.9));
      for (let k = 0; k < pts; k++) {
        const u = Math.min(1, (k * STEP) / w);
        const env = Math.pow(Math.sin(Math.PI * u), 1.8); // taper to zero at both sides
        ys[i][k] = mid + Math.sin(u * Math.PI * 2 * r.f + r.phase) * amp * env;
      }
    });

    // colours: muted while idle, full teal and coral while listening
    const body = mix(idle, accent, 0.7 + 0.3 * live);
    const tip = mix(idle, coral, 0.7 + 0.3 * live);
    const core = dark ? [mix(body, [255, 255, 255], 0.35), mix(tip, [255, 255, 255], 0.3)] : [body, tip];
    const grad = (a, b, alpha) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, rgb(a, alpha)); g.addColorStop(0.55, rgb(a, alpha));
      g.addColorStop(0.86, rgb(b, alpha)); g.addColorStop(1, rgb(b, alpha));
      return g;
    };
    const gBody = grad(body, tip, 1), gCore = grad(core[0], core[1], 1);
    const strong = dark ? 1 : 1.25;      // light backgrounds need stronger colour to stay visible
    const boost = 0.6 + 0.4 * live;
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // faint body between neighbouring ribbons
    ctx.fillStyle = gBody;
    for (let i = 0; i < RIBBONS.length - 1; i++) {
      ctx.globalAlpha = (dark ? 0.15 : 0.2) * boost;
      trace(i, i + 1); ctx.fill();
    }
    // glow, then the ribbon line
    ctx.strokeStyle = gBody;
    for (let i = RIBBONS.length - 1; i >= 0; i--) {
      const fade = 1 - i * 0.16;
      line(i);
      ctx.lineWidth = 10; ctx.globalAlpha = 0.09 * strong * fade * boost; ctx.stroke();
      ctx.lineWidth = 4; ctx.globalAlpha = 0.14 * strong * fade * boost; ctx.stroke();
      ctx.lineWidth = i === 0 ? 1.8 : 1.2; ctx.globalAlpha = Math.min(1, (i === 0 ? 0.75 : 0.5) * strong * fade) * boost; ctx.stroke();
    }
    // bright core on the main ribbon
    ctx.strokeStyle = gCore; line(0);
    ctx.lineWidth = 1.1; ctx.globalAlpha = Math.min(1, 0.9 * boost + 0.1); ctx.stroke();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  return {
    setAnalyser(a) {
      analyser = a || null;
      bins = a ? new Uint8Array(a.frequencyBinCount) : null;
      wavBuf = a ? new Float32Array(a.fftSize) : null;
      liveTarget = a ? 1 : 0;
    },
    start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } },
    destroy() { cancelAnimationFrame(raf); raf = 0; ro.disconnect(); themeWatch.disconnect(); },
  };
}
