import { useEffect, useState } from 'react';
import { api } from '../api.js';

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Client-side countdown from the last server snapshot. */
function useCountdown(msRemaining, frozen) {
  const [left, setLeft] = useState(msRemaining);
  useEffect(() => {
    setLeft(msRemaining);
    if (frozen) return undefined;
    const receivedAt = Date.now();
    const id = setInterval(
      () => setLeft(Math.max(0, msRemaining - (Date.now() - receivedAt))),
      500
    );
    return () => clearInterval(id);
  }, [msRemaining, frozen]);
  return left;
}

/** Tournament table top-bar (M7 §9): level, blinds, clock, field, money. */
export function TournamentTopBar({ tournament, paused }) {
  const left = useCountdown(tournament.msRemaining, paused);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-4 py-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
      <span className={`font-mono text-lg ${tournament.onBreak ? 'text-sky-300' : 'text-emerald-300'}`}>
        {fmtClock(left)}
      </span>
      {tournament.onBreak ? (
        <span className="text-sky-300 font-medium">Break</span>
      ) : (
        <span className="text-slate-300">Level {tournament.level}</span>
      )}
      <span className="text-slate-300 font-mono">
        {fmt(tournament.smallBlind)}/{fmt(tournament.bigBlind)}
        {tournament.ante > 0 && <span className="text-slate-500"> ante {fmt(tournament.ante)}</span>}
      </span>
      <span className="text-slate-400">
        {tournament.playersLeft}/{tournament.entrants} left
      </span>
      <span className="text-slate-400">avg {fmt(tournament.avgStack)}</span>
      <span className="text-amber-300 font-mono">pool {fmt(tournament.prizePool)}</span>
      {tournament.handForHand && (
        <span className="rounded-full bg-rose-950 border border-rose-800 text-rose-300 px-2 py-0.5 text-xs">
          hand-for-hand
        </span>
      )}
      {paused && <span className="text-sky-300">paused</span>}
    </div>
  );
}

/** Pre-start lobby (§3 registering): entrants, payouts, register/start. */
export function TournamentLobby({ tableId, tournament, player, onError, onUpdate }) {
  const [busy, setBusy] = useState(false);
  const registered = tournament.myEntry.registered;
  const isCoach = player.role === 'coach';

  async function post(path) {
    setBusy(true);
    try {
      const res = await api(path, { method: 'POST' });
      if (res?.table) onUpdate?.(res.table);
    } catch (err) {
      onError?.(err.message === 'insufficient_balance'
        ? 'Not enough bankroll for the buy-in.'
        : err.message.replaceAll('_', ' '));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-emerald-900 bg-emerald-950/30 p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">Registration open</h2>
          {tournament.scheduledStart && (
            <p className="text-slate-400 text-sm">
              Starts {new Date(tournament.scheduledStart).toLocaleString([], {
                weekday: 'short', hour: '2-digit', minute: '2-digit',
              })} — auto-starts with 4+ players
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="text-amber-300 font-mono">pool {fmt(tournament.prizePool)}</div>
          <div className="text-slate-400 text-sm">{tournament.entrants} registered</div>
        </div>
      </div>

      {tournament.payouts.length > 0 && (
        <div className="text-sm text-slate-400">
          Pays {tournament.payouts.length}:{' '}
          <span className="font-mono text-slate-300">
            {tournament.payouts.map((p) => fmt(p)).join(' / ')}
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {tournament.registered.map((name) => (
          <span key={name} className="rounded-full bg-slate-800 px-3 py-1 text-sm">{name}</span>
        ))}
        {tournament.registered.length === 0 && (
          <span className="text-slate-500 text-sm">No entrants yet.</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {!registered && player.role !== 'coach' && (
          <button
            disabled={busy}
            onClick={() => post(`/tournaments/${tableId}/register`)}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 font-medium"
          >
            Register
          </button>
        )}
        {registered && (
          <span className="text-emerald-300 text-sm">You are registered ✓</span>
        )}
        {isCoach && (
          <button
            disabled={busy || tournament.entrants < 2}
            onClick={() => post(`/tournaments/${tableId}/start`)}
            className="rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 font-medium"
          >
            Start now
          </button>
        )}
      </div>
    </div>
  );
}

/** Standings with the ICM overlay (§7) when the preset enables it. */
export function TournamentStandings({ tournament }) {
  const [open, setOpen] = useState(false);
  const icm = tournament.icm;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2 flex items-center justify-between text-sm text-slate-300"
      >
        <span>Standings{icm ? ' · ICM $EV' : ''}</span>
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="px-4 pb-3 space-y-1 text-sm max-h-64 overflow-y-auto">
          {tournament.standings.map((s) => (
            <li key={`${s.playerId}-${s.rank}`} className="flex items-center justify-between gap-2">
              <span className={s.eliminated ? 'text-slate-500 line-through' : ''}>
                {s.rank}. {s.name}
                {s.tableNo != null && !s.eliminated && tournament.standings.some((x) => x.tableNo !== s.tableNo && !x.eliminated) && (
                  <span className="text-slate-500 text-xs ml-1">T{s.tableNo}</span>
                )}
              </span>
              <span className="font-mono text-slate-300">
                {s.eliminated ? 'out' : fmt(s.stack)}
                {icm && icm[s.playerId] != null && (
                  <span className="text-emerald-400 ml-2">${fmt(icm[s.playerId])}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Final-table ICM deal proposal (§7): unanimous accept ends the tournament. */
export function DealBanner({ tableId, tournament, player, onError }) {
  const deal = tournament.deal;
  if (!deal) return null;
  const mine = deal.amounts[player.id];
  const accepted = deal.accepted.includes(player.id);
  return (
    <div className="rounded-xl border border-violet-800 bg-violet-950/40 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-violet-200 font-medium">ICM deal proposed</span>
        <span className="text-violet-300 text-sm">
          {deal.accepted.length}/{Object.keys(deal.amounts).length} accepted
        </span>
      </div>
      <div className="text-sm text-slate-300 font-mono">
        {Object.values(deal.amounts).map((a) => fmt(a)).join(' / ')}
      </div>
      {mine != null && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-300">
            Your share: <span className="font-mono text-emerald-300">{fmt(mine)}</span>
          </span>
          {!accepted ? (
            <button
              onClick={async () => {
                try { await api(`/tournaments/${tableId}/deal/accept`, { method: 'POST' }); }
                catch (err) { onError?.(err.message.replaceAll('_', ' ')); }
              }}
              className="rounded-md bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-sm font-medium"
            >
              Accept deal
            </button>
          ) : (
            <span className="text-emerald-300 text-sm">accepted ✓</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Bust panel: re-entry while the window is open; final result otherwise. */
export function BustPanel({ tableId, tournament, onError }) {
  const entry = tournament.myEntry;
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-4 flex items-center gap-3 flex-wrap">
      {entry.finishPosition && tournament.status === 'completed' ? (
        <span className="text-amber-200">
          You finished <strong>#{entry.finishPosition}</strong>
          {entry.payout > 0 && <> — payout <span className="font-mono text-emerald-300">{fmt(entry.payout)}</span></>}
        </span>
      ) : (
        <span className="text-amber-200 text-sm">You busted.</span>
      )}
      {entry.canReenter && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await api(`/tournaments/${tableId}/reenter`, { method: 'POST' }); }
            catch (err) {
              onError?.(err.message === 'insufficient_balance'
                ? 'Not enough bankroll to re-enter.' : err.message.replaceAll('_', ' '));
            } finally { setBusy(false); }
          }}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-sm font-medium"
        >
          Re-enter (fresh stack)
        </button>
      )}
    </div>
  );
}

/** Add-on offer during a break (§1). */
export function AddonBanner({ tableId, onError }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-lg border border-sky-800 bg-sky-950/40 px-4 py-2 flex items-center gap-3">
      <span className="text-sky-200 text-sm">Break — add-on available.</span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await api(`/tournaments/${tableId}/addon`, { method: 'POST' }); }
          catch (err) { onError?.(err.message.replaceAll('_', ' ')); }
          finally { setBusy(false); }
        }}
        className="rounded-md bg-sky-700 hover:bg-sky-600 disabled:opacity-50 px-3 py-1 text-sm"
      >
        Take add-on
      </button>
    </div>
  );
}

/**
 * Coach tournament panel (§6, §9): fast table switching (no grid in v1),
 * clock/level interventions, balance control, end-early, deal proposal.
 */
export function TournamentCoachPanel({ table, coach, send, onEnded, onError }) {
  const [moving, setMoving] = useState(null); // playerId being moved
  const tournament = table.tournament;

  const cmd = (command, payload = {}) => send(command, payload, (res) => {
    if (res?.error) onError?.(res.error.replaceAll('_', ' '));
  });

  const freeSeats = (t) => {
    const taken = new Set(t.seats.map((s) => s.seatIndex));
    const size = table.config.tableSize;
    return Array.from({ length: size }, (_, i) => i).filter((i) => !taken.has(i));
  };

  return (
    <div className="rounded-xl border border-indigo-900 bg-indigo-950/30 p-4 space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-indigo-200">Tournament controls</span>
        <span className="text-slate-400">
          auto-balance {coach.autoBalance ? 'on' : 'off'}
        </span>
      </div>

      {/* Fast table switching (§9) */}
      {coach.tables.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-slate-400">View:</span>
          {coach.tables.map((t) => (
            <button
              key={t.no}
              onClick={() => cmd('view-table', { table_no: t.no })}
              className={`rounded-md px-3 py-1 ${table.viewingTableNo === t.no
                ? 'bg-indigo-600' : 'bg-slate-800 hover:bg-slate-700'}`}
            >
              T{t.no} · {t.players}{t.handRunning ? ' ▶' : ''}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => cmd('pause', { paused: !table.paused })}
          className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1">
          {table.paused ? 'Resume' : 'Pause'}
        </button>
        <button onClick={() => cmd('advance-level')}
          className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1">
          Advance level
        </button>
        <button onClick={() => cmd('extend-level', { ms: 5 * 60_000 })}
          className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1">
          +5 min level
        </button>
        <button onClick={() => cmd('auto-balance', { on: !coach.autoBalance })}
          className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1">
          {coach.autoBalance ? 'Disable balance' : 'Enable balance'}
        </button>
        {tournament.status === 'running' && !tournament.deal && (
          <button onClick={() => cmd('deal:propose')}
            className="rounded-md bg-violet-800 hover:bg-violet-700 px-3 py-1">
            Propose ICM deal
          </button>
        )}
        {tournament.deal && (
          <button onClick={() => cmd('deal:cancel')}
            className="rounded-md bg-violet-900 hover:bg-violet-800 px-3 py-1">
            Cancel deal
          </button>
        )}
        <button
          onClick={() => {
            if (window.confirm('End the tournament now and pay by chip count?')) {
              send('end-early', {}, (res) => {
                if (res?.error) onError?.(res.error.replaceAll('_', ' '));
                else onEnded?.();
              });
            }
          }}
          className="rounded-md bg-rose-900/70 hover:bg-rose-900 px-3 py-1"
        >
          End early
        </button>
      </div>

      {/* Manual move / eliminate (§4 manual balance, §6) */}
      <div className="space-y-1">
        {coach.tables.map((t) => (
          <div key={t.no} className="flex flex-wrap items-center gap-1">
            <span className="text-slate-500 w-8">T{t.no}</span>
            {t.seats.map((s) => (
              <span key={s.playerId} className="rounded bg-slate-800 px-2 py-0.5 flex items-center gap-1">
                {s.name}
                {moving === s.playerId ? (
                  <span className="flex gap-1">
                    {coach.tables.filter((d) => d.no !== t.no || freeSeats(d).length > 0).map((d) => (
                      <button
                        key={d.no}
                        onClick={() => {
                          const seat = freeSeats(d)[0];
                          if (seat === undefined) return onError?.('table full');
                          cmd('move', { player_id: s.playerId, table_no: d.no, seat_index: seat });
                          setMoving(null);
                        }}
                        className="text-indigo-300 hover:text-indigo-100"
                      >
                        →T{d.no}
                      </button>
                    ))}
                    <button onClick={() => setMoving(null)} className="text-slate-500">✕</button>
                  </span>
                ) : (
                  <>
                    {coach.tables.length > 1 && (
                      <button onClick={() => setMoving(s.playerId)}
                        title="Move player" className="text-slate-500 hover:text-slate-300">⇄</button>
                    )}
                    <button
                      onClick={() => {
                        if (window.confirm(`Eliminate ${s.name}? Their chips leave play.`)) {
                          cmd('eliminate', { player_id: s.playerId });
                        }
                      }}
                      title="Manual eliminate" className="text-rose-500 hover:text-rose-300"
                    >
                      ✕
                    </button>
                  </>
                )}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
