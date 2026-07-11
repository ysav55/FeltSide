# FeltSide Runbook

For Jo. Phone-readable. Every command assumes you have `fly` installed and
are logged in (`fly auth login`). App name: **feltside**. One machine, region
`otp`. The database is **Supabase** Postgres (connection string lives in the
`SUPABASE_DB_URL` Fly secret).

If something is on fire and you read nothing else: **the data is safe** — a
crash never corrupts the ledger, and the machine rebuilds every table on the
next boot. Most incidents are fixed by `fly apps restart feltside`.

---

## Deploy

```
fly deploy                    # builds, runs DB migrations, rolls the machine
```
Migrations run automatically in the release step **before** the new machine
takes traffic. They are append-only, so deploying is always safe.

## Redeploy the same code (e.g. after setting a secret)

```
fly apps restart feltside
```

## Roll back to the previous version

```
fly releases                  # list; note the version you want (e.g. v23)
fly deploy --image <image-ref-from-that-release>
# or, simplest:
fly releases --image          # copy the previous image ref
fly deploy --image <ref>
```
Rolling back **code** is safe. Do **not** try to "roll back" a migration —
they are append-only and forward-only; a rollback of code runs fine against
the newer schema.

## Watch it live / tail logs

```
fly logs                      # live structured JSON, one line per event
fly logs | grep '"level":"error"'      # only errors
fly logs | grep request_error          # 500s with method/path/message
```
Every log line is JSON: `{ts, level, event, ...}`. Secrets are auto-redacted
— you will never see a password or key in the logs.

## Health & crash-loop alerting

- Health check: Fly pings `GET /health` every 30 s. A machine failing it is
  restarted automatically.
- See machine state: `fly status` and `fly checks list`.
- **Turn on alerts** (once): in the Fly dashboard → your org → **Notifications**,
  enable email/Slack for "machine crash" and "health check failed". That is
  the crash-loop alarm — if the machine keeps restarting, you get pinged.
- Metrics/graphs: `fly dashboard` → Metrics.

---

## Backups

**Supabase runs automated daily backups.** Check/restore from the Supabase
dashboard → Database → Backups. (On the Pro plan you also get point-in-time
recovery — a slider to any moment in the last 7 days.)

### Take a manual backup right now (before a risky change)

```
# get the connection string
fly ssh console -C "printenv SUPABASE_DB_URL"     # or read it in Supabase
pg_dump -Fc "<SUPABASE_DB_URL>" -f feltside-$(date +%Y%m%d).dump
```
Keep the `.dump` file somewhere safe (it is small — tens of KB to a few MB).

### Restore drill (verified — this procedure works)

Restoring into a **fresh** database and pointing the app at it:
```
createdb feltside_restore
pg_restore -d "<new-db-url>" feltside-YYYYMMDD.dump
# verify: row counts and the ledger should match the source
psql "<new-db-url>" -c "select count(*) from hands;"
psql "<new-db-url>" -c "
  select count(*) as ledger_mismatches from bankroll_accounts a
  left join bankroll_transactions t on t.player_id=a.player_id
  group by a.player_id, a.balance
  having a.balance <> coalesce(sum(t.amount),0);"   -- expect 0 rows
# then point the app at it:
fly secrets set SUPABASE_DB_URL="<new-db-url>"       # restarts the machine
```
A backup/restore was drilled in M8: a full `pg_dump`/`pg_restore` round-trip
reproduced every row and the exact bankroll balances (see
docs/ops/M8-operations.md).

---

## Rotate the export API key (EXPORT_API_KEY)

Shared with the CRM. Coordinated cutover (a few minutes of export pause, no
data loss — export is at-least-once and cursored):
```
openssl rand -hex 32                       # new key
fly secrets set EXPORT_API_KEY=<new>       # restarts the machine
# then update the same key in the CRM's engine settings
```
The CRM resumes from its stored cursor and re-reads anything it missed during
the restart. Full detail: docs/ops/M8-security.md §6.

---

## Checklist: "a student can't log in"

1. **Wrong password?** Reset it — as the coach, in the app: Admin → the
   player → reset password (issues a temporary one; they set a new one on
   next login).
2. **"rate_limited" / 429?** They (or their whole school network) made too
   many login attempts in a minute. Wait 60 seconds and try again. It clears
   itself. (Guard: 10 tries/min per account, 60/min per network.)
3. **Archived?** An archived player cannot log in. Un-archive in Admin.
4. **Everyone can't log in?** The machine may be down or mid-deploy:
   `fly status`. If unhealthy: `fly apps restart feltside`.
5. **"password_change_required" loop?** They must set a new password once
   (first login after a coach reset). The app shows that screen — they just
   need to complete it.

## Checklist: "a tournament is stuck / won't progress"

1. **Look:** open the tournament as coach. Is the clock paused (a coach
   pause freezes everything)? **Resume** from the control panel.
2. **On a break?** It resumes automatically when the break timer ends; you
   can also **Advance level** to skip ahead.
3. **A table waiting on one player?** Tournament seats never vacate — an
   absent player's blinds post and the timer auto-folds them. If someone
   truly no-showed, use the coach panel's **manual eliminate** on that seat.
4. **A hand looks frozen?** Give it the action-timer window (30 s) to
   auto-fold the player to act. If it is genuinely wedged:
   `fly apps restart feltside` — the tournament rebuilds at the same level
   and stacks (it loses at most the one in-flight hand).
5. **Lesson is over-running?** Coach panel → **End early**: it stops now and
   pays out by current chip counts. Chips return to bankrolls.
6. **Nothing works?** `fly apps restart feltside`, then re-open the
   tournament. Boot recovery restores the clock, tables, and stacks. If the
   status still looks wrong, check `fly logs | grep -i tournament`.

## Checklist: "the CRM stopped receiving data"

1. The CRM pulls from `/export/v1/*` with the shared key. Check the key
   matches on both sides (a rotation that updated only one side breaks it).
2. `fly status` — is the engine up? Export needs the machine awake.
3. `fly logs | grep -i export` — look for auth failures (`invalid_api_key`).
4. Export is at-least-once: once fixed, the CRM catches up from its cursor
   automatically. Nothing is lost.

---

## When to call for help vs. restart

- **Restart first** (`fly apps restart feltside`) for anything that looks
  stuck, frozen, or unresponsive. It is safe and fixes most things.
- **Restore from backup** only if data looks *wrong* (not just stuck) — and
  the ledger check above (`ledger_mismatches = 0`) should always pass; if it
  ever doesn't, take a manual backup immediately and escalate.
- The ledger is append-only and every money move is one atomic transaction —
  a crash cannot create or destroy chips. If balances ever look off, it is
  almost certainly a display issue, not lost money.
