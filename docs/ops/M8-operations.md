# M8.5 — Operations

**Verdict: PASS.** Backup strategy documented and a restore drill actually
performed; health checks + crash-loop alerting in place; structured error
logging with an operator tail command; `docs/RUNBOOK.md` written for Jo.

## Backup strategy

Production data lives in **Supabase Postgres** (`SUPABASE_DB_URL`). Supabase
provides automated daily backups (and point-in-time recovery on the Pro
plan). On top of that, an operator can take a manual `pg_dump -Fc` before any
risky change (see RUNBOOK). Backups are small (the whole schema + a busy
evening is tens of KB to a few MB).

## Restore drill — PERFORMED (M8.5)

A full backup → drop → restore → verify round-trip was executed against a
real Postgres 16 instance holding live-shaped data (players, sessions, hands,
bankroll ledger, tournaments):

```
pg_dump -Fc feltside_soak -f soak-backup.dump        # 94 KB custom-format dump
createdb feltside_restore
pg_restore -d feltside_restore soak-backup.dump
```

Verification — **all matched exactly**:

| Check | Source | Restored |
|-------|--------|----------|
| players | 33 | 33 |
| hands | 100 | 100 |
| bankroll_transactions | 86 | 86 |
| sessions | 4 | 4 |
| bankroll fingerprint (md5 of every player_id+balance) | `c3d7146…` | `c3d7146…` ✓ |
| ledger invariant (balance == Σ tx) | 0 mismatches | **0 mismatches** |

The restore is byte-faithful on row counts and exact on every bankroll
balance, and the ledger invariant holds in the restored copy. The procedure
is codified in `docs/RUNBOOK.md` → Backups.

## Health checks

`fly.toml` defines an HTTP health check: `GET /health` every 30 s (5 s
timeout, 10 s grace). A machine that fails it is restarted automatically by
the Fly proxy. `GET /health` is unauthenticated and returns `{ok:true}` —
verified live during the soak and crash drills.

## Crash-loop alerting

Fly restarts a crashed machine automatically; to be *told* when it is
crash-looping, enable **Notifications → machine crash / health-check failed**
in the Fly dashboard (documented in the RUNBOOK). `fly status` and
`fly checks list` show current state on demand.

## Structured error logging

`server/src/log.js` — one JSON object per line (`{ts, level, event, …}`) to
stdout/stderr, with structural secret redaction. Wired into boot
(`server_started`), the 500 handler (`request_error` with method/path/message/
stack to stderr, generic body to the client), and analyzer/tournament error
paths. Operator tail commands (in the RUNBOOK):

```
fly logs                              # everything, live
fly logs | grep '"level":"error"'     # errors only
fly logs | grep request_error         # 500s with context
```

Tested: `server/test/log.test.js`.

## Runbook

`docs/RUNBOOK.md` — phone-readable, for Jo. Covers: deploy, redeploy,
rollback, logs, health & alerting, backup, the **performed** restore
procedure, key rotation, and three incident checklists ("student can't log
in", "tournament stuck", "CRM stopped receiving data"), plus a
restart-vs-restore decision guide.
