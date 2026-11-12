// Smooth, inertial page scrolling with Lenis (vendored in /vendor). Skipped when the person prefers reduced motion.
import Lenis from '../vendor/lenis.mjs';
import { reduceMotion } from './ui.js';

let lenis = null;

export function mountSmoothScroll() {
  if (reduceMotion() || lenis) return;
  lenis = new Lenis({
    lerp: 0.1,
    wheelMultiplier: 1,
    // Inner scroll areas keep their own native scrolling.
    prevent: (node) => !!node.closest?.('.lines, .flow-scroll, .tabs, textarea, select, audio'),
  });
  const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
}

export function scrollToTop() {
  if (lenis) lenis.scrollTo(0, { immediate: true, force: true });
  else window.scrollTo({ top: 0 });
}
