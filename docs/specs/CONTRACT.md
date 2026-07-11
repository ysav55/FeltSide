# CONTRACT.md — Engine ⇄ CRM Integration Contract (v1)

> Status: **Agreed draft** — binding for both sides once committed to both repos.
> Readers: the engine implementation agent and the CRM implementation agent.
> Model B (locked): the engine exposes a read-only REST export; the CRM pulls
> with an EnginePoller. No shared DB. No inbound webhooks to the CRM.
> One reverse channel exists: the CRM **pushes** lesson schedules to the
> engine (§8) — the laptop can send, it just can't receive.

---

## 1. Principles

1. **The engine is the source of truth for gameplay facts.** Hands, actions,
   results, auto-tags. It knows nothing about the CRM's leak taxonomy,
   mastery model, or students — except one opaque field: `crm_student_id`.
2. **The CRM is the canonical person registry.** `stu_{ULID}` identifies a
   human. The engine owns login/auth for play; each engine player account may
   carry a `crm_student_id`, set manually by the operator.
3. **Translation lives in the CRM.** Engine tags (`OPEN_LIMP`, `C_BET_IP`, …)
   are mapped to CRM `stat_key`s inside the CRM's poller layer
   (`TAG_MAPPING.md`). The engine never adapts its vocabulary to the CRM.
4. **Pull, at-least-once, idempotent.** The engine may re-deliver records.
   The CRM upserts by ID. This makes cursor resets, overlap windows, and
   crash recovery all safe by construction.

---

## 2. Transport & Auth

- Base URL: the engine's Fly.io app URL, configured in CRM settings
  (`settings.engine.baseUrl`).
- Auth: single static API key, `Authorization: Bearer <key>`. Issued by the
  engine operator, stored in the CRM's masked settings store
  (`settings.engine.apiKey`). One key, one consumer. No OAuth, no refresh.
- All endpoints are read-only `GET`, JSON responses, UTF-8.
- All timestamps: UTC ISO-8601 strings.
- All IDs: engine-native opaque strings. Stable forever. Never reused.
- **Cold starts:** the engine host scales to zero. First request after idle
  may take ~2–5 s. CRM client timeout MUST be ≥ 15 s; a timeout is a normal
  failed tick, not an error worth alerting on (use the DrivePoller-style
  error throttle).

---

## 3. Cursor Semantics

*(Resolves PREP_PLAN §1.3 open question.)*

- The cursor is an **opaque string** minted by the engine. The CRM stores it
  per resource in `sync_cursors` (keys: `engine_sessions`, `engine_hands`)
  and echoes it back verbatim. The CRM MUST NOT parse or construct cursors.
- Request: `?cursor=<opaque>&limit=<n>` (limit: default 100, max 500).
- Response envelope (all cursored endpoints):

```json
{
  "data": [ ... ],
  "next_cursor": "opaque-string",
  "has_more": true
}
```

- First-ever pull: omit `cursor` → engine starts from the beginning of time.
- Engine guarantees: a **total, stable ordering** of records; resuming from a
  returned cursor never **skips** records; it MAY **re-deliver** records
  (at-least-once).
- `400 invalid_cursor` (e.g. after an engine data reset): the CRM clears the
  stored cursor and performs a full resync. Idempotent upserts make this safe.
- CRM advances its stored cursor only after a page is fully processed and
  committed (page-at-a-time, per PREP_PLAN §1.4).

---

## 4. Endpoints

### 4.1 `GET /export/v1/meta`
No cursor. Health + vocabulary handshake.

```json
{
  "engine_version": "1.0.0",
  "contract_version": 1,
  "tag_vocabulary_version": 3,
  "tags": [
    { "tag": "OPEN_LIMP", "tag_type": "mistake", "description": "..." },
    { "tag": "CBET_FLOP", "tag_type": "descriptor", "description": "..." }
  ]
}
```

- The CRM SHOULD pull this once per poller boot and when it encounters an
  unknown tag. Unknown tags are skipped-and-counted on the CRM side
  ("surfaced, never silent" — PREP_PLAN §3.2); they are never an error.
- The full tag list is **PROVISIONAL** until the engine PRD finalizes the
  analyzer set. The envelope shape is binding now.

### 4.2 `GET /export/v1/players`
No cursor — full snapshot every call (player counts are small; snapshot
semantics make unlinking/relinking trivially correct).

```json
{
  "data": [
    {
      "player_id": "ply_abc123",
      "display_name": "Dana K",
      "crm_student_id": "stu_01H...",
      "status": "active",
      "created_at": "2026-07-01T10:00:00Z"
    }
  ]
}
```

- `crm_student_id` is nullable — unlinked players exist and are simply not
  ingested by the CRM.
- `status`: `active | archived`.

### 4.3 `GET /export/v1/sessions?cursor=&limit=`
**Completed sessions only.** In-flight sessions are never exported.
A "session" = one continuous run of a table (a coached lesson, a cash-game
sitting, or one tournament).

```json
{
  "session_id": "ses_x1",
  "crm_entry_id": "les_01H... | null",
  "table_mode": "coached_cash | uncoached_cash | tournament",
  "started_at": "...", "ended_at": "...",
  "hand_count": 42,
  "coach_player_id": "ply_coach1",
  "participants": [
    {
      "player_id": "ply_abc123",
      "crm_student_id": "stu_01H...",
      "hands_played": 40,
      "net_chips": -1500,
      "finish_position": 3
    }
  ]
}
```

- `coach_player_id`: null for uncoached/tournament unless a coach ran it.
- `finish_position`: tournaments only, null otherwise.
- `crm_student_id` is denormalized onto participants so the CRM can attribute
  without joining the players snapshot.

### 4.4 `GET /export/v1/hands?cursor=&limit=`
**Completed hands only.** The core payload.

```json
{
  "hand_id": "hnd_9f",
  "session_id": "ses_x1",
  "table_mode": "coached_cash",
  "origin": "rng | manual | hybrid | scenario | replay_branch",
  "played_at": "...",
  "revision": 1,
  "review_url": "https://<engine-host>/review/hnd_9f",
  "board": ["Ah", "7d", "2c", "Ts", "3h"],
  "pot": 2400,
  "participants": [
    {
      "player_id": "ply_abc123",
      "crm_student_id": "stu_01H...",
      "position": "BTN",
      "hole_cards": ["As", "Kd"],
      "stack_start": 10000,
      "stack_end": 11200,
      "is_winner": true,
      "vpip": true, "pfr": true,
      "three_bet_opp": false, "three_bet": false,
      "saw_flop": true, "cbet_opp": true, "cbet": true,
      "wtsd": true, "wsd": true
    }
  ],
  "actions": [
    { "seq": 1, "player_id": "ply_abc123", "street": "preflop",
      "action": "raise", "amount": 300 }
  ],
  "tags": [
    { "tag": "CBET_FLOP", "tag_type": "descriptor",
      "player_id": "ply_abc123", "action_seq": 4 },
    { "tag": "OPEN_LIMP", "tag_type": "mistake",
      "player_id": "ply_def456", "action_seq": 1 },
    { "tag": "missed value on river", "tag_type": "coach",
      "player_id": "ply_abc123", "action_seq": null }
  ]
}
```

- **Per-participant booleans & opportunity counters** (`vpip`, `pfr`,
  `three_bet_opp`, `three_bet`, `saw_flop`, `cbet_opp`, `cbet`, `wtsd`,
  `wsd`) intentionally mirror the CRM's `ParsedHand` shape so stat merging
  and frequency-leak derivation (CRM outlier logic) are cheap regardless of
  the CRM's storage choice.
- **`origin` (stat-integrity critical):** how the hand's cards came to be.
  Coach-fabricated hands (`manual | hybrid | scenario | replay_branch`) MUST
  be excludable from CRM stat aggregates (VPIP/PFR/…) — counting a hand where
  the coach chose the student's cards corrupts cross-source stats. They remain
  valid evidence for leak observations. The CRM's counting policy is CRM-side;
  the engine only reports the fact. Enum values PROVISIONAL until engine PRD.
- `tag_type`: `descriptor | mistake | coach`. **Descriptors** are neutral
  facts (pot type, board texture, lines taken) — filtering/playlist material,
  never leak evidence. **Mistakes** are player-attributed judgments — the
  only auto-tags eligible to become CRM leak observations. **Coach** tags are
  free-text human judgments. The former `sizing` class is dropped — every
  action carries `amount` + pot context, so sizing ratios are derivable by
  any consumer.
- `action_seq` (nullable): the action that triggered the tag, referencing
  `actions[].seq`. Mistakes SHOULD carry it (decision-level evidence +
  review jump-to). Hand-level descriptors carry `player_id: null,
  action_seq: null`.

### 4.6 `GET /export/v1/playlists`
No cursor — full catalog snapshot (small). Purpose: the CRM's lesson editor
attaches a playlist to a lesson **by reference**. Scenarios/playlists are
authored and stored in the engine ONLY; the CRM holds the lesson↔playlist
link, never the content.

```json
{
  "data": [
    {
      "playlist_id": "pls_a1",
      "name": "3-bet pots OOP",
      "description": "...",
      "scenario_count": 8,
      "updated_at": "..."
    }
  ]
}
```

### 4.5 Hand revisions (coach re-tagging)
Coaches edit tags during review, after a hand was already exported. Handling:

- Every hand carries an integer `revision` (starts at 1).
- When tags change post-export, the engine **re-emits the full hand** later in
  the cursor stream with `revision` incremented.
- CRM rule: upsert by `hand_id`; apply only if incoming `revision` ≥ stored.
- Derived `leak_observations` already written are NOT retracted (append-only
  invariant on the CRM side); the CRM MAY emit new observations from newly
  added `mistake` tags on a revision.

---

### 4.7 `GET /export/v1/tournament-presets`
No cursor — full catalog snapshot, same pattern as §4.6. The CRM's tournament
timeblock editor attaches a preset **by reference**; blind structures,
payouts, and stacks are authored and stored in the engine only.

```json
{
  "data": [
    { "preset_id": "tpr_a1", "name": "Weekly Turbo",
      "description": "...", "updated_at": "..." }
  ]
}
```

## 5. Tag Confidence & Severity

*(Resolves PREP_PLAN §3.3 open questions — answers to the contract.)*

- The engine does **not** export per-tag confidence. Its tags are
  deterministic rule outputs, not probabilistic guesses; a confidence number
  would be theater.
- The CRM assigns fixed confidence by `tag_type`:
  `mistake` > `auto`-derived outliers > nothing for `sizing` alone.
  Suggested band per PREP_PLAN: ~0.5–0.6 stored, below `session`, above
  `hand_history` volume outliers. Engine observations stay **out of the
  mastery gate** until the source is trusted.
- The engine does **not** assert severity. The CRM derives it from tag
  frequency — and it has everything it needs, because it receives every hand
  (counts are implicit; no extra endpoint required).

---

## 6. Mutual Guarantees

**Engine guarantees:**
- Exports only completed sessions/hands — never in-flight state.
- IDs are permanent; hands are immutable except via the `revision` mechanism.
- Additive changes (new fields, new tags) do NOT bump the version. Breaking
  changes ship as `/export/v2/` with `/v1/` kept alive through a migration
  window.

**CRM guarantees:**
- Students linked from the engine are **soft-deleted only** (resolves
  PREP_PLAN §4.1 dangling-ID risk). If a hard-delete is ever unavoidable, the
  operator unlinks on the engine side first.
- Unknown `crm_student_id` → surfaced as an operator mis-link, never silently
  dropped (PREP_PLAN §4).
- Ingestion is idempotent (upsert by ID), tolerating re-delivery and resyncs.
- **Observation dedup:** `leak_observations` is append-only with no unique
  constraint, so the CRM derives observations from a hand **only** on first
  ingest of its `hand_id`, or on a `revision` increment (and then only from
  newly added tags). Re-delivered records never re-emit observations.
- **Per-participant attribution:** a hand/session is ingested for every
  participant with a non-null `crm_student_id`; null participants (the coach,
  unlinked guests) are skipped silently — a record is never parked because of
  them. Only a record whose participants are ALL null is skipped-and-counted.

---

## 7. Errors

| Status | Code | CRM behavior |
|--------|------|--------------|
| 401 | `invalid_api_key` | Stop polling, surface in settings UI |
| 400 | `invalid_cursor` | Clear cursor, full resync |
| 429 | `rate_limited` | Skip tick, retry next interval |
| 5xx | — | Failed tick, error-throttled log, retry next interval |

---

## 8. Lesson Sync (CRM → Engine)

The one reverse channel. Justification: the CRM host cannot receive requests
(no public URL) but sends them freely (it already calls Google/Anthropic).
The engine never initiates contact with the CRM.

- `PUT /sync/v1/lessons` on the engine. Same static API key (§2).
- **Declarative snapshot semantics.** The body is the FULL set of upcoming
  schedule entries — lessons AND tournament timeblocks — within the CRM's
  horizon (default: 14 days). The engine reconciles: creates a scheduled
  coached table or tournament per new entry, updates changed ones,
  removes scheduled ones whose entry disappeared — and NEVER touches a
  table whose session already started. Cancellations and reschedules are
  handled by construction; no event/delta protocol.
- Idempotent; safe to push on every scheduler tick (suggest the CRM's
  AutomationScheduler cadence, ~5 min).

Per-entry payload (`type` discriminates):

```json
{
  "crm_entry_id": "les_01H...",
  "type": "lesson | tournament",
  "title": "Group — 3-bet pots",
  "scheduled_start": "...", "scheduled_end": "...",
  "student_crm_ids": ["stu_01H...", "stu_01J..."],
  "playlist_id": "pls_a1",
  "tournament_preset_id": null
}
```

- `type: "lesson"` → scheduled coached table; `playlist_id` (engine-native,
  §4.6) preloaded, nullable.
- `type: "tournament"` → scheduled tournament built from
  `tournament_preset_id` (§4.7). Structure (blinds, payouts, stacks) lives in
  the engine preset; the CRM only schedules and lists participants — the
  playlist pattern applied to tournaments.
- **Seat restriction is a soft default**: seats/registration limited to
  players mapped to the listed `crm_student_ids` plus the coach, but the
  coach can override from the table and seat any existing engine player.
  Unmapped `crm_student_ids` never block creation — they are surfaced to the
  coach in the engine UI.
- Exported sessions (§4.3) carry `crm_entry_id`, closing the loop
  entry → session → hands in the CRM.

---

## 9. Open Items (non-blocking, tracked)

| # | Item | Owner | Blocked on |
|---|------|-------|-----------|
| 1 | Final tag vocabulary | Engine | Engine PRD (analyzer redesign) |
| 2 | Tournament session extras (buy-in, re-entries count) | Engine | Engine PRD tournament spec |
| 3 | `TAG_MAPPING.md` full population | CRM | Item 1 |
| 4 | CRM storage choice (Option 1/2 from PREP_PLAN §2) | CRM | Operator decision — recommendation on file: Option 2 |
