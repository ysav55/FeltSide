# DEPLOY.md — FeltSide on Fly.io

Exact commands for Jo. Everything assumes the repo root and a logged-in
`flyctl` (`fly auth login`).

## First deploy

```bash
# 1. Create the app (once). Keep the name — PUBLIC_BASE_URL and the CRM's
#    engine base URL both point at it.
fly apps create feltside

# 2. Secrets (once; rotate any time — `fly secrets set` redeploys).
fly secrets set \
  SUPABASE_DB_URL='postgres://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres' \
  JWT_SECRET="$(openssl rand -hex 48)" \
  EXPORT_API_KEY="$(openssl rand -hex 32)" \
  COACH_EMAIL='jo@example.com' \
  COACH_INITIAL_PASSWORD='<strong-initial-password>' \
  COACH_DISPLAY_NAME='Jo'

# 3. Deploy. The release step runs DB migrations before the new machine
#    takes traffic (migrations are append-only, so this is always safe).
fly deploy

# 4. Verify.
curl -s https://feltside.fly.dev/health
curl -s -H "Authorization: Bearer <EXPORT_API_KEY>" \
  https://feltside.fly.dev/export/v1/meta | head -c 400
```

Give the CRM (Settings → Engine): base URL `https://feltside.fly.dev` and
the `EXPORT_API_KEY` value. Its "Test connection" button runs the same
`/export/v1/meta` handshake.

## Redeploy (every code change)

```bash
fly deploy
```

That's it — migrations run in the release phase, machines roll.

## Cold starts & scale-to-zero

The app scales to zero when no connections are open. The first request
after idle takes ~2–5s (the CRM tolerates ≥15s per CONTRACT §2 — a timeout
is a quiet failed tick, not an incident). Seated tables hold live socket
connections, which keep the machine awake (RUNTIME §1). To verify the
cold-start budget after a forced stop:

```bash
fly machine stop --select
time curl -s -o /dev/null -H "Authorization: Bearer <EXPORT_API_KEY>" \
  https://feltside.fly.dev/export/v1/meta
```

Expect well under 15s to first byte.

## Useful

```bash
fly logs                 # live logs (the API key is never logged)
fly status               # machines + health checks
fly secrets list         # names only, values hidden
```
