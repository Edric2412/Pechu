// Runtime settings read from the environment. Defaults keep the app a private, local tool;
// anything reachable from other machines must be given a password (see validateConfig).
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type Config = {
  host: string;
  port: number;
  publicHosts: string[]; // extra host names the app may be served under, lower case, without port
  password: string; // empty = no login (only allowed on loopback)
  sessionSecret: string;
  retentionDays: number; // 0 = keep forever
  trustProxy: boolean; // believe X-Forwarded-For / -Proto (only behind your own reverse proxy)
  maxLive: number; // concurrent live-caption sessions
  maxJobs: number; // transcription / notes jobs running at once
  accessTeam: string; // Cloudflare Access team domain, e.g. myteam.cloudflareaccess.com; with accessAud it replaces the password login
  accessAud: string; // the Access application's audience tag
  accessJwksUrl: string; // where Access publishes its signing keys (override only in tests)
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    host: (env.HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: num(env.PORT, 4317) || 4317,
    publicHosts: (env.PUBLIC_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    password: env.PECHU_PASSWORD ?? "",
    sessionSecret: env.SESSION_SECRET ?? "",
    retentionDays: Math.floor(num(env.RETENTION_DAYS, 0)),
    trustProxy: env.TRUST_PROXY === "1",
    maxLive: Math.max(1, Math.floor(num(env.MAX_LIVE_SESSIONS, 3))),
    maxJobs: Math.max(1, Math.floor(num(env.MAX_JOBS, 3))),
    accessTeam: (env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase(),
    accessAud: (env.ACCESS_AUD ?? "").trim(),
    accessJwksUrl: (env.ACCESS_JWKS_URL ?? "").trim() || (env.ACCESS_TEAM_DOMAIN ? `https://${env.ACCESS_TEAM_DOMAIN.trim().toLowerCase()}/cdn-cgi/access/certs` : ""),
  };
}

export const isLoopback = (host: string) => LOOPBACK.has(host.toLowerCase());

// Returns problems that must stop the server from starting (empty = fine).
export function validateConfig(c: Config): string[] {
  const out: string[] = [];
  if (!!c.accessTeam !== !!c.accessAud) out.push("ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set together.");
  if (c.accessTeam && c.accessAud) {
    // Cloudflare Access is the login: Pechu checks its signed pass instead of asking for a password.
    if (!c.trustProxy) out.push("Cloudflare Access login needs TRUST_PROXY=1.");
    if (!c.publicHosts.length) out.push("Cloudflare Access login needs PUBLIC_HOSTS.");
    return out;
  }
  if (!isLoopback(c.host) || c.publicHosts.length) {
    if (!c.password) out.push("PECHU_PASSWORD is required when the app can be reached from other machines.");
    else if (c.password.length < 10) out.push("PECHU_PASSWORD must be at least 10 characters.");
  }
  if (c.password && c.sessionSecret.length < 32) out.push("SESSION_SECRET must be at least 32 characters when a password is set.");
  return out;
}
