import { expect, test } from "bun:test";
// @ts-ignore plain browser module
import { fmtAt, parseStamp, parseTurns, renameSpeakerInText, speakerNames } from "../public/js/transcript-view.js";

test("fmtAt: minutes below an hour, h:mm:ss from an hour", () => {
  expect(fmtAt(0)).toBe("00:00");
  expect(fmtAt(75)).toBe("01:15");
  expect(fmtAt(3599)).toBe("59:59");
  expect(fmtAt(3600)).toBe("1:00:00");
  expect(fmtAt(3725)).toBe("1:02:05");
  expect(fmtAt(75.9)).toBe("01:15");
  expect(fmtAt(-4)).toBe("00:00");
  expect(fmtAt(NaN)).toBe("00:00");
});

test("parseStamp reads mm:ss and h:mm:ss, rejects malformed stamps", () => {
  expect(parseStamp("[01:15] hello")).toEqual({ at: 75, rest: "hello" });
  expect(parseStamp("[1:02:05]  Speaker 1: hi")).toEqual({ at: 3725, rest: "Speaker 1: hi" });
  expect(parseStamp("[5:07] x")).toEqual({ at: 307, rest: "x" });
  expect(parseStamp("[1:2] x")).toBeNull();
  expect(parseStamp("[00:05]x")).toBeNull();
  expect(parseStamp("00:05 x")).toBeNull();
  expect(parseStamp("hello [00:05] x")).toBeNull();
  expect(parseStamp("")).toBeNull();
});

test("parseTurns: stamp and speaker", () => {
  const r = parseTurns("[00:03] Speaker 1: Hello\n[00:09] Speaker 2: வணக்கம்\n[01:20] Speaker 1: Bye");
  expect(r!.names).toEqual(["Speaker 1", "Speaker 2"]);
  expect(r!.turns).toEqual([
    { who: "Speaker 1", text: "Hello", at: 3 },
    { who: "Speaker 2", text: "வணக்கம்", at: 9 },
    { who: "Speaker 1", text: "Bye", at: 80 },
  ]);
});

test("parseTurns: blank-line separated paragraphs and hour stamps", () => {
  const r = parseTurns("[59:58] Ravi: a\n\n[1:00:02] Meena: b");
  expect(r!.turns.map((t: any) => t.at)).toEqual([3598, 3602]);
});

test("parseTurns: stamp only gives who '' and no names", () => {
  const r = parseTurns("[00:01] First thing\n[00:30] Second thing\n[01:00] Third thing");
  expect(r!.names).toEqual([]);
  expect(r!.turns).toEqual([
    { who: "", text: "First thing", at: 1 },
    { who: "", text: "Second thing", at: 30 },
    { who: "", text: "Third thing", at: 60 },
  ]);
});

test("parseTurns: speaker only (old format) has no `at`", () => {
  const r = parseTurns("Speaker 1: Hi\nSpeaker 2: Hello");
  expect(r!.names).toEqual(["Speaker 1", "Speaker 2"]);
  expect(r!.turns[0]).toEqual({ who: "Speaker 1", text: "Hi" });
  expect("at" in r!.turns[0]).toBe(false);
});

test("parseTurns: plain prose is null, even with a stray colon", () => {
  expect(parseTurns("Just some words.\nAnother line about nothing.\nAnd a third.")).toBeNull();
  expect(parseTurns("We agreed on one thing: ship it.\nNothing else.")).toBeNull();
});

test("parseTurns: unlabelled paragraphs belong to the previous speaker; stamps are kept", () => {
  const r = parseTurns("[00:01] Ravi: one\n[00:05] continued\n[00:09] Meena: two");
  expect(r!.turns.map((t: any) => t.who)).toEqual(["Ravi", "Ravi", "Meena"]);
  expect(r!.turns[1]).toEqual({ who: "Ravi", text: "continued", at: 5 });
});

test("parseTurns: mixed stamped and unstamped paragraphs", () => {
  const r = parseTurns("Speaker 1: old line\n[00:20] Speaker 2: new line");
  expect(r!.turns[0]).toEqual({ who: "Speaker 1", text: "old line" });
  expect(r!.turns[1].at).toBe(20);
});

test("parseTurns: a malformed stamp is not a stamp, so the line is plain text", () => {
  expect(parseTurns("[1:2] one\n[3:4] two")).toBeNull();
  const r = parseTurns("[00:01] ok\n[1:2] bad\n[00:09] fine");
  expect(r!.turns[1]).toEqual({ who: "", text: "[1:2] bad" });
});

test("parseTurns: a single name must look like Speaker N; more than 10 names is not speakers", () => {
  expect(parseTurns("Ravi: one\nRavi: two")).toBeNull();
  expect(parseTurns("Speaker 1: one\nSpeaker 1: two")!.names).toEqual(["Speaker 1"]);
  const many = Array.from({ length: 11 }, (_, i) => `P${i}: hi`).join("\n");
  expect(parseTurns(many)).toBeNull();
});

test("parseTurns: names with a stamp-only majority keep labels inside the text when speakers fail", () => {
  const r = parseTurns("[00:01] Ravi: one\n[00:02] Ravi: two");
  expect(r!.names).toEqual([]);
  expect(r!.turns[0].text).toBe("Ravi: one");
});

test("parseTurns: empty and one paragraph", () => {
  expect(parseTurns("")).toBeNull();
  expect(parseTurns("   \n\n ")).toBeNull();
  expect(parseTurns(undefined as any)).toBeNull();
  expect(parseTurns("[00:01] Speaker 1: only")).toBeNull();
});

test("speakerNames: first appearance order, deduped", () => {
  expect(speakerNames("[00:01] Meena: a\n[00:02] Ravi: b\n[00:03] Meena: c")).toEqual(["Meena", "Ravi"]);
  expect(speakerNames("plain text\nmore text")).toEqual([]);
  expect(speakerNames("")).toEqual([]);
  expect(speakerNames("[00:01] one\n[00:02] two")).toEqual([]);
});

test("renameSpeakerInText: renames the label only, with or without a stamp", () => {
  const t = "[00:03] Speaker 1: Speaker 1: is me\nSpeaker 2: hi\n[01:00] Speaker 1: bye";
  expect(renameSpeakerInText(t, "Speaker 1", "Ravi")).toBe("[00:03] Ravi: Speaker 1: is me\nSpeaker 2: hi\n[01:00] Ravi: bye");
});

test("renameSpeakerInText: regex characters in names are literal", () => {
  const t = "[00:01] Dr. S (HR): hello\n[00:02] DrXS (HR): hi\nDr. S (HR): again";
  expect(renameSpeakerInText(t, "Dr. S (HR)", "Sam")).toBe("[00:01] Sam: hello\n[00:02] DrXS (HR): hi\nSam: again");
  expect(renameSpeakerInText("A+B: x", "A+B", "$& $1")).toBe("$& $1: x");
});

test("renameSpeakerInText: new name is cleaned; empty or equal changes nothing", () => {
  const t = "Speaker 1: a\nSpeaker 2: b";
  expect(renameSpeakerInText(t, "Speaker 1", "  Ravi:\n  K   ")).toBe("Ravi K: a\nSpeaker 2: b");
  expect(renameSpeakerInText(t, "Speaker 1", "x".repeat(40))).toBe("x".repeat(28) + ": a\nSpeaker 2: b");
  expect(renameSpeakerInText(t, "Speaker 1", "  ")).toBe(t);
  expect(renameSpeakerInText(t, "Speaker 1", ":")).toBe(t);
  expect(renameSpeakerInText(t, "Speaker 1", "Speaker 1")).toBe(t);
  expect(renameSpeakerInText("", "A", "B")).toBe("");
});

test("renameSpeakerInText: does not touch a name that appears mid-text or without a space after the colon", () => {
  const t = "Speaker 1: tell Speaker 1: later\nSpeaker 1:nospace";
  expect(renameSpeakerInText(t, "Speaker 1", "Ravi")).toBe("Ravi: tell Speaker 1: later\nSpeaker 1:nospace");
});

test("module is importable without a DOM and 1000 turns parse quickly", () => {
  const big = Array.from({ length: 2000 }, (_, i) => `[${fmtAt(i * 5)}] Speaker ${(i % 3) + 1}: line ${i}`).join("\n");
  const t0 = performance.now();
  const r = parseTurns(big);
  expect(r!.turns.length).toBe(2000);
  expect(performance.now() - t0).toBeLessThan(200);
});
