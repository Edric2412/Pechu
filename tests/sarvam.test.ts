import { expect, test } from "bun:test";
import { parseSarvamOutput } from "../server/sarvam";

const timestamps = {
  chunks: ["Hello everyone.", "Let's start.", "First topic is budget.", "It grew.", "After a pause.", "Much later on.", "And a long one."],
  start_time_seconds: [0.2, 3.5, 10, 28, 31.5, 70, 3725],
  end_time_seconds: [3.0, 9.8, 27.5, 31, 33, 72, 3730],
};

test("with speakers, the diarized entries become timed speaker turns", () => {
  const out = {
    transcript: "plain",
    timestamps,
    diarized_transcript: { entries: [
      { transcript: "Hi.", speaker_id: "0", start_time_seconds: 1.2, end_time_seconds: 2 },
      { transcript: "Hello.", speaker_id: "1", start_time_seconds: 4.9, end_time_seconds: 6 },
    ] },
  };
  expect(parseSarvamOutput(out, { speakers: true })).toBe("[00:01] Speaker 1: Hi.\n\n[00:04] Speaker 2: Hello.");
});

test("without speakers, chunks are grouped into paragraphs of about 30 seconds", () => {
  const text = parseSarvamOutput({ transcript: "plain", timestamps }, { speakers: false });
  const paras = text.split("\n\n");
  expect(paras[0]).toBe("[00:00] Hello everyone. Let's start. First topic is budget. It grew."); // 28 s: still inside 30 s of 0.2
  expect(paras[1]).toBe("[00:31] After a pause.");
  expect(paras[2]).toBe("[01:10] Much later on.");
  expect(paras[3]).toBe("[1:02:05] And a long one."); // > 1 hour
  expect(paras.length).toBe(4);
});

test("a pause of 2 seconds or more starts a new paragraph", () => {
  const ts = { chunks: ["One.", "Two.", "Three."], start_time_seconds: [0, 3, 5.5], end_time_seconds: [2.5, 5, 7] };
  // 3 - 2.5 = 0.5 s gap (same paragraph); 5.5 - 5 = 0.5 s gap (same paragraph)
  expect(parseSarvamOutput({ timestamps: ts }, { speakers: false })).toBe("[00:00] One. Two. Three.");
  const gap = { chunks: ["One.", "Two."], start_time_seconds: [0, 5], end_time_seconds: [2, 6] };
  expect(parseSarvamOutput({ timestamps: gap }, { speakers: false })).toBe("[00:00] One.\n\n[00:05] Two.");
});

test("missing or unusable timestamps fall back to the plain transcript", () => {
  expect(parseSarvamOutput({ transcript: "  just text  " }, { speakers: false })).toBe("just text");
  expect(parseSarvamOutput({ transcript: "just text", timestamps: {} }, { speakers: false })).toBe("just text");
  expect(parseSarvamOutput({ transcript: "just text", timestamps: { chunks: ["a"] } }, { speakers: true })).toBe("just text");
  expect(parseSarvamOutput({}, { speakers: false })).toBe("");
  expect(parseSarvamOutput(null, { speakers: true })).toBe("");
});

test("speakers wanted but no diarized entries: timed paragraphs are used", () => {
  const out = { timestamps: { chunks: ["Hi."], start_time_seconds: [4], end_time_seconds: [5] }, diarized_transcript: { entries: [] } };
  expect(parseSarvamOutput(out, { speakers: true })).toBe("[00:04] Hi.");
});

test("the text array may be called words instead of chunks", () => {
  const ts = { words: ["One.", "Two."], start_time_seconds: [0.4, 12.8], end_time_seconds: [12, 20] };
  expect(parseSarvamOutput({ timestamps: ts }, { speakers: false })).toBe("[00:00] One. Two.");
});
