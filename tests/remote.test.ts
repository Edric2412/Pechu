import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRemote, remoteFromEnv } from "../server/remote";
import { createMeeting, deleteMeeting, ensureAudio, flushRemote, getMeeting, hydrate, saveAudio, setRemote, updateMeeting } from "../server/store";

let dir: string;
let r: MemoryRemote;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pechu-r2-")); process.env.PECHU_DATA_DIR = dir; r = new MemoryRemote(); setRemote(r); });
afterEach(() => { setRemote(null); delete process.env.PECHU_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });

test("a saved meeting reaches the bucket on flush and is restored on a fresh disk", async () => {
  const m = createMeeting({ source: "live", status: "ready", transcript: "hello" });
  updateMeeting(m.id, { title: "Weekly sync" });
  await flushRemote();
  expect(JSON.parse(new TextDecoder().decode(r.objects.get(`meetings/${m.id}/meeting.json`)!)).title).toBe("Weekly sync");
  // the container restarts with an empty disk
  rmSync(dir, { recursive: true, force: true });
  expect(getMeeting(m.id)).toBeNull();
  expect(await hydrate()).toBe(1);
  expect(getMeeting(m.id)?.title).toBe("Weekly sync");
});

test("audio is in the bucket before it counts as saved, and comes back on demand", async () => {
  const m = createMeeting({ source: "live", status: "ready", transcript: "" });
  const saved = await saveAudio(m.id, new Blob([new Uint8Array([1, 2, 3, 4])]), "webm");
  expect(r.objects.has(`meetings/${m.id}/audio.webm`)).toBe(true);
  rmSync(join(dir, m.id, "audio.webm")); // gone from this container's disk
  const path = await ensureAudio(saved!);
  expect(path).not.toBeNull();
  expect([...readFileSync(path!)]).toEqual([1, 2, 3, 4]);
});

test("replacing the audio removes the old file from the bucket; deleting removes everything", async () => {
  const m = createMeeting({ source: "live", status: "ready", transcript: "" });
  await saveAudio(m.id, new Blob([new Uint8Array([1])]), "webm");
  await saveAudio(m.id, new Blob([new Uint8Array([2])]), "mp3");
  expect([...r.objects.keys()].filter((k) => k.includes("audio."))).toEqual([`meetings/${m.id}/audio.mp3`]);
  deleteMeeting(m.id);
  await flushRemote();
  expect([...r.objects.keys()].filter((k) => k.startsWith(`meetings/${m.id}/`))).toEqual([]);
  expect(existsSync(join(dir, m.id))).toBe(false);
});

test("job progress alone is not sent, but the next real change carries it", async () => {
  const m = createMeeting({ source: "live", status: "transcribing", transcript: "" });
  await flushRemote();
  const before = new TextDecoder().decode(r.objects.get(`meetings/${m.id}/meeting.json`)!);
  updateMeeting(m.id, { progress: { stage: "x" } as any });
  await flushRemote();
  expect(new TextDecoder().decode(r.objects.get(`meetings/${m.id}/meeting.json`)!)).toBe(before);
  updateMeeting(m.id, { status: "ready" });
  await flushRemote();
  expect(JSON.parse(new TextDecoder().decode(r.objects.get(`meetings/${m.id}/meeting.json`)!)).status).toBe("ready");
});

test("STORAGE=r2 with missing settings stops the start-up; local needs nothing", () => {
  expect(remoteFromEnv({})).toBeNull();
  expect(() => remoteFromEnv({ STORAGE: "r2" })).toThrow(/R2_ENDPOINT/);
  expect(remoteFromEnv({ STORAGE: "r2", R2_ENDPOINT: "https://x.r2.cloudflarestorage.com", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "s" })).not.toBeNull();
});

// The real client (Bun's S3 client) against a tiny S3-style server on loopback: checks the calls we make are well formed.
test("the R2 client puts, gets, lists, pages and deletes through the S3 protocol", async () => {
  const store = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const key = decodeURIComponent(u.pathname.replace(/^\/testbucket\/?/, ""));
      if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
        const prefix = u.searchParams.get("prefix") ?? "";
        const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = Number(u.searchParams.get("continuation-token") ?? 0);
        const page = all.slice(start, start + 2); // two per page, to exercise paging
        const more = start + 2 < all.length;
        const xml = `<?xml version="1.0"?><ListBucketResult><Name>testbucket</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}${page.map((k) => `<Contents><Key>${k}</Key><Size>${store.get(k)!.length}</Size></Contents>`).join("")}</ListBucketResult>`;
        return new Response(xml, { headers: { "content-type": "application/xml" } });
      }
      if (req.method === "PUT") { store.set(key, new Uint8Array(await req.arrayBuffer())); return new Response("", { headers: { etag: '"x"' } }); }
      if (req.method === "HEAD") return store.has(key) ? new Response(null, { headers: { "content-length": String(store.get(key)!.length) } }) : new Response(null, { status: 404 });
      if (req.method === "GET") return store.has(key) ? new Response(store.get(key)) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404, headers: { "content-type": "application/xml" } });
      if (req.method === "DELETE") { store.delete(key); return new Response(null, { status: 204 }); }
      return new Response("?", { status: 400 });
    },
  });
  try {
    const remote = remoteFromEnv({ STORAGE: "r2", R2_ENDPOINT: `http://127.0.0.1:${server.port}`, R2_BUCKET: "testbucket", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret" })!;
    await remote.put("meetings/aaaa1111/meeting.json", '{"a":1}');
    await remote.put("meetings/aaaa1111/audio.webm", new Uint8Array([9, 8, 7]));
    await remote.put("meetings/bbbb2222/meeting.json", "{}");
    await remote.put("other/x", "x");
    expect(new TextDecoder().decode((await remote.get("meetings/aaaa1111/meeting.json"))!)).toBe('{"a":1}');
    expect(await remote.get("meetings/none/meeting.json")).toBeNull();
    expect(await remote.list("meetings/")).toEqual(["meetings/aaaa1111/audio.webm", "meetings/aaaa1111/meeting.json", "meetings/bbbb2222/meeting.json"]); // 3 keys, 2 pages
    await remote.delete("meetings/aaaa1111/audio.webm");
    expect(await remote.list("meetings/aaaa1111/")).toEqual(["meetings/aaaa1111/meeting.json"]);
  } finally { server.stop(true); }
});
