import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import AdminDrawer from '../components/AdminDrawer.jsx';
import { CreateTableDialog, JoinTableDialog } from '../components/TableDialogs.jsx';

const MODE_LABEL = {
  coached_cash: 'Coached cash',
  uncoached_cash: 'Cash game',
  tournament: 'Tournament',
};

export default function Lobby({ player, onLogout, onSeated }) {
  const [tables, setTables] = useState([]);
  const [balance, setBalance] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [tablesRes, bankrollRes] = await Promise.all([
        api('/tables'),
        api('/bankroll/me'),
      ]);
      setTables(tablesRes.data);
      setBalance(bankrollRes.balance);
      setError(null);
    } catch {
      setError('Could not load the lobby.');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-emerald-400">FeltSide</h1>
        <div className="flex items-center gap-4 text-sm">
          {balance !== null && (
            <span className="text-slate-300">
              Bankroll: <span className="font-mono text-emerald-300">{balance.toLocaleString('en-US')}</span>
            </span>
          )}
          <span className="text-slate-400">{player.display_name}</span>
          {player.role === 'coach' && (
            <button
              onClick={() => setDrawerOpen(true)}
              className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1.5"
            >
              Admin
            </button>
          )}
          <button onClick={onLogout} className="text-slate-500 hover:text-slate-300">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium">Tables</h2>
          <button
            onClick={() => setCreating(true)}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium"
          >
            Create table
          </button>
        </div>
        {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
        {tables.length === 0 ? (
          <div className="border border-dashed border-slate-800 rounded-xl p-10 text-center text-slate-500">
            No tables yet. Create one to start playing.
          </div>
        ) : (
          <ul className="space-y-2">
            {tables.map((t) => (
              <li
                key={t.id}
                className="border border-slate-800 rounded-lg px-4 py-3 flex items-center justify-between"
              >
                <div>
                  <span>{t.config?.name || MODE_LABEL[t.mode] || t.mode}</span>
                  <span className="text-slate-500 text-sm ml-2">
                    {t.config ? `${t.config.smallBlind}/${t.config.bigBlind} · ${t.config.tableSize}-max` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-slate-400 text-sm">
                    {t.seated ?? 0}/{t.config?.tableSize ?? '–'} seated · {t.status}
                  </span>
                  {t.mode === 'uncoached_cash' && (
                    <button
                      onClick={() => setJoining(t)}
                      className="rounded-md bg-slate-800 hover:bg-slate-700 px-3 py-1 text-sm"
                    >
                      Join
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      {creating && (
        <CreateTableDialog onClose={() => setCreating(false)} onSeated={onSeated} />
      )}
      {joining && (
        <JoinTableDialog table={joining} onClose={() => setJoining(null)} onSeated={onSeated} />
      )}
      {player.role === 'coach' && drawerOpen && (
        <AdminDrawer onClose={() => setDrawerOpen(false)} onChanged={refresh} />
      )}
    </div>
  );
}
