import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const ORIGINS = ['', 'rng', 'manual', 'hybrid', 'scenario', 'replay_branch'];

/**
 * Hand-history browser (M6 §7) — coach-only. Filter by origin / tag; open a
 * hand in the review page. This is where descriptors earn their keep and
 * playlist building starts (save-as-scenario lives on the review page).
 */
export default function HandHistory({ player, onLogout }) {
  const [hands, setHands] = useState([]);
  const [origin, setOrigin] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (origin) q.set('origin', origin);
      if (tag.trim()) q.set('tag', tag.trim());
      const res = await api(`/hands${q.toString() ? `?${q}` : ''}`);
      setHands(res.data);
      setError(null);
    } catch (err) {
      setError(err.status === 403 ? 'Coach-only.' : 'Could not load hands.');
    }
  }, [origin, tag]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <a href="/" className="text-xl font-semibold text-emerald-400">FeltSide</a>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-400">{player.display_name}</span>
          <button onClick={onLogout} className="text-slate-500 hover:text-slate-300">Sign out</button>
        </div>
      </header>
      <main className="max-w-4xl mx-auto p-4">
        <h2 className="text-lg font-medium mb-3">Hand history</h2>
        <div className="flex flex-wrap gap-2 mb-4 items-center text-sm">
          <label className="flex items-center gap-1 text-slate-400">
            origin
            <select value={origin} onChange={(e) => setOrigin(e.target.value)} className="rounded bg-slate-800 border border-slate-700 px-2 py-1">
              {ORIGINS.map((o) => <option key={o} value={o}>{o || 'any'}</option>)}
            </select>
          </label>
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag (e.g. OPEN_TOO_LOOSE)"
            className="rounded bg-slate-800 border border-slate-700 px-2 py-1 w-56" />
        </div>
        {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
        {hands.length === 0 ? (
          <div className="border border-dashed border-slate-800 rounded-xl p-10 text-center text-slate-500">No hands.</div>
        ) : (
          <ul className="space-y-1.5">
            {hands.map((h) => (
              <li key={h.handId}>
                <a href={`/review/${h.handId}`}
                  className="block border border-slate-800 rounded-lg px-4 py-2 hover:border-emerald-700 flex items-center justify-between">
                  <div className="min-w-0">
                    <span className="font-mono text-slate-300">{h.handId.slice(0, 8)}</span>
                    <span className="text-slate-500 text-sm ml-3">{h.origin}</span>
                    <span className="text-slate-600 text-xs ml-2">{new Date(h.playedAt).toLocaleString()}</span>
                    {h.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {h.tags.slice(0, 6).map((t) => (
                          <span key={t} className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded px-1">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-sm shrink-0">
                    <div className="text-amber-300 font-mono">{fmt(h.pot)}</div>
                    <div className="text-slate-500 text-xs">{h.playerCount}p{h.winnerName ? ` · ${h.winnerName}` : ''}</div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
