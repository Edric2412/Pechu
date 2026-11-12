// An error whose message is already written for the user. Kept in its own file so audio.ts and gemini.ts can both use it.
export class UserError extends Error {}

// "fetch failed", reset connections, DNS failures and timeouts: the service could not be reached at all.
export const isNetworkError = (raw: string) => /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network error|timed? ?out/i.test(raw);
