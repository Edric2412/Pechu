import { DurableObject } from "cloudflare:workers";

export interface Env {
  PECHU: DurableObjectNamespace<PechuContainer>;
  // Secrets, set with `wrangler secret put`. Optional so a missing one does not crash the Worker.
  PECHU_PASSWORD?: string;
  SESSION_SECRET?: string;
  GEMINI_API_KEY?: string;
  SARVAM_API_KEY?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

const PORT = 4317;
// Keep the container running for 30 minutes after the last request, so a live-captions session is not cut in a quiet moment.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const SECRET_NAMES = ["PECHU_PASSWORD", "SESSION_SECRET", "GEMINI_API_KEY", "SARVAM_API_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

// One Durable Object owns the one container. It starts it on the first request, waits until the app answers, and forwards.
export class PechuContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (ctx.container?.running) {
      // after a Durable Object restart the timeout must be set again
      void ctx.blockConcurrencyWhile(() => ctx.container!.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  async fetch(request: Request): Promise<Response> {
    // Concurrent requests share startup and readiness.
    this.starting ??= this.startAndWait().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    // The container sees plain HTTP on an internal name. The app reads the real host from x-forwarded-host (set by our
    // Worker below), so the Host header is dropped, as the Cloudflare examples do.
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    // Returning the response as it is keeps WebSocket upgrades (/api/live) working.
    return this.ctx.container!.getTcpPort(PORT).fetch(forwarded);
  }

  private async startAndWait(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      const env: Record<string, string> = {
        HOST: "0.0.0.0",
        PORT: String(PORT),
        TRUST_PROXY: "1", // the app reads x-forwarded-for / -proto / -host, all set by our Worker
        PUBLIC_HOSTS: "pechu.imesheet.workers.dev",
        STORAGE: "r2",
        R2_BUCKET: "pechu-data",
        R2_ENDPOINT: "https://6dc3c771464cc474bfba0d86bfaae004.r2.cloudflarestorage.com",
        PECHU_DATA_DIR: "/data/meetings",
        ENV_FILE: "/data/.env",
      };
      // Copy each secret only when it is set; values are never logged.
      for (const name of SECRET_NAMES) {
        const value = this.env[name];
        if (value) env[name] = value;
      }
      // enableInternet: the app calls Gemini, Sarvam and R2.
      container.start({ enableInternet: true, env });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    // start() returns before the app is up: poll its health check (it needs no login).
    const port = container.getTcpPort(PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const res = await port.fetch("http://container/healthz");
        if (res.ok) return;
        lastError = new Error(`health check returned ${res.status}`);
      } catch (e) {
        lastError = e;
      }
      await scheduler.wait(200);
    }
    throw new Error("Pechu did not start in time", { cause: lastError });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Overwrite (never append) so a client cannot spoof its address, protocol or host.
    const headers = new Headers(request.headers);
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    else headers.delete("x-forwarded-for");
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", new URL(request.url).host);

    // Keeps method, URL, body stream and WebSocket upgrade headers; the body is streamed, not buffered.
    const forwarded = new Request(request, { headers });
    // One fixed name = one container for everyone.
    return env.PECHU.getByName("main").fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
