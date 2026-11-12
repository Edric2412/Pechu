// One JSON line per event on stdout, easy to ship to any log tool. Never pass request bodies, keys or passwords in here.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
