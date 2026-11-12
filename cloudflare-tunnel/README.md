# Pechu front door (desktop + tunnel)

Pechu runs in Docker on the desktop (`docker compose up -d` in the repo root: the `pechu` app and the `tunnel` connector).
This Worker is the public address `pechu.imesheet.workers.dev`; it forwards to Pechu through a Cloudflare Tunnel.
Cloudflare Access (Zero Trust) allows only one email; Pechu's own password is the second lock.

Health: `docker compose ps`; logs: `docker compose logs -f pechu tunnel`. If the desktop is off, the address shows a Cloudflare error.
