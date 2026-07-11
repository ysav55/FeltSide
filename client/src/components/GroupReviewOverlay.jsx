import { useMemo } from 'react';
import PlayingCard from './PlayingCard.jsx';
import { buildReplay } from '../utils/replay.js';

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

/**
 * Read-only group-review overlay (M6 §6). When the coach sends the table to
 * review, every connected player sees this synced view (spectator technical
 * state); the coach drives navigation — players just follow. Open-kimono.
 */
export default function GroupReviewOverlay({ review }) {
  const replay = useMemo(() => buildReplay(review.hand), [review.hand]);
  const frame = replay.frameAt(review.cursor);

  return (
    <div className="fixed inset-0 z-40 bg-slate-950/95 flex flex-col items-center overflow-y-auto p-4">
      <div className="max-w-3xl w-full">
        <div className="text-center text-sm text-amber-300 mb-4">
          The coach is reviewing a hand · step {review.cursor}/{replay.frameCount - 1}
        </div>
        <div className="rounded-2xl border border-emerald-900 bg-emerald-950/40 p-5 flex flex-col items-center gap-3 mb-4">
          <div className="flex gap-2 min-h-16 items-center">
            {frame.board.length === 0
              ? <span className="text-slate-600 text-sm">preflop</span>
              : frame.board.map((c) => <PlayingCard key={c} card={c} />)}
          </div>
          <div className="text-amber-300 font-mono">Pot: {fmt(frame.pot)}</div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">{frame.street}</div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
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
              {s.folded && <div className="text-[10px] text-slate-500">folded</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
