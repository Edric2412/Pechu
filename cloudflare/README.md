# Pechu on Cloudflare

A small Worker (`src/index.ts`) sends every request to one Pechu container
(built from `../Dockerfile`). Meetings are saved in an R2 bucket.
Run all commands from this `cloudflare/` folder.

## Deploy (owner steps)

1. Upgrade the Cloudflare account to **Workers Paid** (Containers need it).
2. Dashboard > R2 > enable R2, then create a bucket named **pechu-data**.
3. R2 > Manage API tokens > create a token with **Object Read & Write**,
   limited to the `pechu-data` bucket only. Keep the Access Key ID and Secret.
4. `bun install` then `bunx wrangler login`.
5. Set each secret (it prompts you to paste the value; nothing goes in git):
   ```
   bunx wrangler secret put PECHU_PASSWORD
   bunx wrangler secret put SESSION_SECRET
   bunx wrangler secret put GEMINI_API_KEY
   bunx wrangler secret put SARVAM_API_KEY
   bunx wrangler secret put R2_ACCESS_KEY_ID
   bunx wrangler secret put R2_SECRET_ACCESS_KEY
   ```
   (If `secret put` says the Worker does not exist yet, run step 6 first, then
   repeat step 5 and run step 6 once more.)
6. Docker must be running. Then: `bunx wrangler deploy`.
   The first deploy builds and uploads the image; wait a few minutes for the
   container to be provisioned.
7. **Protect it.** Right after deploying, the site is public. In Zero Trust >
   Access > Applications, add a **Self-hosted** application for
   `pechu.imesheet.workers.dev`, add a policy **Allow** with Include >
   Emails > your one email address. Test in a private window.

## Roll back

- Dashboard > Workers & Pages > pechu > Deployments > pick the previous
  version > Rollback. Or: `bunx wrangler rollback`.
- Meetings live in R2, so rolling back code does not delete them.
- Emergency stop: remove the Access policy's Allow rule, or
  `bunx wrangler delete` (removes the Worker; the R2 bucket stays).

## View logs

- Live: `bunx wrangler tail`
- Past: Dashboard > Workers & Pages > pechu > Logs (observability is on).
- Container logs: Dashboard > Workers & Pages > Containers > pechu.

## Notes

- Only one container runs (`max_instances: 1`); it sleeps after 30 minutes
  without traffic and restarts on the next request (a short cold start).
- Local type check: `bunx tsc --noEmit`.
