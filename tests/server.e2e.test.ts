// Starts the real server (password mode) on a free port with a temporary data folder and talks to it over HTTP.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let proc: ReturnType<typeof Bun.spawn>;
let base = "";
let dir = "";
const PW = "a-long-test-password";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pechu-e2e-"));
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server", "index.ts")], {
    env: { PATH: process.env.PATH ?? "", PORT: String(port), PECHU_PASSWORD: PW, SESSION_SECRET: "s".repeat(40), PECHU_DATA_DIR: join(dir, "meetings"), ENV_FILE: join(dir, ".env") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ } await Bun.sleep(100); }
  throw new Error("server did not start");
});
afterAll(async () => { proc.kill("SIGTERM"); await proc.exited; rmSync(dir, { recursive: true, force: true }); });

test("health checks work without logging in", async () => {
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  expect((await fetch(`${base}/readyz`)).status).toBe(200);
});

test("the API needs a login, and the page carries security headers", async () => {
  const r = await fetch(`${base}/api/meetings`);
  expect(r.status).toBe(401);
  expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  const page = await fetch(`${base}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).not.toMatch(/<script>[^<]/); // no inline scripts, the policy would block them
  expect(((await (await fetch(`${base}/api/auth`)).json()) as any).authRequired).toBe(true);
});

test("a wrong host name is refused", async () => {
  const r = await fetch(`${base}/api/auth`, { headers: { host: "evil.example.net" } });
  expect(r.status).toBe(403);
});

test("login: wrong password refused, right password opens the API, sign-out closes it", async () => {
  const bad = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
  expect(bad.status).toBe(401);
  const ok = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PW }) });
  expect(ok.status).toBe(200);
  const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
  expect(ok.headers.get("set-cookie")).toContain("SameSite=Strict");
  const list = await fetch(`${base}/api/meetings`, { headers: { cookie } });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([]);
});

test("the live-caption socket needs a login too", async () => {
  const opened = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/live`);
    ws.onopen = () => { ws.close(); resolve(true); };
    ws.onerror = () => resolve(false);
    ws.onclose = () => resolve(false);
  });
  expect(opened).toBe(false);
});

const JSON_HEADERS = { "content-type": "application/json" };
// the login limit is 5 a minute, so tests share one session
let shared: string | null = null;
const sharedCookie = async () => {
  if (shared) return shared;
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ password: PW }) });
  return (shared = (login.headers.get("set-cookie") ?? "").split(";")[0]!);
};

test("a plain-text body is refused, so another site cannot send it without a preflight", async () => {
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ password: PW }) });
  expect(r.status).toBe(415);
});

test("a page on another port of the same host is refused", async () => {
  const cookie = await sharedCookie();
  const other = new URL(base).port === "3000" ? "3001" : "3000";
  const r = await fetch(`${base}/api/meetings`, { headers: { cookie, origin: `http://127.0.0.1:${other}` } });
  expect(r.status).toBe(403);
  const same = await fetch(`${base}/api/meetings`, { headers: { cookie, origin: base } });
  expect(same.status).toBe(200);
});

test("signing out ends that session", async () => {
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ password: PW }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect((await fetch(`${base}/api/meetings`, { headers: { cookie } })).status).toBe(200);
  await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
  expect((await fetch(`${base}/api/meetings`, { headers: { cookie } })).status).toBe(401);
});

test("an over-long transcript is refused", async () => {
  const cookie = await sharedCookie();
  const r = await fetch(`${base}/api/meetings`, { method: "POST", headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ transcript: "x".repeat(2_000_001) }) });
  expect(r.status).toBe(413);
});

test("an audio upload over 100 MB is refused and a small one is accepted", async () => {
  const cookie = await sharedCookie();
  const m = (await (await fetch(`${base}/api/meetings`, { method: "POST", headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ transcript: "hello" }) })).json()) as { id: string };
  const put = (bytes: number) => fetch(`${base}/api/meetings/${m.id}/audio`, { method: "PUT", headers: { "content-type": "audio/webm", cookie }, body: new Uint8Array(bytes) });
  const big = await put(100_000_001);
  expect(big.status).toBe(413);
  expect(((await big.json()) as { error: string }).error).toContain("100 MB");
  expect((await put(1000)).status).toBe(200);
});

// last on purpose: it uses up the login attempts for this minute
test("too many wrong passwords are throttled", async () => {
  let last = 0;
  for (let i = 0; i < 8; i++) {
    last = (await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) })).status;
  }
  expect(last).toBe(429);
});

