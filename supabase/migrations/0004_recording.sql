-- 0004 — hand recording (CONTRACT §4.3–4.4 shapes, storage side) + table
-- seat snapshots (RUNTIME §1: stacks persisted after every completed hand).

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  table_id      uuid not null references tables(id),
  table_mode    text not null check (table_mode in
                  ('coached_cash', 'uncoached_cash', 'tournament')),
  crm_entry_id  text,
  status        text not null default 'open'
                check (status in ('open', 'completed')),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  hand_count    integer not null default 0
);

create index sessions_status_idx on sessions (status);

create table hands (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references sessions(id),
  -- Full CONTRACT enum from day one; M2 only ever writes 'rng'.
  origin      text not null check (origin in
                ('rng', 'manual', 'hybrid', 'scenario', 'replay_branch')),
  played_at   timestamptz not null default now(),
  board       jsonb not null default '[]'::jsonb,
  pot         bigint not null,
  revision    integer not null default 1
);

create index hands_session_idx on hands (session_id, played_at);

create table hand_participants (
  hand_id        uuid not null references hands(id),
  player_id      uuid not null references players(id),
  position       text not null,
  hole_cards     jsonb,
  stack_start    bigint not null,
  stack_end      bigint not null,
  is_winner      boolean not null default false,
  vpip           boolean not null default false,
  pfr            boolean not null default false,
  three_bet_opp  boolean not null default false,
  three_bet      boolean not null default false,
  saw_flop       boolean not null default false,
  cbet_opp       boolean not null default false,
  cbet           boolean not null default false,
  wtsd           boolean not null default false,
  wsd            boolean not null default false,
  primary key (hand_id, player_id)
);

create index hand_participants_player_idx on hand_participants (player_id);

create table hand_actions (
  hand_id    uuid not null references hands(id),
  seq        integer not null,
  player_id  uuid references players(id),
  street     text not null check (street in
               ('preflop', 'flop', 'turn', 'river')),
  action     text not null check (action in
               ('post_sb', 'post_bb', 'fold', 'check', 'call', 'bet', 'raise')),
  amount     bigint not null default 0,
  primary key (hand_id, seq)
);

-- Seat snapshot for crash recovery (RUNTIME §1). Written after every
-- completed hand; a hand in flight is never recoverable — on boot the
-- table is rebuilt from this snapshot, which voids the in-flight hand
-- by construction.
alter table tables add column seats jsonb not null default '[]'::jsonb;
