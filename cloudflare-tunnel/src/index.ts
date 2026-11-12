// Front door for Pechu running on the desktop. Every request goes through a Cloudflare Tunnel (Workers VPC service)
// to Pechu at 127.0.0.1:4317 on that machine. Cloudflare Access (set up separately) decides who may reach this Worker.
export interface Env {
  PECHU: Fetcher; // Workers VPC service -> tunnel "pechu" -> http://127.0.0.1:4317
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Overwrite (never append) so a client cannot spoof its address, protocol or host. Pechu trusts these (TRUST_PROXY=1).
    const headers = new Headers(request.headers);
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    else headers.delete("x-forwarded-for");
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", url.host);

    // With a VPC service the host in the URL only becomes the Host header; the tunnel decides where it goes.
    // Method, body stream and WebSocket upgrade headers are kept (nothing is buffered).
    const target = `http://${url.host}${url.pathname}${url.search}`;
    return env.PECHU.fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
  },
} satisfies ExportedHandler<Env>;
