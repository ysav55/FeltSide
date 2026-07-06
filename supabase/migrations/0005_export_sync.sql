-- 0005 — M3: export stream (CONTRACT §3–4) + scheduled tables (CONTRACT §8).

-- One global sequence feeds both exported resources; each resource's cursor
-- orders by its own column, so per-resource ordering is total and stable.
create sequence export_seq;

-- Stamped under an advisory lock held to commit (see recordingRepo):
-- assignment order == commit order == visibility order, so a poll can never
-- observe seq N while seq M < N is still uncommitted ("resume never skips").
-- Sessions are stamped at finalize (completed-only export); hands at insert
-- (a recorded hand IS complete) and re-stamped on a revision bump so the
-- hand re-enters the stream (CONTRACT §4.5).
alter table sessions add column export_seq bigint;
alter table hands add column export_seq bigint;

create unique index sessions_export_seq_idx on sessions (export_seq)
  where export_seq is not null;
create unique index hands_export_seq_idx on hands (export_seq)
  where export_seq is not null;

-- Scheduled entries pushed by the CRM (CONTRACT §8). Times get dedicated
-- columns (lobby ordering, RUNTIME §3 24h prune); title/playlist/preset/
-- seat-list/unmapped-ids live in the existing config jsonb.
alter table tables add column scheduled_start timestamptz;
alter table tables add column scheduled_end timestamptz;
