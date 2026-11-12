// What the person reads when something fails: plain words, never raw JSON, status codes or stack text.
import { expect, test } from "bun:test";
import { messageForStatus } from "../public/js/api.js";
import { UserError, isNetworkError } from "../server/errors";
import { describeError, friendlyError } from "../server/gemini";
import { liveReason } from "../server/live";
import { sarvamMessage } from "../server/sarvam";

// The real text Sarvam sent for the first 50-minute recording.
const SARVAM_CONTEXT = `400:{"error":{"message":"Input length (4192) exceeds model's maximum context length (4096).","code":"invalid_request_error","request_id":"20261112_5e7cd723"}}`;
const messy = (s: string) => /[{}]|request_id|invalid_request|\b[45]\d\d:|Error:|at \S+ \(|ECONN|ETIMEDOUT/.test(s);

test("Sarvam's context-length failure is explained in plain words", () => {
  const msg = sarvamMessage(SARVAM_CONTEXT);
  expect(msg).toContain("could not process this recording in one piece");
  expect(messy(msg)).toBe(false);
});

test("each Sarvam problem gets its own plain message", () => {
  expect(sarvamMessage("", 401)).toContain("did not accept the API key");
  expect(sarvamMessage("", 402)).toContain("out of credits");
  expect(sarvamMessage("insufficient balance")).toContain("out of credits");
  expect(sarvamMessage("", 429)).toContain("rate limiting");
  expect(sarvamMessage("413:payload too large")).toContain("too large");
  expect(sarvamMessage("503:upstream connect error")).toContain("trouble on its side");
  expect(sarvamMessage("fetch failed")).toContain("could not reach Sarvam");
});

test("an unknown Sarvam failure never shows its raw text", () => {
  const msg = sarvamMessage(`418:{"error":{"message":"something nobody expected","request_id":"abc"}}`);
  expect(msg).toBe("Sarvam could not transcribe this recording. Try again, and if it keeps failing, try a shorter recording.");
  expect(messy(msg)).toBe(false);
});

test("network failures read as a connection problem", () => {
  for (const raw of ["fetch failed", "read ECONNRESET", "connect ETIMEDOUT 1.2.3.4:443", "getaddrinfo ENOTFOUND api.example.com", "socket hang up"]) {
    expect(isNetworkError(raw)).toBe(true);
    const msg = friendlyError(new TypeError(raw));
    expect(msg).toContain("could not reach the service");
    expect(messy(msg)).toBe(false);
  }
  expect(isNetworkError("flow node has no label")).toBe(false);
});

test("an error nobody planned for shows a calm generic message, not its raw text", () => {
  for (const raw of ["Unexpected token < in JSON at position 0", "flow node has no label", `{"error":{"code":500,"message":"boom"}}`, "TypeError: undefined is not an object (evaluating 'x.y')"]) {
    const msg = friendlyError(new Error(raw));
    expect(msg).toContain("Something went wrong");
    expect(msg).not.toContain(raw);
  }
});

test("other known failures keep their plain messages", () => {
  expect(friendlyError(Object.assign(new Error("write failed ENOSPC"), {}))).toContain("disk");
  expect(friendlyError(Object.assign(new Error("bad gateway"), { status: 502 }))).toContain("problem on its side");
  expect(friendlyError(new Error("Audio conversion failed: gst error"))).toContain("could not read this audio file");
  // a message that was already written for the person passes through unchanged
  expect(friendlyError(new UserError("Write the notes first."))).toBe("Write the notes first.");
});

test("the log gets the full technical text with keys masked, and the cause is kept", () => {
  const prevG = process.env.GEMINI_API_KEY, prevS = process.env.SARVAM_API_KEY;
  process.env.GEMINI_API_KEY = "AIzaSyFakeGeminiKey1234567890";
  process.env.SARVAM_API_KEY = "sk_fake_sarvam_key_1234567890";
  try {
    const e = new UserError("shown to the person", { cause: new Error(`${SARVAM_CONTEXT} key=sk_fake_sarvam_key_1234567890 g=AIzaSyFakeGeminiKey1234567890`) });
    const log = describeError(e);
    expect(log).toContain("shown to the person");
    expect(log).toContain("exceeds model's maximum context length");
    expect(log).not.toContain("sk_fake_sarvam_key_1234567890");
    expect(log).not.toContain("AIzaSyFakeGeminiKey1234567890");
  } finally {
    if (prevG === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevG;
    if (prevS === undefined) delete process.env.SARVAM_API_KEY; else process.env.SARVAM_API_KEY = prevS;
  }
});

test("live caption failures are put in plain words", () => {
  expect(liveReason("connection ended (code 1006)")).toBe("Live captions lost their connection.");
  expect(liveReason("read ECONNRESET")).toBe("Live captions lost their connection.");
  expect(liveReason("Quota exceeded for quota metric 'generate_content_free_tier_requests'")).toBe("Live captions hit a usage limit.");
  expect(liveReason("API key not valid. Please pass a valid API key.")).toContain("did not accept the API key");
  expect(liveReason(`{"error":{"code":500,"message":"Internal error encountered."}}`)).toBe("Live captions had a problem.");
  expect(liveReason("x".repeat(200))).toBe("Live captions had a problem.");
  expect(liveReason("Live transcription failed.")).toBe("Live transcription failed.");
});

test("the browser says what happened when the server's answer is not JSON", () => {
  expect(messageForStatus(413)).toContain("too large");
  expect(messageForStatus(429)).toContain("Wait a minute");
  for (const s of [500, 502, 503, 504, 522, 524]) expect(messageForStatus(s)).toContain("Try again in a minute");
  expect(messageForStatus(418)).toBe("Something went wrong (418). Try again.");
  for (const s of [413, 429, 502, 418]) expect(messy(messageForStatus(s))).toBe(false);
});
