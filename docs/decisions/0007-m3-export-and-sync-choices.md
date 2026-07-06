# 0007 — M3 implementation choices (export API, lesson sync, deploy)

Interpretive calls made implementing CONTRACT.md in M3, each within the
contract's stated freedom. Plus two Step-0 outcomes.

1. **Cursor mechanism: one `export_seq` sequence, stamped under a Postgres
   advisory lock held to commit.** The M3 prompt's plain BIGSERIAL has a
   race: with concurrent writers, seq assignment order can differ from
   commit order, so a poll could observe seq N while seq M < N is still
   uncommitted — then resume past M, violating §3 "never skips".
   `pg_advisory_xact_lock` serializes stamp→commit, making seq order ==
   visibility order at negligible cost for a single-school engine.
   Sessions stamp at finalize, hands at record (a recorded hand IS
   complete), revision bumps re-stamp (§4.5). Cursor = base64url of
   `v1:<seq>`; anything else → 400 `invalid_cursor`.

2. **`/export/v1/players` exports `role='player'` accounts only.** §4.2
   is about "player accounts" that may carry `crm_student_id`; exporting
   the coach account would only add a permanently-unlinked row to the
   CRM's reconcile view. `coach_player_id` (§4.3, M4+) is opaque to the
   CRM and does not require the coach in the snapshot.

3. **Contract endpoints speak `{ code }`, the app API keeps `{ error }`.**
   §7 defines error *codes* and the CRM's connector parses a `code`
   field; the JWT-side routes keep the established app convention.

4. **`PUT /sync/v1/lessons` replies 204.** §8 defines no response body;
   the CRM connector treats a bodyless 2xx as success. Malformed
   snapshots → 400 `{ code: 'invalid_snapshot' }` (validation, not
   reconcile; a snapshot with duplicate `crm_entry_id`s is malformed by
   snapshot semantics).

5. **Stale-scheduled prune (RUNTIME §3) runs in three places:** inside
   every sync reconcile, at boot, and hourly — the reconcile path covers
   the normal case, boot + timer cover a CRM that stopped pushing.

6. **Region `otp` (Bucharest)** — the Fly region nearest Israel per the
   M3 prompt. `fra` is the fallback if otp capacity misbehaves.

7. **Review placeholder sits behind the normal login gate** — consistent
   with "every endpoint has auth" (PRD §12); the URL shape is what's
   locked, not its anonymity.

8. **Step 0.1 partial: bootstrap branch deletion blocked.** FeltSide full
   history is pushed and verified (`42764f6`). Deleting
   `claude/feltside-bootstrap-setup-6ba75x` from poker-trainer returned
   403 — this session's git proxy only allows pushes to its designated
   branches. Jo: `git push origin --delete claude/feltside-bootstrap-setup-6ba75x`
   from any full-permission checkout of poker-trainer.

9. **Live Fly deploy not executed from this session** — no flyctl
   credentials available in the remote environment. Everything is staged
   (Dockerfile, fly.toml, DEPLOY.md with exact commands); acceptance
   criterion #3 (cold start < 15s verified after forced scale-to-zero)
   transfers to Jo's first `fly deploy`.
