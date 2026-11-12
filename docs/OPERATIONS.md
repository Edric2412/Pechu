# Pechu operations runbook

Pechu runs as one Docker container with one volume (`/data`). Put a TLS reverse proxy
(Caddy, nginx) in front; the container only listens on loopback of the host.

## Environment variables
| Variable | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Address the server listens on. |
| `PORT` | `4317` | Port. |
| `PECHU_DATA_DIR` | (Docker: `/data/meetings`) | Where meetings are stored. Put it on the volume. |
| `ENV_FILE` | (Docker: `/data/.env`) | File the app may write the Gemini key to. |
| `PECHU_PASSWORD` | none | Login password. **Required** whenever `HOST` is not loopback. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | none | Cloudflare Access is the login: no password; Pechu verifies Access's signed pass (`Cf-Access-Jwt-Assertion` or the `CF_Authorization` cookie) on every request that arrives through the proxy. Needs `TRUST_PROXY=1` and `PUBLIC_HOSTS`. Requests made directly on the machine (loopback host, no forwarded host) need no pass. |
| `SESSION_SECRET` | none | At least 32 random chars; signs login cookies. Changing it logs everyone out. |
| `PUBLIC_HOSTS` | none | Comma list of host names the app is served under, e.g. `pechu.example.com`. |
| `TRUST_PROXY` | unset | Set `1` only behind your own reverse proxy: the client address (rate limits) is the LAST `X-Forwarded-For` entry, the one your proxy adds, and https comes from `X-Forwarded-Proto`. Your proxy must set or append these headers. Never set it when the port is reachable directly. |
| `MAX_LIVE_SESSIONS` | `3` | Live-caption sessions allowed at once. |
| `MAX_JOBS` | `3` | Transcription, notes and flow jobs running at once; others get a "busy, try again" answer. |
| `MAX_AUDIO_MINUTES` | `120` | Longest recording that is transcribed. A longer one is refused with a clear message (it is never sent to Gemini or Sarvam). Decoded audio is 32 KB per second whatever the file size. |
| `RETENTION_DAYS` | unset | Meetings older than this are deleted automatically. Unset = keep forever. |
| `STORAGE` | `local` | `r2` keeps a durable copy of every meeting and recording in a Cloudflare R2 bucket (needed on Cloudflare Containers, whose disk is temporary). |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | none | Required when `STORAGE=r2`; the app refuses to start without them. Keys are secrets. |
| `GEMINI_API_KEY` | none | Notes/summary key. Secret. |
| `SARVAM_API_KEY` | none | Transcription key. Secret. |
| `NOTES_MODEL` | app default | Gemini model used for notes. |

Secrets go in as env vars at run time (compose `env_file`). They are never in the image.
Generate a secret with `openssl rand -hex 32`.

## First deploy checklist
1. Get the user's explicit approval for the deploy (deploy-gate).
2. Build: `docker build -t pechu:<date> .` and keep the tag for rollback.
3. `cp docker-compose.example.yml docker-compose.yml`, set `image:` to the tag.
4. Create `.env.docker` (`chmod 600`) with `PECHU_PASSWORD`, `SESSION_SECRET`, `PUBLIC_HOSTS`,
   `GEMINI_API_KEY`, `SARVAM_API_KEY`, and optionally `RETENTION_DAYS`.
5. `docker compose up -d`, then `docker compose ps` shows `healthy`.
6. Set up the TLS reverse proxy to `127.0.0.1:4317`; make sure only 80/443 are open on the firewall.
7. Check `https://<host>/healthz` returns `{"ok":true}`, then log in and upload a short test recording.
8. Schedule the backup (below) and do one test restore.

## Backup and restore
- Backup: `scripts/backup.sh` writes `backups/pechu-<UTC time>.tar.gz` (mode 600), keeps the newest 14
  (`KEEP=n`), skips any `.env` file, and prints the path. Source defaults to `./data`; if
  `PECHU_DATA_DIR` is set, the parent of that folder is backed up. `BACKUP_DIR` changes the target.
- Docker volume: `docker run --rm -v pechu_pechu-data:/data -v "$PWD/backups:/backups" -e PECHU_DATA_DIR=/data/meetings -e BACKUP_DIR=/backups -v "$PWD/scripts:/s:ro" debian:stable-slim /s/backup.sh`
  (volume name may differ, check `docker volume ls`). Or run the script on the host against a bind mount.
- Daily cron example: `15 3 * * * cd /srv/pechu && ./scripts/backup.sh >> backup.log 2>&1`.
- Copy backups off the machine; a backup on the same disk does not survive a disk loss.
- Restore: stop the app, then `scripts/restore.sh backups/<file>.tar.gz <empty-dir>`. It refuses a
  non-empty target. Copy the result into the volume, start the app.

## Key rotation
1. Create the new key at the provider (Google AI Studio / Sarvam), update `.env.docker`.
2. `docker compose up -d --force-recreate`.
3. Test one upload, then revoke the old key at the provider.
- `SESSION_SECRET` or `PECHU_PASSWORD`: change either one and recreate; everyone must log in again. Signing out also ends that session (until the app restarts).
- The Gemini key can also be saved via the app into `ENV_FILE` (`/data/.env`); that file is on the
  volume and is deliberately not in backups. Keep the real source of the key elsewhere.

## Retention
Set `RETENTION_DAYS=90` (for example) and recreate the container. Older meetings are deleted
automatically and cannot be recovered except from a backup. Backups are not pruned by this
setting; `KEEP` controls them. Remove it to keep everything forever.

## What to monitor
- `GET /healthz` (up, no login) and `GET /readyz` (data dir writable). Alert if either fails 3 times.
- `docker compose ps` health state and restart count.
- Disk free space on the volume (audio files grow fast).
- Container logs for errors from Gemini/Sarvam (expired key, quota).
- Last backup file age.

## Not covered yet
- Single instance only; do not run two copies on the same volume.
- Files on local disk, no database: the volume is the only copy besides backups.
- No job queue: a long transcription or notes job is lost if the container restarts mid-way
  (SIGTERM is handled gracefully, but unfinished jobs must be rerun).
- No built-in TLS (use the reverse proxy) and no multi-user accounts (one shared password).
- No log shipping or metrics, no automated alerts.

## Rollback
Edit `image:` in `docker-compose.yml` to the previous tag and run `docker compose up -d`. The data
volume is untouched. Restore a backup only if data was damaged.

## Cloudflare R2 mode
With `STORAGE=r2` the local folder is the working copy and the bucket is the durable copy. Meeting records are copied within a second of a change and on shutdown; a recording is copied before it counts as saved; at start the records are restored from the bucket and audio is fetched on first use. A container that is killed without warning can lose up to one second of changes. Deleting a meeting deletes its bucket objects too. Bucket versioning is not set up by the app.

## Recording calls (Zoom, Meet, Teams)
The Record page has two sources. *Microphone* is your voice and the room. *Device audio* is everything the computer plays, so the other people on a call are recorded too. Where the computer offers a "Monitor of ..." input (Ubuntu, or a loopback tool such as BlackHole on a Mac) it is used directly, with no sharing prompt; otherwise the browser asks to share a tab or screen and you tick "Share audio" (on Windows, share the whole screen to get every app). Phones cannot record other apps: use speaker, or record in the app and use Upload. Sound taken from the computer gets no echo cancelling, noise filter or automatic volume. Use headphones on calls so the microphone does not record the speakers a second time.
