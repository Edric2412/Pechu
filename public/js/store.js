// Shared app state: Gemini key status and the meeting list. Pages subscribe to changes.
import { api } from './api.js';

export const state = { status: null, meetings: [], loaded: false };
const subs = new Set();
export const subscribeState = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const emit = () => subs.forEach((f) => f(state));

export async function refreshStatus() {
  state.status = await api.status();
  emit();
  return state.status;
}
export async function refreshMeetings() {
  try { state.meetings = await api.meetings(); } catch { /* keep the old list */ }
  state.loaded = true;
  emit();
  return state.meetings;
}
