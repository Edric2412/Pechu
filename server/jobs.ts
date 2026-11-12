import { assertWithinLimit } from "./audio";
import { describeError, flowFromEnglish, friendlyError, generateNotes, notesFromEnglish, transcribeFile, validateNotes, type TranscribeMode } from "./gemini";
import { SARVAM_NAME, sarvamEnabled, transcribeWithSarvam } from "./sarvam";
import { ensureAudio, getMeeting, updateMeeting, type Meeting } from "./store";

// Meetings with a background job in progress, so the same job is never started twice.
const running = new Set<string>();
export const activeJobs = () => running.size; // the server waits for these on shutdown

const fail = (id: string, e: unknown) => {
  console.error(`[job ${id}]`, describeError(e));
  updateMeeting(id, { status: "error", error: friendlyError(e), progress: undefined });
};

async function writeNotes(id: string) {
  const m = getMeeting(id);
  if (!m) return;
  const { notes, transcriptEnglish } = await generateNotes(
    m.transcript,
    (progress) => updateMeeting(id, { progress }),
    (english) => updateMeeting(id, { transcriptEnglish: english }),
  );
  updateMeeting(id, { notes, transcriptEnglish, status: "ready", error: undefined, progress: undefined });
}

// Notes only, from the stored English transcript (no translation).
async function rewriteNotes(id: string) {
  const m = getMeeting(id);
  if (!m) return;
  const notes = await notesFromEnglish(m.transcriptEnglish ?? "", (progress) => updateMeeting(id, { progress }));
  updateMeeting(id, { notes, status: "ready", error: undefined, progress: undefined });
}

// Only the flow chart and the step-by-step chart; the rest of the notes stays.
async function redrawFlow(id: string) {
  const m = getMeeting(id);
  if (!m?.notes) return;
  const { flow, process } = await flowFromEnglish(m.transcriptEnglish ?? "", m.notes.title, (progress) => updateMeeting(id, { progress }));
  const { process: _old, ...rest } = m.notes;
  const notes = validateNotes({ ...rest, flow, ...(process ? { process } : {}) });
  updateMeeting(id, { notes, status: "ready", error: undefined, progress: undefined });
}

export function startNotes(id: string): Meeting | null {
  const m = getMeeting(id);
  if (!m || running.has(id)) return m;
  running.add(id);
  // A live recording is written up from its live captions. Listening to the saved audio again (Sarvam, which costs money)
  // only happens when the person asks for it: see retranscribe().
  const current = updateMeeting(id, { status: "writing-notes", error: undefined, progress: undefined });
  writeNotes(id)
    .catch((e) => fail(id, e))
    .finally(() => running.delete(id));
  return current;
}

// Runs a short background job on a meeting that already has its English transcript.
function startWriting(id: string, job: (id: string) => Promise<void>): Meeting | null {
  const m = getMeeting(id);
  if (!m || running.has(id)) return m;
  running.add(id);
  const current = updateMeeting(id, { status: "writing-notes", error: undefined, progress: undefined });
  job(id)
    .catch((e) => fail(id, e))
    .finally(() => running.delete(id));
  return current;
}

export const startNotesOnly = (id: string) => startWriting(id, rewriteNotes);
export const startFlow = (id: string) => startWriting(id, redrawFlow);

// Sarvam when its key is set (best for Tamil mixed with English, and it labels speakers); otherwise Gemini's file model.
async function transcribeAudio(path: string, mime: string, mode: TranscribeMode, onProgress: (note: string) => void) {
  if (sarvamEnabled()) {
    await assertWithinLimit(path); // over the limit: stop here with a clear message, nothing is sent to Sarvam
    const text = await transcribeWithSarvam(path, { mode: mode === "verbatim" ? "verbatim" : "codemix", speakers: mode === "speakers" }, onProgress);
    return { text, by: SARVAM_NAME };
  }
  return { text: await transcribeFile(path, mime, mode, onProgress), by: "Gemini 3.5 Transcribe" };
}

async function transcribeThenNotes(id: string, mode: TranscribeMode) {
  const m = getMeeting(id);
  const path = m ? await ensureAudio(m) : null;
  if (!m || !path || !m.audio) return;
  let result: { text: string; by: string };
  try {
    result = await transcribeAudio(path, m.audio.mime, mode, (progress) => updateMeeting(id, { progress }));
  } catch (e) {
    if (!m.transcript.trim()) throw e; // nothing to fall back on: the meeting shows the error
    // The meeting already has a transcript (and maybe notes): keep them, and tell the person why the new one was not made.
    console.error(`[job ${id}] new transcript failed:`, describeError(e));
    updateMeeting(id, { status: "ready", error: undefined, progress: undefined, refineError: friendlyError(e) });
    return;
  }
  const { text, by } = result;
  // a live recording keeps its live captions so they can still be read next to the new transcript
  const keepLive = m.source === "live" && !m.transcriptLive && m.transcript ? { transcriptLive: m.transcript } : {};
  // the old notes and English version describe the old transcript, so they go now that it is replaced
  updateMeeting(id, { ...keepLive, transcript: text, transcriber: by, notes: undefined, transcriptEnglish: undefined, status: "writing-notes", progress: undefined, refineError: undefined });
  await writeNotes(id);
}

// The meeting must already exist with status "transcribing" and its audio saved.
export function startUpload(id: string, mode: TranscribeMode): void {
  running.add(id);
  transcribeThenNotes(id, mode)
    .catch((e) => fail(id, e))
    .finally(() => running.delete(id));
}

// Transcribes the saved audio again (for example to add speaker labels, or after a failure), then rewrites the notes.
// Works for uploads and for live recordings; the new transcript replaces the old one.
export function retranscribe(id: string, mode: TranscribeMode = "smart"): Meeting | null {
  const m = getMeeting(id);
  if (!m || !m.audio || running.has(id)) return m;
  // the transcript, the notes and the English version stay until a new transcript is ready to replace them
  const current = updateMeeting(id, { status: "transcribing", error: undefined, progress: undefined, refineError: undefined });
  startUpload(id, mode);
  return current;
}
