-- 0002 — bankroll ledger (RUNTIME.md §5, M1 §2/§4)
-- Immutable transaction log + derived balance, written atomically.

create table bankroll_accounts (
  player_id   uuid primary key references players(id),
  balance     bigint not null default 0 check (balance >= 0),
  updated_at  timestamptz not null default now()
);

create table bankroll_transactions (
  id             uuid primary key default gen_random_uuid(),
  player_id      uuid not null references players(id),
  type           text not null check (type in (
                   'coach_adjustment', 'buy_in', 'cash_out',
                   'tournament_buy_in', 'tournament_reentry',
                   'tournament_addon', 'tournament_payout'
                 )),
  amount         bigint not null,          -- signed
  ref_id         text,                     -- table / tournament id
  note           text,                     -- coach_adjustment reason
  balance_after  bigint not null,
  created_at     timestamptz not null default now()
);

create index bankroll_transactions_player_idx
  on bankroll_transactions (player_id, created_at);

-- Atomic apply: balance update + transaction insert in one call.
-- The UPDATE takes a row lock, serializing concurrent applies per player;
-- the CHECK (balance >= 0) makes a negative balance impossible.
create function apply_bankroll_transaction(
  p_player_id uuid,
  p_type      text,
  p_amount    bigint,
  p_ref_id    text default null,
  p_note      text default null
) returns bankroll_transactions
language plpgsql
as $$
declare
  v_balance bigint;
  v_tx      bankroll_transactions;
begin
  update bankroll_accounts
     set balance = balance + p_amount,
         updated_at = now()
   where player_id = p_player_id
  returning balance into v_balance;

  if not found then
    raise exception 'bankroll_account_missing';
  end if;

  insert into bankroll_transactions
    (player_id, type, amount, ref_id, note, balance_after)
  values
    (p_player_id, p_type, p_amount, p_ref_id, p_note, v_balance)
  returning * into v_tx;

  return v_tx;
end;
$$;
