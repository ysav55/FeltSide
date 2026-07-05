import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { getSocket } from '../socket.js';
import PlayingCard from '../components/PlayingCard.jsx';

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

function ActionTimer({ deadline }) {
  const [left, setLeft] = useState(null);
  useEffect(() => {
    if (!deadline) { setLeft(null); return undefined; }
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);
  if (left === null) return null;
  return (
    <span className={`font-mono text-sm ${left <= 5 ? 'text-rose-400' : 'text-slate-400'}`}>
      {left}s
    </span>
  );
}

function Seat({ seat, isButton, isToAct, isMe }) {
  if (!seat) {
    return (
      <div className="rounded-lg border border-dashed border-slate-800 px-3 py-2 text-slate-600 text-xs text-center">
        empty
      </div>
    );
  }
  const dim = seat.folded || seat.sittingOut || !seat.inHand;
  return (
    <div className={`rounded-lg border px-3 py-2 ${isToAct ? 'border-emerald-400' : 'border-slate-700'} ${dim ? 'opacity-50' : ''} bg-slate-900`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium truncate">{seat.name}{isMe ? ' (you)' : ''}</span>
        {isButton && (
          <span className="text-[10px] rounded-full bg-amber-400 text-black font-bold w-4 h-4 flex items-center justify-center">D</span>
        )}
      </div>
      <div className="text-xs font-mono text-emerald-300">{fmt(seat.stack)}</div>
      <div className="flex gap-1 mt-1 items-center">
        {seat.inHand && !seat.folded && (
          seat.holeCards
            ? seat.holeCards.map((c) => <PlayingCard key={c} card={c} small />)
            : <><PlayingCard hidden small /><PlayingCard hidden small /></>
        )}
        {seat.betThisRound > 0 && (
          <span className="text-xs text-amber-300 font-mono ml-1">{fmt(seat.betThisRound)}</span>
        )}
      </div>
      {seat.sittingOut && <div className="text-[10px] text-slate-500 mt-0.5">sitting out</div>}
      {seat.folded && <div className="text-[10px] text-slate-500 mt-0.5">folded</div>}
    </div>
  );
}

export default function TablePage({ player, table: initialTable, onLeft }) {
  const [table, setTable] = useState(initialTable);
  const [raiseTo, setRaiseTo] = useState('');
  const [error, setError] = useState(null);
  const [rebuyAmount, setRebuyAmount] = useState('');
  const socketRef = useRef(null);

  const tableId = initialTable.tableId;

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;
    const onState = (state) => { if (state.tableId === tableId) setTable(state); };
    socket.on('table:state', onState);
    const enter = () => socket.emit('table:enter', { tableId }, (res) => {
      if (res?.table) setTable(res.table);
    });
    if (socket.connected) enter();
    socket.on('connect', enter);
    return () => {
      socket.off('table:state', onState);
      socket.off('connect', enter);
    };
  }, [tableId]);

  const mySeat = table.seats?.find((s) => s && s.playerId === player.id) || null;
  const myTurn = mySeat && table.toAct === mySeat.seatIndex;

  const legal = useMemo(() => {
    if (!myTurn || !mySeat) return null;
    const toCall = Math.min(table.currentBet - mySeat.betThisRound, mySeat.stack);
    return {
      check: toCall === 0,
      call: toCall > 0 ? toCall : null,
      canBet: table.currentBet === 0 && mySeat.stack > 0,
      canRaise: table.currentBet > 0 && mySeat.stack > toCall,
      maxTo: mySeat.betThisRound + mySeat.stack,
    };
  }, [myTurn, mySeat, table]);

  const send = useCallback((action, amount) => {
    setError(null);
    socketRef.current?.emit('table:action', { tableId, action, amount }, (res) => {
      if (res?.error) setError(res.error.replaceAll('_', ' '));
    });
  }, [tableId]);

  async function toggleSitOut() {
    socketRef.current?.emit('table:sitout', { tableId, sit_out: !mySeat.sittingOut }, () => {});
  }

  async function leave() {
    try {
      await api(`/tables/${tableId}/leave`, { method: 'POST' });
      onLeft();
    } catch {
      setError('Could not leave the table.');
    }
  }

  async function rebuy() {
    setError(null);
    try {
      await api(`/tables/${tableId}/rebuy`, {
        method: 'POST', body: { buy_in: Number(rebuyAmount) },
      });
      setRebuyAmount('');
    } catch (err) {
      setError(err.message === 'insufficient_balance'
        ? 'Not enough bankroll for that re-buy.' : 'Re-buy failed.');
    }
  }

  const busted = mySeat && mySeat.stack === 0 && !mySeat.inHand;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 px-4 py-2 flex items-center justify-between">
        <div>
          <span className="text-emerald-400 font-semibold">FeltSide</span>
          <span className="text-slate-400 text-sm ml-3">
            {table.name || 'Cash game'} · {table.config.smallBlind}/{table.config.bigBlind}
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <ActionTimer deadline={myTurn ? table.actionDeadline : null} />
          {mySeat && (
            <button onClick={toggleSitOut} className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1">
              {mySeat.sittingOut ? 'Sit in' : 'Sit out'}
            </button>
          )}
          <button onClick={leave} className="rounded-md bg-rose-900/60 hover:bg-rose-900 px-3 py-1">
            Leave table
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto p-4 flex flex-col gap-4">
        {/* Board + pot */}
        <div className="rounded-2xl border border-emerald-900 bg-emerald-950/40 p-6 flex flex-col items-center gap-3">
          <div className="flex gap-2 min-h-16 items-center">
            {table.board.length === 0
              ? <span className="text-slate-600 text-sm">
                  {table.phase === 'waiting' ? 'Waiting for players…' : 'Preflop'}
                </span>
              : table.board.map((c) => <PlayingCard key={c} card={c} />)}
          </div>
          <div className="text-amber-300 font-mono">Pot: {fmt(table.pot)}</div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">{table.phase.replaceAll('_', ' ')}</div>
        </div>

        {/* Seats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {table.seats.map((seat, idx) => (
            <Seat
              key={idx}
              seat={seat}
              isButton={table.button === idx}
              isToAct={table.toAct === idx}
              isMe={seat?.playerId === player.id}
            />
          ))}
        </div>

        {error && <p className="text-rose-400 text-sm">{error}</p>}

        {/* Betting controls */}
        {myTurn && legal && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 flex flex-wrap items-center gap-3">
            <button onClick={() => send('fold')} className="rounded-md bg-rose-800 hover:bg-rose-700 px-4 py-2 font-medium">
              Fold
            </button>
            {legal.check && (
              <button onClick={() => send('check')} className="rounded-md bg-slate-700 hover:bg-slate-600 px-4 py-2 font-medium">
                Check
              </button>
            )}
            {legal.call && (
              <button onClick={() => send('call')} className="rounded-md bg-emerald-700 hover:bg-emerald-600 px-4 py-2 font-medium">
                Call {fmt(legal.call)}
              </button>
            )}
            {(legal.canBet || legal.canRaise) && (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  placeholder={legal.canBet ? 'Bet' : 'Raise to'}
                  value={raiseTo}
                  onChange={(e) => setRaiseTo(e.target.value)}
                  className="w-28 rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
                />
                <button
                  onClick={() => send(legal.canBet ? 'bet' : 'raise', Number(raiseTo))}
                  className="rounded-md bg-amber-600 hover:bg-amber-500 px-4 py-2 font-medium"
                >
                  {legal.canBet ? 'Bet' : 'Raise'}
                </button>
                <button
                  onClick={() => send(legal.canBet ? 'bet' : 'raise', legal.maxTo)}
                  className="rounded-md bg-amber-800 hover:bg-amber-700 px-3 py-2 text-sm"
                >
                  All-in {fmt(legal.maxTo)}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Bust → re-entry */}
        {busted && (
          <div className="rounded-xl border border-amber-700 bg-amber-950/30 p-4 flex items-center gap-3">
            <span className="text-amber-200 text-sm">You busted. Re-enter with a new buy-in?</span>
            <input
              type="number"
              placeholder="Buy-in"
              value={rebuyAmount}
              onChange={(e) => setRebuyAmount(e.target.value)}
              className="w-28 rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
            />
            <button onClick={rebuy} className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium">
              Re-buy
            </button>
            <button onClick={leave} className="text-slate-400 text-sm hover:text-slate-200">
              Leave instead
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
