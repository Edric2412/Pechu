// Cloudflare Access mode: no password, Pechu checks the signed pass Access adds. Real server, stand-in key server on loopback.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEAM = "test-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const HOST = "pechu.example.com";
let proc: ReturnType<typeof Bun.spawn>;
let keyServer: ReturnType<typeof Bun.serve>;
let base = "";
let dir = "";
let good: CryptoKeyPair;
let other: CryptoKeyPair;

const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
async function pass(keys: CryptoKeyPair, claims: Record<string, unknown> = {}, kid = "k1"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid, typ: "JWT" });
  const body = b64({ iss: `https://${TEAM}`, aud: [AUD], email: "edric@example.com", iat: now, exp: now + 3600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}
const via = (token?: string, extra: Record<string, string> = {}) => ({ headers: { host: "container", "x-forwarded-host": HOST, "x-forwarded-proto": "https", ...(token ? { "cf-access-jwt-assertion": token } : {}), ...extra } });

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  good = await gen();
  other = await gen();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  keyServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ keys: [jwk] }) });
  dir = mkdtempSync(join(tmpdir(), "pechu-access-"));
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "server", "index.ts")], {
    env: { PATH: process.env.PATH ?? "", PORT: String(port), TRUST_PROXY: "1", PUBLIC_HOSTS: HOST, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_JWKS_URL: `http://127.0.0.1:${keyServer.port}/certs`, PECHU_DATA_DIR: join(dir, "meetings"), ENV_FILE: join(dir, ".env") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ } await Bun.sleep(100); }
  throw new Error("server did not start");
});
afterAll(async () => { proc.kill("SIGTERM"); await proc.exited; keyServer.stop(true); rmSync(dir, { recursive: true, force: true }); });

test("a request through the proxy needs a valid Access pass", async () => {
  expect((await fetch(`${base}/api/meetings`, via())).status).toBe(401);
  expect((await fetch(`${base}/api/meetings`, via(await pass(good)))).status).toBe(200);
});

test("a pass for another application, an expired pass, or one signed with another key is refused", async () => {
  expect((await fetch(`${base}/api/meetings`, via(await pass(good, { aud: ["someone-else"] })))).status).toBe(401);
  expect((await fetch(`${base}/api/meetings`, via(await pass(good, { exp: Math.floor(Date.now() / 1000) - 10 })))).status).toBe(401);
  expect((await fetch(`${base}/api/meetings`, via(await pass(other)))).status).toBe(401); // same key id, wrong signature
  expect((await fetch(`${base}/api/meetings`, via(await pass(good, { iss: "https://evil.cloudflareaccess.com" })))).status).toBe(401);
  expect((await fetch(`${base}/api/meetings`, via("not.a.token"))).status).toBe(401);
});

test("the pass may also come in the CF_Authorization cookie (WebSocket handshakes)", async () => {
  const t = await pass(good);
  expect((await fetch(`${base}/api/meetings`, via(undefined, { cookie: `CF_Authorization=${t}` }))).status).toBe(200);
});

test("the owner on this computer needs no pass, but a public host name without one is refused", async () => {
  expect((await fetch(`${base}/api/meetings`)).status).toBe(200); // Host 127.0.0.1, no forwarded host
  expect((await fetch(`${base}/api/meetings`, { headers: { host: HOST } })).status).toBe(401); // claims the public name, no pass
});

test("there is no password login in this mode", async () => {
  const r = await (await fetch(`${base}/api/auth`, via(await pass(good)))).json() as any;
  expect(r.authRequired).toBe(false);
  expect(r.authed).toBe(true);
});
