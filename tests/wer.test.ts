import { expect, test } from "bun:test";
import { wer, words } from "../scripts/wer";

test("word error rate counts substitutions, drops and extras, and ignores labels, stamps and punctuation", () => {
  expect(wer("the cat sat", "the cat sat")).toBe(0);
  expect(wer("the cat sat", "the dog sat")).toBeCloseTo(1 / 3);
  expect(wer("the cat sat", "the sat")).toBeCloseTo(1 / 3);
  expect(wer("the cat", "the big cat")).toBeCloseTo(1 / 2);
  expect(words("[00:05] Speaker 2: Hello, World!")).toEqual(["hello", "world"]);
  expect(wer("வணக்கம் நண்பா", "வணக்கம் நண்பா.")).toBe(0);
});
