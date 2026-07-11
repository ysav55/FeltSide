import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import PlayingCard from '../components/PlayingCard.jsx';
import { buildReplay } from '../utils/replay.js';

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const STREETS = ['preflop', 'flop', 'turn', 'river'];

/**
 * /review/:handId — full hand replay (M6 §§2-4). Coach view: action-by-action
 * forward/back, jump-to-seq, street jumps; board/stacks/pot reconstructed at
 * every step; all hole cards visible (open-kimono); tags shown at their
 * action_seq and clickable to jump; coach annotations + retag.
 */
export default function ReviewPage({ player, handId, onLogout }) {
  const [hand, setHand] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [tagText, setTagText] = useState('');
  const isCoach = player.role === 'coach';

  const load = useCallback(async () => {
    try {
      const res = await api(`/hands/${handId}`);
      setHand(res.hand);
    } catch (err) {
      setError(err.status === 403 ? 'Review is coach-only.' : 'Hand not found.');
    }
  }, [handId]);
  useEffect(() => { load(); }, [load]);

  const replay = useMemo(() => (hand ? buildReplay(hand) : null), [hand]);
  const frame = replay ? replay.frameAt(cursor) : null;

  const seqToCursor = useMemo(() => {
    const m = new Map();
    if (replay) for (const f of replay.frames) if (f.lastAction) m.set(f.lastAction.seq, f.cursor);
    return m;
  }, [replay]);

  if (error) return <Shell player={player} onLogout={onLogout}><p className="text-rose-400">{error}</p></Shell>;
  if (!hand || !replay || !frame) return <Shell player={player} onLogout={onLogout}><p className="text-slate-400">Loading…</p></Shell>;

  const streetCursors = replay.streetCursors();
  const annotationsHere = hand.annotations.filter((a) => a.actionIndex === cursor);

  async function addNote() {
    if (!noteText.trim()) return;
    await api(`/hands/${handId}/annotations`, { method: 'POST', body: { action_index: cursor, body: noteText.trim() } });
    setNoteText('');
    load();
  }
  async function removeNote(id) { await api(`/hands/annotations/${id}`, { method: 'DELETE' }); load(); }
  async function addCoachTag() {
    if (!tagText.trim()) return;
    const seq = frame.lastAction ? frame.lastAction.seq : null;
    const res = await api(`/hands/${handId}/tags`, { method: 'POST', body: { tag: tagText.trim(), action_seq: seq } });
    setTagText(''); setHand(res.hand);
  }
  async function dismissTag(t) {
    const res = t.tagType === 'coach'
      ? await api(`/hands/${handId}/tags/${t.id}`, { method: 'DELETE' })
      : await api(`/hands/${handId}/tags/${t.id}/dismiss`, { method: 'POST', body: { dismissed: !t.dismissed } });
    setHand(res.hand);
  }
  async function saveScenario() {
    const name = window.prompt('Scenario name?');
    if (!name) return;
    await api(`/hands/${handId}/save-scenario`, { method: 'POST', body: { name } });
    window.alert('Saved to the scenario library.');
  }

  return (
    <Shell player={player} onLogout={onLogout}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm text-slate-400">
          Hand <span className="font-mono text-slate-300">{handId.slice(0, 8)}</span> · origin {hand.origin} · rev {hand.revision}
        </div>
        {isCoach && (
          <button onClick={saveScenario} className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1 text-sm">
            Save as scenario
          </button>
        )}
      </div>

      {/* Board + pot at this step */}
      <div className="rounded-2xl border border-emerald-900 bg-emerald-950/40 p-5 flex flex-col items-center gap-3 mb-4">
        <div className="flex gap-2 min-h-16 items-center">
          {frame.board.length === 0
            ? <span className="text-slate-600 text-sm">preflop</span>
            : frame.board.map((c) => <PlayingCard key={c} card={c} />)}
        </div>
        <div className="text-amber-300 font-mono">Pot: {fmt(frame.pot)}</div>
        <div className="text-xs text-slate-500 uppercase tracking-wide">{frame.street}</div>
      </div>

      {/* Seats reconstructed at this step — open-kimono */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        {frame.seats.map((s) => (
          <div key={s.playerId}
            className={`rounded-lg border px-3 py-2 bg-slate-900 ${frame.toAct === s.playerId ? 'border-emerald-400' : 'border-slate-700'} ${s.folded ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium truncate">{s.name}</span>
              <span className="text-[10px] text-slate-500">{s.position}</span>
            </div>
            <div className="flex gap-1 my-1">
              {(s.holeCards ?? []).map((c) => <PlayingCard key={c} card={c} small />)}
            </div>
            <div className="text-xs font-mono text-emerald-300">{fmt(s.stack)}</div>
            {s.betThisRound > 0 && <div className="text-[10px] text-amber-300 font-mono">bet {fmt(s.betThisRound)}</div>}
            {s.folded && <div className="text-[10px] text-slate-500">folded</div>}
            {s.isWinner && <div className="text-[10px] text-emerald-400">winner</div>}
          </div>
        ))}
      </div>

      {/* Transport controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={() => setCursor(0)} className={btn}>⏮</button>
        <button onClick={() => setCursor((c) => Math.max(0, c - 1))} className={btn}>◀ Back</button>
        <span className="text-sm text-slate-400 font-mono">{cursor}/{replay.frameCount - 1}</span>
        <button onClick={() => setCursor((c) => Math.min(replay.frameCount - 1, c + 1))} className={btn}>Fwd ▶</button>
        <button onClick={() => setCursor(replay.frameCount - 1)} className={btn}>⏭</button>
        <span className="mx-2 text-slate-700">|</span>
        {STREETS.map((s) => (
          <button key={s} disabled={streetCursors[s] === undefined}
            onClick={() => setCursor(streetCursors[s])}
            className={`${btn} ${streetCursors[s] === undefined ? 'opacity-40' : ''}`}>
            {s}
          </button>
        ))}
      </div>

      {/* Action log with tags at their seq */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Actions</h3>
          <ol className="text-sm space-y-0.5 max-h-72 overflow-y-auto">
            {hand.actions.filter((a) => !a.reverted).map((a) => {
              const c = seqToCursor.get(a.seq);
              const seat = frame.seats.find((s) => s.playerId === a.playerId);
              return (
                <li key={a.seq}>
                  <button onClick={() => setCursor(c)}
                    className={`w-full text-left px-2 py-0.5 rounded ${cursor === c ? 'bg-slate-800 text-emerald-300' : 'hover:bg-slate-800/50'}`}>
                    <span className="text-slate-500 font-mono mr-2">{a.seq}</span>
                    <span className="text-slate-400">{seat?.name ?? a.playerId.slice(0, 4)}</span>{' '}
                    <span>{a.action}{a.amount ? ` ${fmt(a.amount)}` : ''}</span>
                    <span className="text-slate-600 text-xs ml-1">({a.street})</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Tags</h3>
          <div className="flex flex-wrap gap-1 mb-3">
            {hand.tags.map((t) => (
              <button key={t.id}
                onClick={() => (t.actionSeq !== null && seqToCursor.has(t.actionSeq)) && setCursor(seqToCursor.get(t.actionSeq))}
                className={`rounded px-2 py-0.5 text-xs font-mono border ${t.dismissed ? 'opacity-40 line-through' : ''} ${
                  t.tagType === 'mistake' ? 'border-rose-700 text-rose-300'
                    : t.tagType === 'coach' ? 'border-sky-700 text-sky-300' : 'border-slate-700 text-slate-300'}`}
                title={t.actionSeq !== null ? `jump to action ${t.actionSeq}` : 'hand-level'}>
                {t.tag}
                {isCoach && (
                  <span onClick={(e) => { e.stopPropagation(); dismissTag(t); }} className="ml-1 text-slate-500 hover:text-rose-400">✕</span>
                )}
              </button>
            ))}
            {hand.tags.length === 0 && <span className="text-slate-600 text-sm">none</span>}
          </div>
          {isCoach && (
            <div className="flex gap-1 mb-4">
              <input value={tagText} onChange={(e) => setTagText(e.target.value)}
                placeholder={`coach tag @ action ${frame.lastAction ? frame.lastAction.seq : '—'}`}
                className="flex-1 rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs" />
              <button onClick={addCoachTag} className={btn}>Tag</button>
            </div>
          )}

          <h3 className="text-xs uppercase tracking-wide text-slate-400 mb-2">Annotations @ step {cursor}</h3>
          <ul className="space-y-1 mb-2">
            {annotationsHere.map((a) => (
              <li key={a.id} className="text-sm text-slate-300 flex items-start gap-2">
                <span className="flex-1">{a.body}</span>
                {isCoach && <button onClick={() => removeNote(a.id)} className="text-slate-500 hover:text-rose-400 text-xs">✕</button>}
              </li>
            ))}
            {annotationsHere.length === 0 && <li className="text-slate-600 text-sm">none at this step</li>}
          </ul>
          {isCoach && (
            <div className="flex gap-1">
              <input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="pin a note to this step"
                className="flex-1 rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs" />
              <button onClick={addNote} className={btn}>Pin</button>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

const btn = 'rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1 text-sm';

function Shell({ player, onLogout, children }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <a href="/" className="text-xl font-semibold text-emerald-400">FeltSide</a>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-400">{player.display_name}</span>
          <a href="/hands" className="text-slate-400 hover:text-slate-200">History</a>
          <button onClick={onLogout} className="text-slate-500 hover:text-slate-300">Sign out</button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto p-4">{children}</main>
    </div>
  );
}
