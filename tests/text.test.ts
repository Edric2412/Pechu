import { expect, test } from "bun:test";
import { chunkText, extractWords, fmtStamp, parseStamp, speakerLabel, stripStamps, turnsFromEntries, turnsFromWords } from "../server/text";

test("short text stays in one piece", () => {
  expect(chunkText("hello there")).toEqual(["hello there"]);
  expect(chunkText("   ")).toEqual([]);
});

test("long text is split at paragraph and sentence ends, losing nothing", () => {
  const sentence = "This is one sentence about the release date. ";
  const text = (sentence.repeat(30) + "\n\n").repeat(4); // about 5,400 chars
  const parts = chunkText(text, 2000);
  expect(parts.length).toBeGreaterThan(2);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  expect(parts.reduce((n, p) => n + words(p), 0)).toBe(words(text));
});

test("one huge paragraph with no punctuation is broken at spaces", () => {
  const blob = "word ".repeat(1500).trim(); // 7,499 chars, no full stops
  const parts = chunkText(blob, 3000);
  expect(parts.length).toBe(3);
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(3000);
  expect(parts.join(" ").split(" ").length).toBe(1500);
});

test("Google's spk_N tags become Speaker N turns", () => {
  expect(speakerLabel("spk_2")).toBe("Speaker 2");
  expect(speakerLabel(undefined)).toBe("Speaker 1");
  const words = [
    { text: "Hello", speaker: "spk_1" }, { text: "everyone.", speaker: "spk_1" },
    { text: "வணக்கம்", speaker: "spk_2" }, { text: "sir", speaker: "spk_2" },
    { text: "Let's", speaker: "spk_1" }, { text: "start", speaker: "spk_1" },
  ];
  expect(turnsFromWords(words)).toBe("Speaker 1: Hello everyone.\n\nSpeaker 2: வணக்கம் sir\n\nSpeaker 1: Let's start");
});

test("no speaker tags means no turns (the caller uses the plain text)", () => {
  expect(turnsFromWords([{ text: "Hello" }, { text: "there" }])).toBe("");
  expect(turnsFromWords([])).toBe("");
});

test("extractWords finds word_info annotations in Google's response shape", () => {
  const response = { steps: [{ type: "model_output", content: [{ type: "text", text: "Hi", annotations: [
    { type: "word_info", text: "Hi", speaker: "spk_1", start_offset: "0.1s" }, { type: "other" },
  ] }] }] };
  expect(extractWords(response)).toEqual([{ text: "Hi", speaker: "spk_1" }]);
  expect(extractWords({})).toEqual([]);
});

test("Sarvam entries become numbered speaker turns, merging neighbouring sentences", () => {
  const entries = [
    { transcript: "Hello.", speaker_id: "1" }, { transcript: "How are you?", speaker_id: "1" },
    { transcript: "நல்லா இருக்கேன்.", speaker_id: "0" },
    { transcript: "  ", speaker_id: "0" },
    { transcript: "Good to hear.", speaker_id: 1 },
  ];
  // speakers are numbered in the order they first speak, whatever ids Sarvam used
  expect(turnsFromEntries(entries)).toBe("Speaker 1: Hello. How are you?\n\nSpeaker 2: நல்லா இருக்கேன்.\n\nSpeaker 1: Good to hear.");
  expect(turnsFromEntries([])).toBe("");
  expect(turnsFromEntries(undefined)).toBe("");
});

test("fmtStamp floors to whole seconds and switches to h:mm:ss from one hour", () => {
  expect(fmtStamp(0)).toBe("[00:00]");
  expect(fmtStamp(75.9)).toBe("[01:15]");
  expect(fmtStamp(3599)).toBe("[59:59]");
  expect(fmtStamp(3725)).toBe("[1:02:05]");
  expect(fmtStamp(36000)).toBe("[10:00:00]");
});

test("parseStamp and stripStamps round trip", () => {
  expect(parseStamp("[01:15] Speaker 2: hi")).toEqual({ at: 75, rest: "Speaker 2: hi" });
  expect(parseStamp("[1:02:05] hello")).toEqual({ at: 3725, rest: "hello" });
  expect(parseStamp("Speaker 2: hi")).toBeNull();
  expect(parseStamp("[01:15]")).toBeNull(); // a stamp needs text after it
  for (const at of [0, 59, 61, 3600, 7322]) expect(parseStamp(`${fmtStamp(at)} x`)?.at).toBe(at);
  const timed = "[00:05] Speaker 1: Hello\n\n[1:00:00] Speaker 2: Bye\n\nplain old paragraph";
  expect(stripStamps(timed)).toBe("Speaker 1: Hello\n\nSpeaker 2: Bye\n\nplain old paragraph");
  expect(stripStamps("no stamps here")).toBe("no stamps here");
});

test("Sarvam entries with times start each turn with the stamp of its first entry", () => {
  const entries = [
    { transcript: "Hello.", speaker_id: "1", start_time_seconds: 0.4 },
    { transcript: "How are you?", speaker_id: "1", start_time_seconds: 2.9 },
    { transcript: "Fine.", speaker_id: "0", start_time_seconds: 65.2 },
    { transcript: "Late one.", speaker_id: "1", start_time_seconds: 3725.8 },
  ];
  expect(turnsFromEntries(entries)).toBe("[00:00] Speaker 1: Hello. How are you?\n\n[01:05] Speaker 2: Fine.\n\n[1:02:05] Speaker 1: Late one.");
});

test("chunkText keeps every stamp with its text and splits timed transcripts between paragraphs", () => {
  const sentence = "This is one sentence about the release date. ";
  const para = (at: number) => `${fmtStamp(at)} Speaker 1: ${sentence.repeat(10).trim()}`;
  const text = [0, 30, 60, 90, 3600, 3630].map(para).join("\n\n");
  const parts = chunkText(text, 1200);
  expect(parts.length).toBeGreaterThan(1);
  for (const p of parts) {
    expect(p.length).toBeLessThanOrEqual(1200);
    for (const line of p.split("\n\n")) expect(parseStamp(line)).not.toBeNull(); // every paragraph still starts with its stamp
  }
  expect(parts.join("\n\n")).toBe(text);
  // a single over-long paragraph: the stamp stays attached to the words after it
  const long = `[00:10] ${"word ".repeat(1500).trim()}`;
  for (const p of chunkText(long, 3000)) expect(p).not.toMatch(/^\[00:10\]$/);
  expect(chunkText(long, 3000)[0]!.startsWith("[00:10] word")).toBe(true);
});
