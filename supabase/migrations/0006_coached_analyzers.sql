-- 0006 — M4/M5: coached mode, scenarios/playlists, hand tags, analyzer
-- settings, action undo marking.

-- Coached sessions carry their coach (CONTRACT §4.3 coach_player_id).
alter table sessions add column coach_player_id uuid references players(id);

-- Undone actions are MARKED, never erased (M4 coach controls). Reverted
-- actions stay in the log and the export (additive field, CONTRACT §6);
-- counters and analyzers ignore them.
alter table hand_actions add column reverted boolean not null default false;

-- Tags (TAXONOMY): analyzer descriptors/mistakes (M5) + live coach tags (M4).
create table hand_tags (
  id          bigserial primary key,
  hand_id     uuid not null references hands(id),
  tag         text not null,
  tag_type    text not null check (tag_type in ('descriptor', 'mistake', 'coach')),
  player_id   uuid references players(id),
  action_seq  integer,
  created_at  timestamptz not null default now()
);
create index hand_tags_hand_idx on hand_tags (hand_id);

-- Scenario = the dealing-panel config shape; playlist = ordered scenarios.
-- ONE schema generation (PRD §4) — the panel and the builder share it.
create table scenarios (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  config      jsonb not null,
  created_by  uuid references players(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table playlists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_by  uuid references players(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table playlist_scenarios (
  playlist_id uuid not null references playlists(id) on delete cascade,
  scenario_id uuid not null references scenarios(id),
  position    integer not null,
  primary key (playlist_id, position)
);

-- Analyzer settings (TAXONOMY §6): coach-tuned overrides over the seeded
-- defaults (charts, kill switches, thresholds). Non-retroactive by design —
-- analyzers read a snapshot at hand completion.
create table engine_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
