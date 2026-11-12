# Pechu

A small Bun web app for meetings: upload or record audio, transcribe it (Sarvam), and make notes
(Gemini). Server in `server/` (entry `server/index.ts`, audio conversion via GStreamer in
`server/audio.ts`), plain frontend in `public/`, meetings stored as files in a data directory.

## Run and test
- Run: `bun run start` (dev with reload: `bun run dev`). Config via env vars, see `docs/OPERATIONS.md`.
- Test: `bun test`
- Needs `gst-launch-1.0` (GStreamer) on the machine for audio conversion.

## Deploy
- Live since 2026-11-12 on the owner's desktop: `docker compose up -d` (services `pechu` and `tunnel`, both restart by themselves). Public address `https://pechu.imesheet.workers.dev` = Worker `pechu` -> Workers VPC service `pechu` -> tunnel `pechu` -> 127.0.0.1:4317. Cloudflare Access app `pechu` allows only the owner's Google account and is the only login: there is no Pechu password. Pechu checks the signed Access pass on every request that comes through the Worker (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` in `.env.docker`); requests made directly on the desktop (localhost) need nothing. To go back to a password, remove those two settings and set `PECHU_PASSWORD` and `SESSION_SECRET`. Secrets: `.env.docker`, `~/.config/pechu/tunnel.env` (neither in git). Cloudflare account id and resource ids are in `cloudflare-tunnel/wrangler.jsonc`. Storage is local (`./data/meetings`); the R2 mode (`STORAGE=r2`, `cloudflare/` folder) is built and tested but unused because Containers and R2 need paid plans. The desktop must be on.
- Documented path: build the image from `Dockerfile`, run it with `docker-compose.example.yml`,
  pass secrets as env vars, put a TLS reverse proxy in front.
- Every deploy needs the user's explicit approval in the conversation (use the `deploy-gate` skill).
- Never print secrets (`.env`, API keys, `PECHU_PASSWORD`, `SESSION_SECRET`).
- Rollback = run the previous image tag.
- Runbook: `docs/OPERATIONS.md`. Backups: `scripts/backup.sh`, `scripts/restore.sh`.

## Before any deploy
Run the deploy-gate skill, and its security step is Cloudflare's `security-audit` skill. Last full audit: 2026-11-12, run folder `~/security-audit-skill/pechu/run-1` (summary in `docs/SECURITY-AUDIT.md`). Re-run it after changes to login, the Origin/host check, uploads, audio decoding, Docker or the restore script.
