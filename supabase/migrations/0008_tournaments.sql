-- 0008 — M7: tournaments (TOURNAMENTS.md).

-- BB ante (TOURNAMENTS §1): a new recorded action type.
-- CHECK constraints are not enums — drop and recreate to widen.
alter table hand_actions drop constraint if exists hand_actions_action_check;
alter table hand_actions add constraint hand_actions_action_check
  check (action in ('post_sb', 'post_bb', 'post_ante', 'fold', 'check', 'call', 'bet', 'raise'));

-- Presets (§1): coach-editable engine-side objects; exported §4.7.
create table tournament_presets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  config      jsonb not null,     -- full §1 preset shape
  created_by  uuid references players(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per tournament instance. Anchored to a lobby `tables` row
-- (mode='tournament') which carries crm_entry_id / scheduling / status.
-- `config` snapshots the preset at creation (presets stay editable without
-- shifting a live tournament); `state` is the RUNTIME §1 safety snapshot:
-- clock (level, ms remaining, break) persisted on every level change and
-- 30s tick, plus the seats layout after every completed hand.
create table tournaments (
  id            uuid primary key default gen_random_uuid(),
  table_id      uuid not null references tables(id) unique,
  preset_id     uuid references tournament_presets(id),
  config        jsonb not null,
  status        text not null default 'registering'
                check (status in ('registering', 'running', 'completed')),
  state         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz
);

-- One row per (tournament, player): registration, re-entries, add-on,
-- finish + payout. total_paid feeds the closed-economy prize pool (§5).
create table tournament_entries (
  tournament_id  uuid not null references tournaments(id),
  player_id      uuid not null references players(id),
  entries        integer not null default 1,     -- 1 + re-entries
  addon          boolean not null default false,
  total_paid     bigint not null,
  finish_position integer,
  payout         bigint not null default 0,
  eliminated_at  timestamptz,
  created_at     timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

create index tournament_entries_tid_idx on tournament_entries (tournament_id);
