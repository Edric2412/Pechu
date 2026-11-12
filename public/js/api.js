// Thin client for the Pechu server. Every call throws an Error with a readable message.

// Plain wording for a failed call. Cloudflare and other proxies answer with a web page, not JSON, so the status is all there is.
export function messageForStatus(status) {
  if (status === 413) return 'That file is too large. The limit is 100 MB.';
  if (status === 429) return 'Too many requests. Wait a minute and try again.';
  if (status >= 500) return 'Pechu could not be reached right now. Try again in a minute.';
  return `Something went wrong (${status}). Try again.`;
}
// A call that never got an answer (no internet, Pechu stopped).
const go = (url, init) => fetch(url, init).catch(() => { throw new Error('Could not reach Pechu. Check that it is running and your internet connection works.'); });

async function parse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && /sign in/i.test(body?.error || '')) window.dispatchEvent(new Event('pechu:signin'));
  if (!res.ok) throw new Error(body?.error || messageForStatus(res.status));
  return body;
}
const json = (method, url, data) => go(url, {
  method, headers: { 'content-type': 'application/json' }, body: data == null ? undefined : JSON.stringify(data),
}).then(parse);

export const api = {
  auth: () => go('/api/auth').then(parse),
  login: (password) => json('POST', '/api/login', { password }),
  logout: () => json('POST', '/api/logout'),
  status: () => go('/api/status').then(parse),
  saveKey: (key) => json('POST', '/api/key', { key }),
  meetings: () => go('/api/meetings').then(parse),
  meeting: (id) => go(`/api/meetings/${encodeURIComponent(id)}`).then(parse),
  createMeeting: (data) => json('POST', '/api/meetings', data),
  patchMeeting: (id, data) => json('PATCH', `/api/meetings/${encodeURIComponent(id)}`, data),
  deleteMeeting: (id) => json('DELETE', `/api/meetings/${encodeURIComponent(id)}`),
  putAudio: (id, blob) => go(`/api/meetings/${encodeURIComponent(id)}/audio`, {
    method: 'PUT', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob,
  }).then(parse),
  writeNotes: (id) => json('POST', `/api/meetings/${encodeURIComponent(id)}/notes`),
  // regenerate only the notes (no translation): used after a speaker is renamed
  writeNotesOnly: (id) => json('POST', `/api/meetings/${encodeURIComponent(id)}/notes?only=notes`),
  // regenerate only the flow charts
  redrawFlow: (id) => json('POST', `/api/meetings/${encodeURIComponent(id)}/flow`),
  transcribeAgain: (id, speakers = false) => json('POST', `/api/meetings/${encodeURIComponent(id)}/transcribe`, { speakers }),
  audioUrl: (id) => `/api/meetings/${encodeURIComponent(id)}/audio`,
  // XHR so we can show upload progress for large recordings.
  upload(file, { title, mode, speakers }, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('file', file);
      if (title) fd.append('title', title);
      fd.append('mode', mode || 'smart');
      fd.append('speakers', speakers ? '1' : '0');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onerror = () => reject(new Error('The upload was interrupted. Check that Pechu is still running.'));
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body?.error || messageForStatus(xhr.status)));
      };
      xhr.send(fd);
    });
  },
};
