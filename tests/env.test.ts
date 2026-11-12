import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskKey, normalizeKey, saveKey, setEnvVar } from "../server/env";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pechu-env-"));
  path = join(dir, ".env");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const original = "GEMINI_API_KEY=\n# Optional: override the model used for summary and flow chart\n# NOTES_MODEL=\nPORT=4317\n";

test("replaces the key line and keeps every other line", () => {
  writeFileSync(path, original);
  setEnvVar(path, "GEMINI_API_KEY", "abc123");
  expect(readFileSync(path, "utf8")).toBe(original.replace("GEMINI_API_KEY=", "GEMINI_API_KEY=abc123"));
});

test("saving twice never duplicates the line, and duplicates already in the file collapse to one", () => {
  writeFileSync(path, "A=1\nGEMINI_API_KEY=old\nB=2\nGEMINI_API_KEY=older\n");
  setEnvVar(path, "GEMINI_API_KEY", "one");
  setEnvVar(path, "GEMINI_API_KEY", "two");
  const text = readFileSync(path, "utf8");
  expect(text).toBe("A=1\nGEMINI_API_KEY=two\nB=2\n");
});

test("appends the line when missing, and creates the file when absent", () => {
  writeFileSync(path, "PORT=4317");
  setEnvVar(path, "GEMINI_API_KEY", "k");
  expect(readFileSync(path, "utf8")).toBe("PORT=4317\nGEMINI_API_KEY=k\n");
  const fresh = join(dir, "fresh.env");
  setEnvVar(fresh, "GEMINI_API_KEY", "k");
  expect(readFileSync(fresh, "utf8")).toBe("GEMINI_API_KEY=k\n");
});

test("saveKey also updates process.env; newlines are refused", () => {
  const before = process.env.GEMINI_API_KEY;
  saveKey("zzz", path);
  expect(process.env.GEMINI_API_KEY).toBe("zzz");
  expect(() => setEnvVar(path, "GEMINI_API_KEY", "a\nB=1")).toThrow();
  process.env.GEMINI_API_KEY = before;
});

test("normalizeKey strips whitespace and quotes; maskKey hides the middle", () => {
  expect(normalizeKey('  "AIzaSyABC"\n')).toBe("AIzaSyABC");
  expect(normalizeKey("'k'")).toBe("k");
  expect(maskKey("AIzaSyDUMMYKEY1234567890")).not.toContain("DUMMYKEY");
  expect(maskKey("short")).toBe("****");
});
