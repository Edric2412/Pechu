import { expect, test } from "bun:test";
import { pickNotesModel } from "../server/gemini";

const m = (name: string, methods = ["generateContent"]) => ({ name: `models/${name}`, supportedGenerationMethods: methods });

test("picks the highest version flash and prefers non-preview on a tie", () => {
  const models = [
    m("gemini-2.5-flash"),
    m("gemini-3-flash"),
    m("gemini-3.8-flash-preview"),
    m("gemini-3.8-flash"),
    m("gemini-3.5-flash"),
  ];
  expect(pickNotesModel(models)).toBe("gemini-3.8-flash");
});

test("a preview wins only when nothing else has that version", () => {
  expect(pickNotesModel([m("gemini-3.9-flash-preview"), m("gemini-3.8-flash")])).toBe("gemini-3.9-flash-preview");
});

test("version numbers compare numerically, not as text", () => {
  expect(pickNotesModel([m("gemini-2.5-flash"), m("gemini-10-flash"), m("gemini-3.8-flash")])).toBe("gemini-10-flash");
});

test("excludes lite, live, tts, image, audio, transcribe, embed, thinking, exp and non-generateContent", () => {
  const excluded = [
    "gemini-9-flash-lite",
    "gemini-9-flash-live",
    "gemini-9-flash-tts",
    "gemini-9-flash-image",
    "gemini-9-flash-audio",
    "gemini-9-flash-transcribe",
    "gemini-9-flash-embed",
    "gemini-9-flash-thinking",
    "gemini-9-flash-exp",
  ].map((n) => m(n));
  const noMethod = m("gemini-9-flash", ["embedContent"]);
  expect(pickNotesModel([...excluded, noMethod, m("gemini-2.5-flash")])).toBe("gemini-2.5-flash");
});

test("falls back to pro when no plain flash model is usable", () => {
  expect(pickNotesModel([m("gemini-2.5-pro"), m("gemini-3.1-pro"), m("gemini-9-flash-lite"), m("gemini-9-flash-live")])).toBe(
    "gemini-3.1-pro",
  );
});

test("returns null when nothing fits", () => {
  expect(pickNotesModel([])).toBeNull();
  expect(pickNotesModel([m("text-embedding-004", ["embedContent"]), m("gemma-3-27b-it")])).toBeNull();
});
