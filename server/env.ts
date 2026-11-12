import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ENV_PATH = process.env.ENV_FILE?.trim() || join(import.meta.dir, "..", ".env");

export const getKey = () => (process.env.GEMINI_API_KEY ?? "").trim();

// Remove whitespace and surrounding quotes people often paste along with the key.
export function normalizeKey(raw: string): string {
  return raw.trim().replace(/^["']+|["']+$/g, "").trim();
}

export function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}...${key.slice(-2)}`;
}

// Replace the NAME=... line (dropping any duplicates) or append it. Other lines stay as they are.
export function setEnvVar(path: string, name: string, value: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(value)) throw new Error("Invalid env entry");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // no file yet: start empty
  }
  const isTarget = (line: string) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(line);
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let done = false;
  for (const line of lines) {
    if (!isTarget(line)) out.push(line);
    else if (!done) {
      out.push(`${name}=${value}`);
      done = true;
    }
  }
  if (!done) out.push(`${name}=${value}`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, out.join("\n") + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveKey(key: string, path = ENV_PATH): void {
  setEnvVar(path, "GEMINI_API_KEY", key);
  process.env.GEMINI_API_KEY = key;
}

// Bun loads ./.env by itself; when ENV_FILE points somewhere else (for example a mounted volume), read it too.
// Variables already set in the real environment win.
export function loadEnvFile(path = ENV_PATH): void {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
