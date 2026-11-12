// Word error rate: how far a transcript is from the correct text. Lower is better; 0 = identical.
// Use it to compare settings on the same clip:  bun scripts/wer.ts correct.txt candidate.txt
// Speaker labels and [mm:ss] stamps are ignored; case and punctuation do not count.
import { readFileSync } from "node:fs";

export function words(text: string): string[] {
  return text
    .replace(/\[(?:\d+:)?\d{1,2}:\d{2}\]/g, " ")
    .replace(/^\s*Speaker \d+:/gm, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function wer(reference: string, candidate: string): number {
  const r = words(reference), c = words(candidate);
  if (!r.length) return c.length ? 1 : 0;
  let prev = Array.from({ length: c.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= c.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === c[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[c.length]! / r.length;
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error("Usage: bun scripts/wer.ts correct.txt candidate.txt"); process.exit(2); }
  console.log(`WER ${(wer(readFileSync(a, "utf8"), readFileSync(b, "utf8")) * 100).toFixed(1)}%`);
}
