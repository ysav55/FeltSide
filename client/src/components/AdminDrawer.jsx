import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AdminDrawer({ onClose, onChanged }) {
  const [players, setPlayers] = useState([]);
  const [message, setMessage] = useState(null);

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [adjustPlayerId, setAdjustPlayerId] = useState('');
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustNote, setAdjustNote] = useState('');

  const loadPlayers = useCallback(async () => {
    try {
      const { data } = await api('/players');
      setPlayers(data);
    } catch {
      setMessage({ kind: 'error', text: 'Could not load players.' });
    }
  }, []);

  useEffect(() => { loadPlayers(); }, [loadPlayers]);

  async function createPlayer(e) {
    e.preventDefault();
    setMessage(null);
    try {
      await api('/players', {
        method: 'POST',
        body: {
          display_name: newName,
          email: newEmail,
          initial_password: newPassword,
        },
      });
      setNewName(''); setNewEmail(''); setNewPassword('');
      setMessage({ kind: 'ok', text: 'Player created. They must change the password at first login.' });
      await loadPlayers();
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err.message === 'email_taken' ? 'That email is already in use.'
          : err.message === 'weak_password' ? 'Initial password must be at least 8 characters.'
          : 'Could not create player.',
      });
    }
  }

  async function adjustBankroll(e) {
    e.preventDefault();
    setMessage(null);
    try {
      await api(`/bankroll/${adjustPlayerId}/adjust`, {
        method: 'POST',
        body: { delta: Number(adjustDelta), note: adjustNote || undefined },
      });
      setAdjustDelta(''); setAdjustNote('');
      setMessage({ kind: 'ok', text: 'Bankroll adjusted.' });
      onChanged?.();
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err.message === 'insufficient_balance'
          ? 'That would make the balance negative.'
          : 'Adjustment failed.',
      });
    }
  }

  async function archive(id) {
    setMessage(null);
    try {
      await api(`/players/${id}/archive`, { method: 'POST' });
      await loadPlayers();
    } catch {
      setMessage({ kind: 'error', text: 'Archive failed.' });
    }
  }

  return (
    <div className="fixed inset-0 z-10">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-md bg-slate-900 border-l border-slate-800 p-5 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Coach admin</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">Close</button>
        </div>

        {message && (
          <p className={`text-sm mb-3 ${message.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {message.text}
          </p>
        )}

        <section className="mb-6">
          <h3 className="text-sm uppercase tracking-wide text-slate-500 mb-2">Create player</h3>
          <form onSubmit={createPlayer} className="space-y-2">
            <input
              required placeholder="Display name" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
            />
            <input
              required type="email" placeholder="Email" value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
            />
            <input
              required type="text" placeholder="Initial password (min 8 chars)" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
            />
            <button className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 py-2 text-sm font-medium">
              Create player
            </button>
          </form>
        </section>

        <section className="mb-6">
          <h3 className="text-sm uppercase tracking-wide text-slate-500 mb-2">Bankroll adjust</h3>
          <form onSubmit={adjustBankroll} className="space-y-2">
            <select
              required value={adjustPlayerId}
              onChange={(e) => setAdjustPlayerId(e.target.value)}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
            >
              <option value="">Select player…</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>{p.display_name} ({p.email})</option>
              ))}
            </select>
            <input
              required type="number" step="1" placeholder="Delta (e.g. 5000 or -1000)"
              value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
            />
            <input
              placeholder="Note (optional)" value={adjustNote}
              onChange={(e) => setAdjustNote(e.target.value)}
              className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
            />
            <button className="w-full rounded-md bg-slate-700 hover:bg-slate-600 py-2 text-sm font-medium">
              Apply adjustment
            </button>
          </form>
        </section>

        <section>
          <h3 className="text-sm uppercase tracking-wide text-slate-500 mb-2">Players</h3>
          <ul className="space-y-1">
            {players.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-md border border-slate-800 px-3 py-2 text-sm"
              >
                <div>
                  <span className={p.status === 'archived' ? 'line-through text-slate-500' : ''}>
                    {p.display_name}
                  </span>
                  <span className="text-slate-500 ml-2">{p.role}</span>
                  {p.crm_student_id && (
                    <span className="text-slate-600 ml-2 font-mono text-xs">{p.crm_student_id}</span>
                  )}
                </div>
                {p.role !== 'coach' && p.status === 'active' && (
                  <button
                    onClick={() => archive(p.id)}
                    className="text-rose-400 hover:text-rose-300 text-xs"
                  >
                    Archive
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
