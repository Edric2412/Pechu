// Small pure helpers for long transcripts and speaker turns.

// --- time stamps: a turn can start with "[mm:ss]" (or "[h:mm:ss]" from one hour on) ---

export function fmtStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `[${h}:${String(m).padStart(2, "0")}:${ss}]` : `[${String(m).padStart(2, "0")}:${ss}]`;
}

const STAMP = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s+/;

// "[01:05] Speaker 1: Hi" -> { at: 65, rest: "Speaker 1: Hi" }; null when the line has no stamp.
export function parseStamp(line: string): { at: number; rest: string } | null {
  const m = STAMP.exec(line);
  if (!m) return null;
  return { at: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), rest: line.slice(m[0].length) };
}

// Removes the stamp from the start of every paragraph (a paragraph is a line here).
export function stripStamps(text: string): string {
  return text.split("\n").map((l) => l.replace(STAMP, "")).join("\n");
}

// Splits text into pieces of at most `max` characters, breaking at paragraph ends first, then sentence ends,
// then spaces. Used so a long transcript is translated in parts instead of in one very long request.
export function chunkText(text: string, max = 10000): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const units: string[] = [];
  for (const para of clean.split(/\n+/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= max) units.push(para);
    else units.push(...splitLong(para, max));
  }
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > max) { out.push(cur); cur = u; }
    else cur = cur ? `${cur}\n\n${u}` : u;
  }
  if (cur) out.push(cur);
  return out;
}

function splitLong(paragraph: string, max: number): string[] {
  const pieces: string[] = [];
  let cur = "";
  const push = (s: string) => {
    if (cur && cur.length + s.length + 1 > max) { pieces.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  };
  for (const sentence of paragraph.split(/(?<=[.?!।])\s+/)) {
    if (sentence.length <= max) { push(sentence); continue; }
    const words = sentence.split(/\s+/);
    // never leave a lone "[mm:ss]" at the end of a piece: glue it to the word after it
    if (words.length > 1 && STAMP.test(`${words[0]} `) && words[0]!.length + words[1]!.length < max) words.splice(0, 2, `${words[0]} ${words[1]}`);
    for (const word of words) push(word); // no punctuation at all: break at spaces
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// --- speakers ---

export type Word = { text?: string; speaker?: string };

// Google tags words "spk_1", "spk_2"... Show them as "Speaker 1", "Speaker 2".
export function speakerLabel(raw?: string): string {
  const n = /(\d+)/.exec(raw ?? "");
  return n ? `Speaker ${n[1]}` : raw?.trim() || "Speaker 1";
}

// Builds "Speaker 1: ...\n\nSpeaker 2: ..." from Google's word list, starting a new turn whenever the speaker changes.
// Returns "" when no word carries a speaker (the caller then uses the plain text).
export function turnsFromWords(words: Word[]): string {
  if (!words.some((w) => w.speaker)) return "";
  const lines: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (current && buf.length) lines.push(`${current}: ${buf.join(" ")}`); buf = []; };
  for (const w of words) {
    const t = (w.text ?? "").trim();
    if (!t) continue;
    const label = speakerLabel(w.speaker);
    if (label !== current) { flush(); current = label; }
    buf.push(t);
  }
  flush();
  return lines.join("\n\n");
}

// The word-level annotations live under steps[].content[].annotations in Google's response.
export function extractWords(response: any): Word[] {
  const words: Word[] = [];
  for (const step of response?.steps ?? [])
    for (const content of step?.content ?? [])
      for (const a of content?.annotations ?? [])
        if (a?.type === "word_info") words.push({ text: a.text, speaker: a.speaker });
  return words;
}

// Sarvam returns diarized entries like { transcript, speaker_id: "0", start_time_seconds } one sentence at a time. Speakers are
// numbered in the order they first speak (Speaker 1, Speaker 2...), and neighbouring sentences by the same speaker become one
// turn. When entries carry times, each turn starts with the stamp of its first entry.
export type SpeakerEntry = { transcript?: string; speaker_id?: string | number; start_time_seconds?: number };

export function turnsFromEntries(entries?: SpeakerEntry[]): string {
  if (!entries?.length) return "";
  const order = new Map<string, number>();
  const lines: string[] = [];
  let current: string | null = null;
  let start: number | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (current && buf.length) lines.push(`${start === undefined ? "" : `${fmtStamp(start)} `}${current}: ${buf.join(" ")}`);
    buf = [];
  };
  for (const e of entries) {
    const t = (e.transcript ?? "").trim();
    if (!t) continue;
    const id = String(e.speaker_id ?? "0");
    if (!order.has(id)) order.set(id, order.size + 1);
    const label = `Speaker ${order.get(id)}`;
    if (label !== current) {
      flush(); current = label;
      start = typeof e.start_time_seconds === "number" && Number.isFinite(e.start_time_seconds) ? e.start_time_seconds : undefined;
    }
    buf.push(t);
  }
  flush();
  return lines.join("\n\n");
}
