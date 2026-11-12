// First-run gate: asks for the Gemini API key. The server checks it with Google and saves it to .env.
import { h, brandMark, icon } from '../ui.js';
import { api } from '../api.js';
import { state, refreshStatus } from '../store.js';

export function setupPage({ navigate }) {
  const connected = !!state.status?.hasKey;
  const input = h('input', {
    class: 'input', id: 'key', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Paste your key here', 'aria-describedby': 'key-help',
  });
  const errBox = h('div', { class: 'notice err', hidden: true, role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, connected ? 'Replace key' : 'Save and continue');

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      if (!key) { show('Paste a key first.'); return; }
      errBox.hidden = true;
      submit.disabled = true;
      submit.replaceChildren(h('span', { class: 'spinner' }), 'Checking with Google');
      try {
        await api.saveKey(key);
        await refreshStatus();
        input.value = '';
        navigate('#/');
      } catch (err) {
        show(err.message);
        submit.disabled = false;
        submit.replaceChildren(connected ? 'Replace key' : 'Save and continue');
      }
    },
  },
  h('div', { class: 'field' },
    h('label', { for: 'key' }, 'Gemini API key'),
    input,
    h('p', { class: 'hint', id: 'key-help' }, 'Saved only in the .env file inside the Pechu folder on this computer. It never reaches the browser.')),
  errBox,
  h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
    submit,
    h('a', { class: 'link', href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener noreferrer' }, 'Get a key in Google AI Studio'),
    connected ? h('a', { class: 'link', href: '#/' }, 'Cancel') : null));

  function show(msg) {
    errBox.hidden = false;
    errBox.replaceChildren(icon('alert'), msg);
  }

  return {
    el: h('div', { class: 'gate' },
      h('div', { class: 'gate-card' },
        h('div', { class: 'brand' }, brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'Pechu'), h('div', { class: 'brand-scope' }, 'Meeting notes in Tamil and English'))),
        h('header', { class: 'head home' },
          h('h1', { class: 'greeting' }, connected ? 'Your key is connected.' : 'Connect Gemini to begin.'),
          h('p', { class: 'greeting-sub' }, connected
            ? 'You can paste a new key below if you want to replace it.'
            : 'Pechu sends your meeting audio to Google’s Gemini models to turn it into text. It needs your own API key to do that.')),
        form)),
    bare: true,
    focus: () => input.focus(),
  };
}
