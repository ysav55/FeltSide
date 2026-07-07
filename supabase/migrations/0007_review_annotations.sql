-- 0007 — M6: review annotations + auto-tag dismissal.

-- Coach can dismiss an auto (descriptor/mistake) tag during review. Dismissed
-- tags are kept (audit) but excluded from the export (CONTRACT §4.4 tags[]).
alter table hand_tags add column dismissed boolean not null default false;

-- Coach annotations pinned to an action index of a hand. Engine-side ONLY —
-- deliberately NOT in the export (CONTRACT has no annotation field, M6 §3).
create table hand_annotations (
  id            uuid primary key default gen_random_uuid(),
  hand_id       uuid not null references hands(id),
  action_index  integer not null,          -- replay cursor the note is pinned to
  body          text not null,
  created_by    uuid references players(id),
  created_at    timestamptz not null default now()
);

create index hand_annotations_hand_idx on hand_annotations (hand_id);
