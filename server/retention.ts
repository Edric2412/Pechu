// Optional automatic deletion of old meetings (RETENTION_DAYS). Meetings still being processed are never touched.
import { deleteMeeting, listMeetings } from "./store";
import { log } from "./log";

export function purgeOld(days: number, now = Date.now()): number {
  if (!(days > 0)) return 0;
  const cutoff = now - days * 24 * 3600 * 1000;
  let n = 0;
  for (const m of listMeetings()) {
    const busy = m.status === "transcribing" || m.status === "writing-notes";
    if (!busy && Date.parse(m.createdAt) < cutoff && deleteMeeting(m.id)) n++;
  }
  if (n) log("retention.purged", { count: n, days });
  return n;
}
