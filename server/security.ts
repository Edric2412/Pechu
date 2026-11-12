// Login sessions, rate limiting, host checks and response headers.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";
import { isLoopback } from "./config";

const SESSION_MS = 7 * 24 * 3600 * 1000;
export const COOKIE = "pechu_session";

const sha = (s: string) => createHash("sha256").update(s).digest();
export function passwordOk(given: string, expected: string): boolean {
  return !!expected && timingSafeEqual(sha(given), sha(expected)); // equal-length digests, constant time
}

// The signing key mixes in the password, so changing PECHU_PASSWORD signs everyone out (as the runbook says).
const keyFor = (secret: string, password: string) => createHmac("sha256", secret).update(sha(password)).digest();
const sign = (payload: string, secret: string, password: string) => createHmac("sha256", keyFor(secret, password)).update(payload).digest("base64url");

// Signed-out sessions, remembered until they would have expired anyway (in memory: one instance).
const revoked = new Map<string, number>();
const nonceOf = (token: string) => token.split(".")[1] ?? "";
export function revokeSession(token: string | null | undefined, now = Date.now()): void {
  if (!token) return;
  const exp = Number(token.split(".")[0]);
  if (!Number.isFinite(exp)) return;
  for (const [k, v] of revoked) if (v < now) revoked.delete(k);
  revoked.set(nonceOf(token), exp);
}

export function makeSession(secret: string, password: string, now = Date.now()): string {
  const payload = `${now + SESSION_MS}.${randomBytes(12).toString("base64url")}`;
  return `${payload}.${sign(payload, secret, password)}`;
}

export function sessionOk(token: string | null | undefined, secret: string, password: string, now = Date.now()): boolean {
  if (!token || !secret || !password) return false;
  const i = token.lastIndexOf(".");
  if (i < 1) return false;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(payload, secret, password));
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return false;
  if (revoked.has(nonceOf(payload))) return false;
  return Number(payload.split(".")[0]) > now;
}

export function cookieOf(req: Request, name = COOKIE): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export const sessionCookie = (token: string, secure: boolean) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? "; Secure" : ""}`;
export const clearCookie = (secure: boolean) => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;

// ----- rate limiting (in memory, one instance) -----
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  // true = allowed (and counted), false = over the limit
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.sweep(now);
    return true;
  }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

// ----- host / origin checks (blocks other websites and DNS rebinding) -----
export const hostOf = (v: string) => {
  try { return new URL(v.includes("://") ? v : `http://${v}`).hostname.toLowerCase(); } catch { return ""; }
};
// Host must be a loopback name or a PUBLIC_HOSTS name. An Origin, when present, must be exactly this server's own
// host:port (another port on the same host is another site). With api = true the browser's own Sec-Fetch-Site hint
// must also say same-origin (or none: typed address, bookmark, non-browser client).
export function hostAllowed(req: Request, cfg: Config, api = false): boolean {
  const ok = (name: string) => !!name && (isLoopback(name) || cfg.publicHosts.includes(name));
  // Behind our own proxy (TRUST_PROXY) the real host is the one the proxy recorded in x-forwarded-host.
  const forwardedHost = cfg.trustProxy ? req.headers.get("x-forwarded-host")?.split(",").at(-1)?.trim() : "";
  const hostHeader = (forwardedHost || req.headers.get("host") || "").toLowerCase();
  if (!ok(hostOf(hostHeader))) return false;
  if (api) {
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
  }
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === hostHeader; } catch { return false; }
}

export function clientIp(req: Request, direct: string | undefined, cfg: Config): string {
  if (cfg.trustProxy) {
    // the LAST entry is the one our own proxy added; earlier entries can be written by the client
    const f = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (f) return f;
  }
  return direct ?? "unknown";
}

export const isSecure = (req: Request, cfg: Config) =>
  new URL(req.url).protocol === "https:" || (cfg.trustProxy && req.headers.get("x-forwarded-proto") === "https");

// ----- response headers -----
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function withSecurityHeaders(res: Response, secure: boolean): Response {
  const h = res.headers;
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Permissions-Policy", "microphone=(self), display-capture=(self), camera=(), geolocation=()");
  if (secure) h.set("Strict-Transport-Security", "max-age=31536000");
  return res;
}

// ----- Cloudflare Access: the signed pass it adds to every request it lets through -----
type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { url: string; keys: Jwk[]; at: number } | null = null;
async function signingKeys(url: string, now: number, force = false): Promise<Jwk[]> {
  if (!force && jwksCache && jwksCache.url === url && now - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`keys ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { url, keys: body.keys ?? [], at: now };
  return jwksCache.keys;
}
const fromB64Url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

// The email in a valid Access pass, or null. Valid = signed by the team's key, for this application, not expired.
export async function accessEmail(token: string, cfg: Config, now = Date.now()): Promise<string | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (header.alg !== "RS256") return null;
    if (payload.iss !== `https://${cfg.accessTeam}`) return null;
    const aud: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(cfg.accessAud)) return null;
    if (!(Number(payload.exp) * 1000 > now)) return null;
    if (payload.nbf != null && Number(payload.nbf) * 1000 > now + 60_000) return null;
    let key = (await signingKeys(cfg.accessJwksUrl, now)).find((k) => k.kid === header.kid);
    if (!key) key = (await signingKeys(cfg.accessJwksUrl, now, true)).find((k) => k.kid === header.kid); // keys rotate
    if (!key) return null;
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, fromB64Url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? String(payload.email ?? "unknown") : null;
  } catch {
    return null;
  }
}
