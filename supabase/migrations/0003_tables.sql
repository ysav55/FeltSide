-- 0003 — tables (M1 §2; lifecycle beyond listing is M2+)
create table tables (
  id            uuid primary key default gen_random_uuid(),
  mode          text not null check (mode in
                  ('coached_cash', 'uncoached_cash', 'tournament')),
  status        text not null default 'open' check (status in
                  ('scheduled', 'open', 'active', 'completed')),
  created_by    uuid references players(id),
  config        jsonb not null default '{}'::jsonb,
  crm_entry_id  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index tables_status_idx on tables (status);
