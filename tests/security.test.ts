import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "../server/config";
import { RateLimiter, clientIp, hostAllowed, makeSession, passwordOk, revokeSession, sessionOk } from "../server/security";
import { purgeOld } from "../server/retention";
import { createMeeting, getMeeting, updateMeeting } from "../server/store";

const SECRET = "x".repeat(40);

const PW = "a-long-test-password";

test("a session is accepted until it expires and refused when tampered with", () => {
  const t = makeSession(SECRET, PW, 1_000);
  expect(sessionOk(t, SECRET, PW, 2_000)).toBe(true);
  expect(sessionOk(t, SECRET, PW, 1_000 + 8 * 24 * 3600 * 1000)).toBe(false); // older than 7 days
  expect(sessionOk(t, "y".repeat(40), PW, 2_000)).toBe(false); // other secret
  expect(sessionOk(t.slice(0, -2) + "xx", SECRET, PW, 2_000)).toBe(false);
  expect(sessionOk("", SECRET, PW)).toBe(false);
  expect(sessionOk(null, SECRET, PW)).toBe(false);
});

test("changing the password signs everyone out, and so does signing out", () => {
  const t = makeSession(SECRET, PW);
  expect(sessionOk(t, SECRET, PW)).toBe(true);
  expect(sessionOk(t, SECRET, "another-long-password")).toBe(false); // runbook: rotate the password, sessions end
  revokeSession(t);
  expect(sessionOk(t, SECRET, PW)).toBe(false); // sign-out
  const t2 = makeSession(SECRET, PW);
  expect(sessionOk(t2, SECRET, PW)).toBe(true); // other sessions are unaffected
});

test("client address: only the entry our own proxy added counts", () => {
  const cfg = loadConfig({ TRUST_PROXY: "1" });
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" } });
  expect(clientIp(req, "127.0.0.1", cfg)).toBe("203.0.113.9"); // a client-written first entry is ignored
  expect(clientIp(req, "127.0.0.1", loadConfig({}))).toBe("127.0.0.1"); // proxy not trusted
});

test("password check is exact", () => {
  expect(passwordOk("correct horse", "correct horse")).toBe(true);
  expect(passwordOk("correct horsf", "correct horse")).toBe(false);
  expect(passwordOk("", "")).toBe(false);
});

test("rate limiter allows N per window, then recovers", () => {
  const r = new RateLimiter(3, 1000);
  expect([r.take("a", 0), r.take("a", 1), r.take("a", 2), r.take("a", 3)]).toEqual([true, true, true, false]);
  expect(r.take("b", 3)).toBe(true); // other address unaffected
  expect(r.take("a", 1500)).toBe(true); // window passed
});

test("config: a reachable server must have a password and secret", () => {
  expect(validateConfig(loadConfig({}))).toEqual([]); // local default is fine
  expect(validateConfig(loadConfig({ HOST: "0.0.0.0" })).length).toBe(1);
  expect(validateConfig(loadConfig({ HOST: "0.0.0.0", PECHU_PASSWORD: "short" })).length).toBeGreaterThan(0);
  expect(validateConfig(loadConfig({ HOST: "0.0.0.0", PECHU_PASSWORD: "long-enough-pw" })).join(" ")).toContain("SESSION_SECRET");
  expect(validateConfig(loadConfig({ HOST: "0.0.0.0", PECHU_PASSWORD: "long-enough-pw", SESSION_SECRET: SECRET }))).toEqual([]);
  expect(validateConfig(loadConfig({ PUBLIC_HOSTS: "pechu.example.com" })).length).toBe(1); // a public name also needs a password
});

test("host check: local and listed names only, and other sites cannot call the API", () => {
  const cfg = loadConfig({ PUBLIC_HOSTS: "pechu.example.com" });
  const req = (host: string, origin?: string) => new Request("http://x/api/status", { headers: { host, ...(origin ? { origin } : {}) } });
  expect(hostAllowed(req("localhost:4317"), cfg)).toBe(true);
  expect(hostAllowed(req("pechu.example.com"), cfg)).toBe(true);
  expect(hostAllowed(req("evil.example.net"), cfg)).toBe(false); // DNS rebinding
  expect(hostAllowed(req("localhost:4317", "https://evil.example.net"), cfg)).toBe(false); // another site
  expect(hostAllowed(req("pechu.example.com", "https://pechu.example.com"), cfg)).toBe(true);
  // another port on the same host is another website
  expect(hostAllowed(req("localhost:4317", "http://localhost:3000"), cfg)).toBe(false);
  expect(hostAllowed(req("localhost:4317", "http://localhost:4317"), cfg)).toBe(true);
  expect(hostAllowed(req("pechu.example.com", "https://pechu.example.com:8443"), cfg)).toBe(false);
});

test("behind our own proxy the real host comes from x-forwarded-host", () => {
  const cfg = loadConfig({ TRUST_PROXY: "1", PUBLIC_HOSTS: "pechu.example.com" });
  const req = (origin?: string, fwd = "pechu.example.com") => new Request("http://container/api/x", { headers: { host: "container", "x-forwarded-host": fwd, ...(origin ? { origin } : {}) } });
  expect(hostAllowed(req("https://pechu.example.com"), cfg)).toBe(true);
  expect(hostAllowed(req("https://evil.example.net"), cfg)).toBe(false);
  expect(hostAllowed(req(undefined, "evil.example.net"), cfg)).toBe(false); // a host that is not ours
  // without TRUST_PROXY the header is ignored, so a direct caller cannot claim a host
  expect(hostAllowed(req("https://pechu.example.com"), loadConfig({ PUBLIC_HOSTS: "pechu.example.com" }))).toBe(false);
});

test("API requests must not be marked cross-site by the browser", () => {
  const cfg = loadConfig({});
  const req = (site?: string) => new Request("http://x/api/key", { headers: { host: "localhost:4317", ...(site ? { "sec-fetch-site": site } : {}) } });
  expect(hostAllowed(req("same-origin"), cfg, true)).toBe(true);
  expect(hostAllowed(req("none"), cfg, true)).toBe(true);
  expect(hostAllowed(req(), cfg, true)).toBe(true); // not a browser
  expect(hostAllowed(req("same-site"), cfg, true)).toBe(false);
  expect(hostAllowed(req("cross-site"), cfg, true)).toBe(false);
  expect(hostAllowed(req("cross-site"), cfg, false)).toBe(true); // opening the page from a link elsewhere is fine
});

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "pechu-ret-")); process.env.PECHU_DATA_DIR = dir; });
afterAll(() => { delete process.env.PECHU_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });

test("retention deletes old finished meetings only", () => {
  const old = createMeeting({ source: "live", status: "ready", transcript: "a" });
  const busy = createMeeting({ source: "live", status: "transcribing", transcript: "b" });
  const fresh = createMeeting({ source: "live", status: "ready", transcript: "c" });
  const ago = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
  for (const [m, d] of [[old, 40], [busy, 40], [fresh, 2]] as const) {
    const f = join(dir, m.id, "meeting.json");
    const j = JSON.parse(require("node:fs").readFileSync(f, "utf8")); j.createdAt = ago(d);
    require("node:fs").writeFileSync(f, JSON.stringify(j));
  }
  expect(purgeOld(0)).toBe(0); // off
  expect(purgeOld(30)).toBe(1);
  expect(getMeeting(old.id)).toBeNull();
  expect(getMeeting(busy.id)).not.toBeNull();
  expect(getMeeting(fresh.id)).not.toBeNull();
  void updateMeeting;
});

test("config: Access login needs both settings, the proxy flag and a public host, and no password", () => {
  const ok = { ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "a", TRUST_PROXY: "1", PUBLIC_HOSTS: "pechu.example.com", HOST: "0.0.0.0" };
  expect(validateConfig(loadConfig(ok))).toEqual([]);
  expect(validateConfig(loadConfig({ ...ok, ACCESS_AUD: "" })).join(" ")).toContain("together");
  expect(validateConfig(loadConfig({ ...ok, TRUST_PROXY: "" })).join(" ")).toContain("TRUST_PROXY");
  expect(validateConfig(loadConfig({ ...ok, PUBLIC_HOSTS: "" })).join(" ")).toContain("PUBLIC_HOSTS");
});
