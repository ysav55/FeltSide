# 0003 — Direct Postgres driver (pg) instead of supabase-js query builder

**Context:** M1 §1 says "Supabase JS client (service role)". supabase-js
speaks PostgREST and cannot run raw SQL, which would force either dual data
layers (one for production, one for tests) or untestable migrations/the
atomic bankroll function.

**Decision:** The server talks to the same Supabase Postgres via the `pg`
driver (`SUPABASE_DB_URL`, the service-role-equivalent connection string).
Tests run the identical SQL — migrations included — against in-process
Postgres (PGlite), so the atomic `apply_bankroll_transaction` function and
the `balance >= 0` CHECK are exercised for real in CI.

**Justification:** One code path, real-SQL tests of the exact production
schema; Supabase remains the host, only the client library differs.
