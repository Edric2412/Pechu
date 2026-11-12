# Security audit, 2026-11-12

Full report: `~/security-audit-skill/pechu/run-1/REPORT.md` (profile standard, 22 coverage units, 38 agent calls; checks ran in a no-network sandbox). Source-and-sandbox only: nothing deployed or contacted.

| Finding | Verdict | Status |
|---|---|---|
| Origin check ignored the port (another localhost page could swap the Gemini key, create meetings, start uploads, open live captions) | confirmed, medium | Fixed: exact host:port, `Sec-Fetch-Site`, JSON-only bodies |
| Sessions survived a password change and sign-out | confirmed, low | Fixed: password is part of the signing key; sign-out revokes (in memory) |
| Rate limits keyed on a client-writable `X-Forwarded-For` entry | needs validation (proxy setup) | Fixed in code: last entry used. Still check your proxy sets/appends the header |
| Audio decoder could fetch URLs named in a fake "audio" playlist (SSRF) | needs validation (image) | Fixed: network plugins switched off; re-run in sandbox shows 0 requests (was 5) |
| Decoded audio unbounded in memory/disk | needs validation (host limits) | Fixed: 180 min cap (`MAX_AUDIO_MINUTES`). Still set a container memory limit |
| Live-caption queue bounded by count only | needs validation | Fixed: 2 MiB byte cap and 64 KiB frame limit |
| No global job limit; PUT audio skipped the upload limit | needs validation (provider caps) | Fixed: `MAX_JOBS` and the hourly limit now cover PUT audio and re-transcribe |
| Uncapped transcript size (thousands of model calls) | needs validation | Fixed: 2,000,000 character cap |
| restore.sh accepted links inside archives | needs validation (backup storage) | Fixed: links refused; the audio route also refuses non-regular files |

Still for the owner: container memory limit and tmpfs size, provider spend caps, proxy header behaviour, who can write the backup location, rotating the exposed Gemini/Sarvam keys.
