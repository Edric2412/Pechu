// Sign-in screen, shown only when the server has a password set (PECHU_PASSWORD).
import { h, brandMark, icon } from '../ui.js';
import { api } from '../api.js';

export function loginPage({ onDone }) {
  const input = h('input', { class: 'input', id: 'pw', type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password' });
  const errBox = h('div', { class: 'notice err', hidden: true, role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value) return;
      errBox.hidden = true; submit.disabled = true;
      try { await api.login(input.value); input.value = ''; onDone(); }
      catch (err) { errBox.hidden = false; errBox.replaceChildren(icon('alert'), err.message); submit.disabled = false; input.select(); }
    },
  }, h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), input), errBox, h('div', null, submit));
  return {
    el: h('div', { class: 'gate' },
      h('div', { class: 'gate-card' },
        h('div', { class: 'brand' }, brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'Pechu'), h('div', { class: 'brand-scope' }, 'Meeting notes in Tamil and English'))),
        h('header', { class: 'head home' }, h('h1', { class: 'greeting' }, 'Welcome back.'), h('p', { class: 'greeting-sub' }, 'Enter the password to open your meetings.')),
        form)),
    bare: true,
    focus: () => input.focus(),
  };
}
