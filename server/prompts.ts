const WHO = `The transcript may have turns that start with a time stamp such as "[01:15]" and a speaker label such as "Speaker 2:" or a person's name. Use the labels to say who said or owns something (for example "Ravi will deploy the build"). Never guess who a "Speaker N" is; if only "Speaker 2" is known, write "Speaker 2".`;

const AT = `Time stamps ("at"): when the transcript has [mm:ss] or [h:mm:ss] stamps, give each item an integer "at" = the stamp of the turn it comes from, in seconds ([01:15] is 75, [1:02:05] is 3725). Give "at" ONLY when the transcript has stamps; otherwise leave "at" out everywhere. Never invent a stamp.`;

const FLOW = `a tree for a flow chart of the topics of the meeting.
   - The root node has kind "root" and its label is the meeting title.
   - Its children are the topics discussed (about 3 to 7), each with kind "topic".
   - The children of a topic are the points ("point"), decisions ("decision") and actions ("action") that belong to that topic.
   - Keep labels short (under 12 words). The tree is at most 4 levels deep. Give each node "at" when the rules allow it.`;

const PROCESS = `process: the step-by-step flow chart of a sequence the speakers describe (a procedure, a pipeline, a plan, a "first this, then that").
   - "steps" is a flat list in reading order; the first step has kind "start". Each step has a short unique "id" (s1, s2, ...), a "label" (under 12 words), a "kind" ("start", "step", "decision" or "end"), "who" (only when the transcript says who does it), "at", and "next".
   - "next" lists the arrows that leave the step: each has "to" (the id of another step) and optionally "label". A normal step has one arrow. A "decision" step is a question and has two or more arrows labelled like "Yes" / "No" or with the answer. An "end" step has no arrows. A step may point back to an earlier step when the speakers describe a retry or a loop.
   - Use 3 to 30 steps. If the meeting describes no real sequence, leave "process" out. Do not turn a plain list of topics into a process.`;

const RULES = `Rules:
- Use only facts that are in the transcript. Never invent names, numbers, dates or decisions.
- Write everything in English, even when the transcript is Tamil.
- Names of people, places and companies keep their normal English spelling.`;

export const NOTES_PROMPT = `You write meeting notes from a transcript.
The transcript below is already in English. ${WHO}

Produce one JSON object with these parts:

1. title: a title for the meeting, at most 8 words.
2. summary: one short plain-English paragraph, at most 120 words.
3. sections: the fuller summary, as sections that each have a "heading" and a list of "bullets" (each bullet has "text" and maybe "at"). A section is one topic or phase of the meeting, with 2 to 6 bullets that say what was discussed, with the facts, numbers and names. Say who said or owns what. How many sections: 1 to 3 for a short meeting (up to about 3 minutes, roughly 400 words of speech), 3 to 8 for a long one.
4. keyPoints: 3 to 8 short plain-English points (each with "text" and maybe "at").
5. decisions: decisions that were actually made (each with "text", maybe "at", and "who" only when the transcript says who decided). Use an empty list if there were none.
6. actions: follow-up tasks. For each one give "task". Give "owner" and "due" ONLY when the transcript clearly states them; otherwise leave them out. Give "at" when the rules allow it. Use an empty list if there were none.
7. flow: ${FLOW}
8. ${PROCESS}

${AT}

${RULES}`;

// Used when only the flow chart and the process are redone.
export const FLOW_PROMPT = `You draw flow charts of a meeting from a transcript.
The transcript below is already in English. ${WHO}

Produce one JSON object with these parts:

1. flow: ${FLOW}
2. ${PROCESS}

${AT}

${RULES}`;

// Long meetings: each part is written up as a plain-text draft first, then the drafts are turned into the notes.
export const PART_PROMPT = `You take detailed notes on one part of a longer meeting, so that nothing important is lost when the parts are put together later.
The text is already in English. ${WHO}

Write plain text (no JSON, no markdown headings), 300 to 600 words. Start every line with the [mm:ss] stamp of the turn it comes from (use the [h:mm:ss] form from one hour on), but only when the text has stamps. Cover, in order:
- what was discussed, with the facts, numbers, names and dates, and who said or owns what;
- decisions that were made (and who made them, if stated);
- follow-up tasks, with owner and due date only when stated;
- any step-by-step sequence the speakers describe: write each step in order, say who does it, and for a yes/no question say where each answer leads (this part may start or end in the middle of a sequence; say so).

Rules:
- Use only facts that are in the text. Never invent names, numbers, dates or decisions.
- Write in English. Names of people, places and companies keep their normal English spelling.`;

// Added to NOTES_PROMPT / FLOW_PROMPT when the model gets the drafts instead of the transcript.
export const DRAFTS_NOTE = `

IMPORTANT: this meeting was long, so instead of the transcript you receive detailed notes on each part, in order. Treat them as the transcript: they are the only source, and the stamps at the start of their lines are the time stamps. Merge the parts into ONE set of notes (do not write notes per part), join sequences that continue from one part into the next, and keep the specific facts.`;

export const TRANSLATE_PROMPT = `You translate part of a meeting transcript into clear English.
The meeting is mostly Tamil with English mixed in. The text may be in Tamil script, in Tanglish (Tamil written in English letters), in English, or a mix.

Rules:
- Translate ALL of it. Do not summarize, shorten, skip or merge anything. The English must cover everything that was said, so it should be about as long as the original.
- Remove only pure filler sounds (um, uh, haan, hmm) and stutters. Keep every statement, number, name and date.
- Keep English words and names as they are. Keep people, places and company names in their normal English spelling.
- Each paragraph (separated by a blank line) is one speaker's turn. It may start with a time stamp such as "[01:15]" or "[1:02:05]" and/or a speaker label such as "Speaker 1:" or a person's name followed by a colon. Copy that stamp and label exactly, character for character, at the start of the same paragraph, then the translation. Never translate, change or drop them, and never move them. Keep each turn as its own paragraph.
- If you split a long turn into several short paragraphs, only the first one carries the stamp and label.
- Do not add notes, headings or explanations. Output only the English text.`;
