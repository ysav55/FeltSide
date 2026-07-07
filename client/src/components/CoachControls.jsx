import { useState } from 'react';

/**
 * Coach control bar (M4 §7–8): pause/resume, undo, street rollback, force
 * street, award pot, stack adjust, blind change, live tagging, seat-list
 * override, end session. Everything goes through the coach socket channel.
 */
export default function CoachControls({ table, coach, send, onEnded }) {
  const [error, setError] = useState(null);
  const [tagText, setTagText] = useState(''); const [tagPlayer, setTagPlayer] = useState('');
  const [awardTo, setAwardTo] = useState('');
  const [stackPlayer, setStackPlayer] = useState(''); const [stackValue, setStackValue] = useState('');
  const [sb, setSb] = useState(''); const [bb, setBb] = useState('');

  const seats = (table.seats ?? []).filter(Boolean);
  const cmd = (command, payload = {}) => {
    setError(null);
    send(command, payload, (res) => {
      if (res?.error) setError(`${command}: ${res.error.replaceAll('_', ' ')}`);
    });
  };

  const btn = 'rounded-md bg-slate-800 hover:bg-slate-700 px-2.5 py-1 text-xs';
  const input = 'rounded bg-slate-800 border border-slate-700 px-1.5 py-1 text-xs';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 flex flex-col gap-2 text-sm">
      <h3 className="text-xs uppercase tracking-wide text-slate-400">Coach controls</h3>
      {error && <p className="text-rose-400 text-xs">{error}</p>}

      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={btn} onClick={() => cmd('pause', { paused: !coach.paused })}>
          {coach.paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className={btn} onClick={() => cmd('undo')}>Undo action</button>
        <button type="button" className={btn} onClick={() => cmd('rollback')}>Rollback street</button>
        <button type="button" className={btn} onClick={() => cmd('force-street')}>Force street</button>
        <button
          type="button"
          className={btn}
          onClick={() => cmd('open-seating', { open: !coach.openSeating })}
          title="Soft seat list override (PRD §7)"
        >
          {coach.openSeating ? 'Restrict seats' : 'Open seating'}
        </button>
        <button
          type="button"
          className="rounded-md bg-rose-900/70 hover:bg-rose-900 px-2.5 py-1 text-xs"
          onClick={async () => {
            const { api } = await import('../api.js');
            try { await api(`/tables/${table.tableId}/close`, { method: 'POST' }); onEnded?.(); }
            catch { setError('close failed'); }
          }}
        >
          End session
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select value={awardTo} onChange={(e) => setAwardTo(e.target.value)} className={input} aria-label="award pot to">
          <option value="">award pot to…</option>
          {seats.map((s) => <option key={s.playerId} value={s.playerId}>{s.name}</option>)}
        </select>
        <button
          type="button" className={btn}
          onClick={() => awardTo && cmd('award-pot', { player_id: awardTo })}
        >
          Award
        </button>

        <select value={stackPlayer} onChange={(e) => setStackPlayer(e.target.value)} className={input} aria-label="stack player">
          <option value="">stack…</option>
          {seats.map((s) => <option key={s.playerId} value={s.playerId}>{s.name}</option>)}
        </select>
        <input value={stackValue} onChange={(e) => setStackValue(e.target.value)} placeholder="chips" className={`${input} w-20`} />
        <button
          type="button" className={btn}
          onClick={() => stackPlayer && cmd('stack', { player_id: stackPlayer, stack: Number(stackValue) })}
        >
          Set
        </button>

        <input value={sb} onChange={(e) => setSb(e.target.value)} placeholder="SB" className={`${input} w-14`} />
        <input value={bb} onChange={(e) => setBb(e.target.value)} placeholder="BB" className={`${input} w-14`} />
        <button
          type="button" className={btn}
          onClick={() => cmd('blinds', { small_blind: Number(sb), big_blind: Number(bb) })}
        >
          Blinds
        </button>
      </div>

      {/* Live tagging — never stops play (M4 §8). */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          value={tagText} onChange={(e) => setTagText(e.target.value)}
          placeholder="live tag (e.g. missed value on river)"
          className={`${input} flex-1 min-w-40`}
        />
        <select value={tagPlayer} onChange={(e) => setTagPlayer(e.target.value)} className={input} aria-label="tag player">
          <option value="">whole hand</option>
          {seats.map((s) => <option key={s.playerId} value={s.playerId}>{s.name}</option>)}
        </select>
        <button
          type="button" className={btn}
          onClick={() => {
            if (!tagText.trim()) return;
            cmd('tag', { tag: tagText.trim(), player_id: tagPlayer || null });
            setTagText('');
          }}
        >
          Tag
        </button>
      </div>
    </div>
  );
}
