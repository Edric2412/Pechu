// Light / dark theme. The choice is remembered; with no choice yet it follows the system setting.
import { store, save, reduceMotion } from './ui.js';

const root = document.documentElement;
const listeners = new Set();
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export const theme = () => root.dataset.theme === 'dark' ? 'dark' : 'light';
export const onTheme = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function apply(t, animate) {
  const swap = () => { root.dataset.theme = t; listeners.forEach((f) => f(t)); };
  // One GPU cross-fade of the whole page instead of animating every element's colours and shadows (that was the lag).
  if (animate && !reduceMotion() && document.startViewTransition) document.startViewTransition(swap);
  else swap();
}

export function setTheme(t) { save('pechu.theme', t); apply(t, true); }

// If the person has never chosen, follow the system when it changes.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!store('pechu.theme', null)) apply(systemDark() ? 'dark' : 'light', true);
});
