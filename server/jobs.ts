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

// After a live call, listen to the saved recording again with the better transcriber, then write the notes from that.
// If that fails, the live captions are kept and the notes are written from them.
async function refineThenNotes(id: string) {
  const m = getMeeting(id);
  const path = m ? await ensureAudio(m) : null;
  if (m && path && m.audio) {
    try {
      const { text, by } = await transcribeAudio(path, m.audio.mime, "speakers", (progress) => updateMeeting(id, { progress }));
      updateMeeting(id, { transcriptLive: m.transcript, transcript: text, transcriber: by, refineError: undefined });
    } catch (e) {
      console.error(`[job ${id}] second pass skipped:`, describeError(e));
      updateMeeting(id, { refineError: friendlyError(e) });
    }
  }
  updateMeeting(id, { status: "writing-notes", progress: undefined });
  await writeNotes(id);
}

export function startNotes(id: string): Meeting | null {
  const m = getMeeting(id);
  if (!m || running.has(id)) return m;
  running.add(id);
  const refine = m.source === "live" && !!m.audio && sarvamEnabled() && !m.transcriptLive;
  const current = updateMeeting(id, { status: refine ? "transcribing" : "writing-notes", error: undefined, progress: undefined });
  (refine ? refineThenNotes(id) : writeNotes(id))
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
  const { text, by } = await transcribeAudio(path, m.audio.mime, mode, (progress) => updateMeeting(id, { progress }));
  // a live recording keeps its live captions so they can still be read next to the new transcript
  const keepLive = m.source === "live" && !m.transcriptLive && m.transcript ? { transcriptLive: m.transcript } : {};
  updateMeeting(id, { ...keepLive, transcript: text, transcriber: by, status: "writing-notes", progress: undefined, refineError: undefined });
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
  const current = updateMeeting(id, {
    status: "transcribing", error: undefined, progress: undefined, notes: undefined, transcriptEnglish: undefined,
  });
  startUpload(id, mode);
  return current;
}
