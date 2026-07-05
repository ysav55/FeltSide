-- 0001 — players (PRD §2, M1 §2)
create table players (
  id                    uuid primary key default gen_random_uuid(),
  display_name          text not null,
  email                 text not null unique,
  password_hash         text not null,
  role                  text not null check (role in ('coach', 'player')),
  crm_student_id        text,
  must_change_password  boolean not null default false,
  status                text not null default 'active'
                        check (status in ('active', 'archived')),
  owner_coach_id        uuid references players(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index players_role_idx on players (role);
