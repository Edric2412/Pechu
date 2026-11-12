// Durable copy of the meetings in an S3-compatible bucket (Cloudflare R2). The container's own disk is temporary,
// so the app keeps its working files locally and mirrors them here (see store.ts). Local runs use no remote at all.
export interface Remote {
  put(key: string, data: Blob | ArrayBuffer | Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

// For tests: the same behaviour in memory.
export class MemoryRemote implements Remote {
  objects = new Map<string, Uint8Array>();
  async put(key: string, data: Blob | ArrayBuffer | Uint8Array | string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data as ArrayBuffer);
    this.objects.set(key, new Uint8Array(bytes));
  }
  async get(key: string) { return this.objects.get(key) ?? null; }
  async delete(key: string) { this.objects.delete(key); }
  async list(prefix: string) { return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(); }
}

const NEEDED = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

// STORAGE=r2 turns it on. Missing settings are a start-up error, not a silent fall back to the temporary disk.
export function remoteFromEnv(env: Record<string, string | undefined> = process.env): Remote | null {
  if ((env.STORAGE ?? "local").trim().toLowerCase() !== "r2") return null;
  const missing = NEEDED.filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`STORAGE=r2 needs ${missing.join(", ")}.`);
  const s3 = new Bun.S3Client({
    endpoint: env.R2_ENDPOINT!.trim(),
    bucket: env.R2_BUCKET!.trim(),
    accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
    region: "auto",
  });
  return {
    async put(key, data) { await s3.write(key, data as any); },
    async get(key) {
      const f = s3.file(key);
      if (!(await f.exists())) return null;
      return new Uint8Array(await f.arrayBuffer());
    },
    async delete(key) { await s3.delete(key); },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const r: any = await s3.list({ prefix, continuationToken: token });
        for (const c of r.contents ?? []) keys.push(c.key);
        token = r.isTruncated ? r.nextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}
