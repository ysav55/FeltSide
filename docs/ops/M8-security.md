# M8.4 — Security Pass

**Verdict: PASS.** All items closed; findings below are all resolved or
documented as accepted low-risk.

## 1. Auth rate limiting (`/auth/*`)

`POST /api/auth/login` and `POST /api/auth/change-password` are rate limited
(`server/src/auth/rateLimit.js`, fixed-window in-memory). `GET /auth/me` is
not limited (cheap authenticated read). Two independent buckets per minute:

| Bucket | Default | Purpose |
|--------|---------|---------|
| per `(IP, email)` | 10/min | Brute-force guard — caps guesses at ONE account. Even the correct password is refused while the window is hot (rate, not outcome). |
| per `IP` | 60/min | Credential-stuffing backstop — caps guesses across MANY accounts from one host. Generous so a classroom behind one NAT'd school IP can all log in at lesson start. |

Both env-tunable (`AUTH_RL_PER_EMAIL`, `AUTH_RL_PER_IP`; `0` disables — a
documented ops knob used by the load harness, never the production default).
Over-limit → `429` with a `Retry-After` header and `{error:"rate_limited",
retry_after_sec}`. In-memory is correct: the engine is a single Fly machine,
so there is no cross-instance state, and a restart resetting counters is
harmless for a brute-force guard.

Tested: `test/auth.test.js` — single-account lockout with Retry-After, cross-
account isolation, per-IP backstop, window reset on an injected clock.

## 2. Export / sync endpoints reject non-key traffic, no info leak

`server/src/routes/contractAuth.js` — one static key, `Bearer`, **constant-
time compare** (`crypto.timingSafeEqual` with a length pre-check). Verified
live against a running server:

| Request | Response |
|---------|----------|
| `/export/v1/sessions` no key | `401 {"code":"invalid_api_key"}` |
| `/export/v1/sessions` wrong key | `401 {"code":"invalid_api_key"}` (identical — no missing-vs-wrong oracle) |
| `/export/v1/sessions` right key | `200` |
| `PUT /sync/v1/lessons` no / wrong key | `401 {"code":"invalid_api_key"}` |
| unknown route | `404 {"error":"not_found"}` |
| server error path | `500 {"error":"internal_error"}` (no stack, no message to the client) |

The key is never echoed and never logged (see §4).

## 3. Dependency audit

`npm audit` (production deps): **0 vulnerabilities**, both `server` and
`client`. The runtime Docker stage installs with `--omit=dev`, so test
tooling never ships regardless.

During the pass, `npm audit` (including dev) flagged 5 issues (1 critical,
1 high, 3 moderate) — all in the `vitest`/`vite`/`esbuild` test toolchain
(the esbuild dev-server SSRF and vite path-traversal, which only affect a
running dev server). **Resolved** by upgrading `vitest` `^2.1.8 → ^4.1.10`
in both workspaces; full suites re-run green (server 185, client 20).
`npm audit` is now clean including dev deps.

## 4. Secrets never logged

`server/src/log.js` is a structured JSON logger. Field names matching
`pass(word)?|secret|token|api[_-]?key|authorization|jwt|cookie` are replaced
with `[redacted]` at any depth — the property is **structural**, not
disciplinary, so a future caller that passes a secret-bearing object cannot
leak it. Wired into: boot (`server_started`), the 500 error handler
(`request_error` — message + stack to stderr, generic body to the client),
analyzer failures, tournament recording failures.

Grep confirms no `console.*` call in `src/` (outside the logger) references a
password/secret/token/key; boot never references `exportApiKey`,
`jwtSecret`, or `coachInitialPassword`. Tested: `test/log.test.js`.

## 5. JWT expiry + re-auth

- Tokens carry `{sub, role}` and expire (`JWT_EXPIRES_IN`, default **12h**).
- `verifyToken` throws on expired/invalid → middleware returns `401
  invalid_token`; the client falls back to the login screen (`App.jsx`
  clears the token on any `/auth/me` failure).
- Every protected request re-loads the player from the DB, so an
  archived/role-changed account is rejected immediately even with a still-
  valid token (verified: `archived player can no longer authenticate`).
- Tested: `test/auth.test.js` — expired token → 401, wrong-secret token →
  401.

## 6. EXPORT_API_KEY rotation procedure

The export/sync key is shared between the engine and the CRM. It is a single
static secret (CONTRACT §2). To rotate without dropping the CRM's poller:

The contract auth accepts exactly one key, so a zero-downtime rotation needs
a brief window where both old and new are valid. Two options:

**A. Coordinated cutover (simplest — a few minutes of export pause).**
1. Generate a new key: `openssl rand -hex 32`.
2. Set it on the engine: `fly secrets set EXPORT_API_KEY=<new> -a feltside`
   (this restarts the machine; boot recovery rebuilds tables per RUNTIME §1).
3. Update the CRM's stored engine key to `<new>`.
4. The CRM's next poll authenticates with the new key. Any poll in the small
   restart window retries (the CRM treats a transient failure as retryable).

Because export is **at-least-once and cursored**, a missed poll during the
cutover loses nothing — the CRM resumes from its stored cursor and re-reads.

**B. Overlap window (no pause).** If a future need justifies it, extend
`buildContractAuth` to accept `EXPORT_API_KEY` **and** an optional
`EXPORT_API_KEY_PREVIOUS`, both constant-time compared. Rotation becomes:
set new as primary + old as previous → update CRM → clear previous. This is
a ~5-line change, deliberately **not** built now (YAGNI for a single-CRM
deployment; documented so the path is known). Logged as known-gap KG-4 in
decisions/0013 if Jo wants it.

Rotate the key if: it appears in a log/screenshot/commit, a laptop with it is
lost, or on a periodic schedule (e.g. yearly). The engine never logs it (§4).
