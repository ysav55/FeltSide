# PRD.md — Poker Engine (Full Rebuild) — v1

> Supersedes PRD_SKELETON.md. This is the master document for
> implementation agents. Detailed specs live in their own files and are
> BINDING parts of this PRD:
>
> - **CONTRACT.md** — engine ⇄ CRM integration (export API, lesson sync)
> - **TAXONOMY.md** — tag vocabulary, chart engine, analyzer settings
> - **DEALING.md** — card control panel & street-by-street dealing
> - **TOURNAMENTS.md** — presets, lifecycle, balancing, payouts
> - **RUNTIME.md** — table lifecycle, crash recovery, bankroll ledger
>
> Nothing from the old codebase is assumed correct. Reuse only per §9.

---

## 1. Product Definition

A poker game engine for a single poker school: live coached tables,
autonomous multiplayer cash games, and MTT tournaments — with full hand
recording, auto-tagging, and replay/review. It is the gameplay half of a
two-product system; the other half is **epoker-crm** (student registry,
lessons, leaks, reports).

**Deliberately NOT in this product:** CRM features (notes, alerts,
reports, baselines), staking, schools/multi-tenancy, bot tables,
leaderboard, announcements, trial accounts, self-registration, spectator
as a user-facing feature, CRM-side scenario authoring.

Single-tenant, one operator-coach — but an owner/coach ID is threaded on
stored rows so a future multi-coach lift is configuration, not migration.

## 2. Users, Identity & Auth

- **Coach (operator):** full control; creates all player accounts.
- **Players:** email + password issued by the coach (changeable at first
  login). No self-registration, no reset flows.
- Player accounts carry optional `crm_student_id` (`stu_{ULID}`), mapped
  manually. The CRM is the canonical person registry; the engine owns
  auth.
- **Spectator is a technical state** (group review, coach drop-in), not a
  role. Roles: coach / player, one enforcement path, hierarchy respected
  everywhere (the old dual RBAC/hardcoded mess is a named anti-goal).

## 3. Game Modes

### 3.1 Coached table (the heart)
- Coach seated or not, both first-class; 1:1 → coach plays.
- Full card control per **DEALING.md**: per-slot manual / RNG / range-draw,
  partial specification, street-by-street dealing mid-hand
  (`awaiting_deal` state), re-deal, save-as-scenario. The dealing panel IS
  the scenario builder.
- Visibility: hole cards always closed in the shared UI; the coach's
  sidebar shows only what he assigned; pure-RNG cards hidden from him too.
- Controls: pause/resume, undo, street rollback, stack adjust, blind
  change, force street, award pot, live tagging without stopping play.
- Coach-set stacks; bankroll never involved.
- Origin computed per hand: `rng | manual | hybrid | scenario |
  replay_branch` (stat-integrity critical, CONTRACT §4.4).

### 3.2 Uncoached cash
- Player-created from the thin lobby; RNG auto-deal only.
- Buy-in from persistent bankroll (RUNTIME §5); sit-out/sit-in; re-entry
  after bust; 30s action timer.
- Coach may spectate or join opportunistically; no monitoring apparatus.

### 3.3 Tournaments — per **TOURNAMENTS.md**
Autonomous lifecycle, engine-side presets, TDA-derived auto-balancing with
manual override, standard small-field payouts from the closed bankroll
economy, hand-for-hand at the bubble, ICM overlay & deals as teaching
flags, coach seated-not-managing or managing-not-seated.

## 4. Scenarios & Playlists

Authored and stored in the engine only; the CRM links lessons to playlists
by reference (CONTRACT §4.6). Scenario = the dealing-panel config shape
(cards/ranges, board, positions, stacks, street policy); playlist =
ordered scenarios. Single schema generation — the old dual-table
duplication (DUP-03/04) must not be rebuilt. Activating a playlist at a
coached table runs its scenarios in order with per-drill re-deal.

## 5. Review & Replay

- Dedicated review page; action-by-action replay, jump-to, annotations.
- Branch-to-live and unbranch ("what if you had bet here").
- Group transition: coach sends the whole table to review and back;
  independent per table, parallel reviews across groups.
- Every hand has a stable `review_url` deep link (exported).
- Post-review retags re-emit the hand with `revision`+1 (CONTRACT §4.5).

## 6. Hand Recording & Analyzers

Every completed hand records board, pot, full action sequence, and
per-participant results + booleans/opportunity counters (CONTRACT §4.4).
Analyzers per **TAXONOMY.md**: descriptor/mistake classes, `action_seq` on
every tag, chart engine (9-max opens + blind-defense, seeded standard
ranges), and the Analyzer Settings page (charts, kill switches,
thresholds; non-retroactive). Frequency leaks are NOT engine tags — the
CRM derives them from exported counters.

## 7. Lobby & Scheduling

Thin lobby: joinable tables list, nothing else. Scheduled coached tables
and tournaments materialize from the CRM's declarative push (CONTRACT §8),
bound to `crm_entry_id`, playlist/preset preloaded, seats soft-restricted
to the entry's mapped students (coach can always override). Players create
uncoached tables. Cleanup and never-started removal per RUNTIME §3.

## 8. Integration

CONTRACT.md is binding and stable. Summary: cursored at-least-once export
(`/export/v1/`: meta, players, sessions, hands, playlists,
tournament-presets), one static API key, inbound `PUT /sync/v1/lessons`,
Fly scale-to-zero tolerated (RUNTIME §1 guard: never sleep with active
tables).

## 9. Reuse Policy

- **Adopt (proven pure):** HandEvaluator, ShowdownResolver,
  SidePotCalculator, bettingRound, Deck, RangeParser, positions,
  BoardGenerator, EquityService, comboUtils. HandGenerator only with
  ARCH-10 fixed (silent texture fallback → visible error).
- **Built new in M4 (amended per decisions/0004):** the range matrix and
  range picker — they power the chart editor, range-deal, and scenario
  ranges. The old repo never contained them; `legacy/extracted/*` (preset
  vocabulary, combo intersection, board texture) is raw material only,
  not a module to graduate.
- **Audit before adoption:** ReplayEngine (fix mutation-by-reference /
  ARCH-05), PokerTable, BettingControls — judged individually.
- **Rebuild lean, never adopt:** GameManager and successors, controllers,
  socket layer, auth middleware, SharedState.
- **"Proven good" bar:** zero old-world imports; passes a NEW test suite
  written against this PRD (not old behavior); all registered findings on
  the module fixed at migration.

## 10. Stack

React client, Node + socket.io server, relational DB, Fly.io host —
carried as defaults, revisit only with a concrete reason. Real-time play
over sockets; REST for export/sync/auth.

## 11. Build Order (for implementation agents)

Each milestone ends runnable and testable. Do not start a milestone with
unresolved questions — escalate instead.

- **M1 — Foundation:** DB schema core, auth (coach-issued accounts,
  `crm_student_id`), bankroll ledger (RUNTIME §5), thin lobby shell.
- **M2 — Uncoached loop end-to-end:** rebuilt lean game core + adopted
  pure modules, uncoached cash mode complete (buy-in → hands → recording
  with origin/booleans → cash-out), disconnect/cleanup rules (RUNTIME
  §2–3). *The simplest full vertical slice — proves the engine.*
- **M3 — Export & sync:** the entire CONTRACT surface (tags may export
  empty until M5). Unblocks the CRM side go-live against a real engine.
- **M4 — Coached mode:** dealing panel (DEALING.md, incl. street-by-street
  state machine), coach controls, visibility rules, scenarios/playlists,
  lesson-sync table materialization.
- **M5 — Analyzers:** TAXONOMY.md pipeline, chart engine, settings page;
  tags flow into the already-live export; freeze vocabulary → notify CRM
  agent to populate TAG_MAPPING.
- **M6 — Review:** replay, annotations, branch, group transition,
  review_url, revision re-emit.
- **M7 — Tournaments:** TOURNAMENTS.md in full.

## 12. Cross-Cutting Rules

- Completed-only exports; a session/hand exports exactly once per
  revision.
- Soft limits everywhere the coach is concerned — restrictions guide,
  never block him.
- No console.log debug in committed code; every endpoint has auth
  middleware; migrations append-only. (The old standing rules survive.)
- UI language: **English** (decided 2026-07).
