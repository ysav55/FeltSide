import { useEffect, useState } from 'react';
import { api } from '../api.js';

export function CreateTableDialog({ onClose, onSeated, coach = false }) {
  const [smallBlind, setSmallBlind] = useState('50');
  const [bigBlind, setBigBlind] = useState('100');
  const [size, setSize] = useState(6);
  const [name, setName] = useState('');
  const [buyIn, setBuyIn] = useState('');
  const [mode, setMode] = useState('uncoached_cash');
  const [presets, setPresets] = useState(null);
  const [presetId, setPresetId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Preset catalog (TOURNAMENTS §1) — loaded once the coach picks Tournament.
  useEffect(() => {
    if (mode !== 'tournament' || presets !== null) return;
    api('/tournament-presets')
      .then((res) => {
        setPresets(res.data);
        if (res.data[0]) setPresetId(res.data[0].id);
      })
      .catch(() => setError('Could not load tournament presets.'));
  }, [mode, presets]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (coach && mode === 'tournament') {
        const created = await api('/tournaments', {
          method: 'POST',
          body: { preset_id: presetId, name: name || undefined },
        });
        onSeated(created.table);
        return;
      }
      const created = await api('/tables', {
        method: 'POST',
        body: {
          small_blind: Number(smallBlind),
          big_blind: Number(bigBlind),
          table_size: size,
          name: name || undefined,
          ...(coach && mode === 'coached_cash' ? { mode } : {}),
        },
      });
      const tableId = created.table.tableId;
      if (coach && mode === 'coached_cash') {
        // Coach lands on the coached table as its operator (observing).
        onSeated(created.table);
        return;
      }
      const amount = buyIn ? Number(buyIn) : created.buy_in.defaultAmount;
      const joined = await api(`/tables/${tableId}/join`, {
        method: 'POST', body: { buy_in: amount },
      });
      onSeated(joined.table);
    } catch (err) {
      setError(
        err.message === 'insufficient_balance' ? 'Not enough bankroll for that buy-in.'
        : err.message === 'invalid_buy_in' ? 'Buy-in must be between 50 and 250 big blinds.'
        : err.message === 'invalid_blinds' ? 'Blinds are invalid.'
        : 'Could not create the table.'
      );
      setBusy(false);
    }
  }

  if (coach && mode === 'tournament') {
    const preset = presets?.find((p) => p.id === presetId);
    return (
      <Dialog title="Create tournament" onClose={onClose}>
        <form onSubmit={submit} className="space-y-3">
          <ModePicker coach mode={mode} setMode={setMode} />
          <label className="block text-sm">
            <span className="text-slate-400">Preset</span>
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2"
            >
              {(presets ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {preset?.description && (
              <span className="block mt-1 text-xs text-slate-500">{preset.description}</span>
            )}
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">Name (optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2" />
          </label>
          {error && <p className="text-rose-400 text-sm">{error}</p>}
          <button disabled={busy || !presetId}
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 py-2 font-medium">
            Open registration
          </button>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title="Create table" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {coach && <ModePicker coach mode={mode} setMode={setMode} />}
        <div className="flex gap-2">
          <label className="flex-1 text-sm">
            <span className="text-slate-400">Small blind</span>
            <input type="number" required min="1" value={smallBlind}
              onChange={(e) => { setSmallBlind(e.target.value); setBigBlind(String(Number(e.target.value) * 2)); }}
              className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2" />
          </label>
          <label className="flex-1 text-sm">
            <span className="text-slate-400">Big blind</span>
            <input type="number" required min="2" value={bigBlind}
              onChange={(e) => setBigBlind(e.target.value)}
              className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2" />
          </label>
        </div>
        <div className="flex gap-2 items-end">
          <label className="flex-1 text-sm">
            <span className="text-slate-400">Table size</span>
            <div className="mt-1 flex rounded-md overflow-hidden border border-slate-700">
              {[6, 9].map((n) => (
                <button type="button" key={n} onClick={() => setSize(n)}
                  className={`flex-1 py-2 text-sm ${size === n ? 'bg-emerald-700' : 'bg-slate-800'}`}>
                  {n}-max
                </button>
              ))}
            </div>
          </label>
          <label className="flex-1 text-sm">
            <span className="text-slate-400">Name (optional)</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2" />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-slate-400">Your buy-in (default 100 BB, allowed 50–250 BB)</span>
          <input type="number" placeholder={`${Number(bigBlind) * 100}`} value={buyIn}
            onChange={(e) => setBuyIn(e.target.value)}
            className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2" />
        </label>
        {error && <p className="text-rose-400 text-sm">{error}</p>}
        <button disabled={busy}
          className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 py-2 font-medium">
          Create & sit down
        </button>
      </form>
    </Dialog>
  );
}

export function JoinTableDialog({ table, onClose, onSeated }) {
  const bb = table.config?.bigBlind ?? table.config?.big_blind ?? 100;
  const [buyIn, setBuyIn] = useState(String(bb * 100));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const joined = await api(`/tables/${table.id}/join`, {
        method: 'POST', body: { buy_in: Number(buyIn) },
      });
      onSeated(joined.table);
    } catch (err) {
      setError(
        err.message === 'insufficient_balance' ? 'Not enough bankroll for that buy-in.'
        : err.message === 'invalid_buy_in' ? `Buy-in must be ${bb * 50}–${bb * 250}.`
        : err.message === 'seat_taken' || err.message === 'already_seated' ? 'Could not take a seat.'
        : 'Could not join the table.'
      );
      setBusy(false);
    }
  }

  return (
    <Dialog title={`Join ${table.config?.name || 'table'} (${bb / 2}/${bb})`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="text-slate-400">Buy-in ({bb * 50}–{bb * 250})</span>
          <input type="number" required value={buyIn}
            onChange={(e) => setBuyIn(e.target.value)}
            className="mt-1 w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2" />
        </label>
        {error && <p className="text-rose-400 text-sm">{error}</p>}
        <button disabled={busy}
          className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 py-2 font-medium">
          Sit down
        </button>
      </form>
    </Dialog>
  );
}

function ModePicker({ mode, setMode }) {
  const modes = [
    ['uncoached_cash', 'Cash game'],
    ['coached_cash', 'Coached table'],
    ['tournament', 'Tournament'],
  ];
  return (
    <div className="flex rounded-md overflow-hidden border border-slate-700 text-sm">
      {modes.map(([m, label]) => (
        <button type="button" key={m} onClick={() => setMode(m)}
          className={`flex-1 py-2 ${mode === m ? 'bg-emerald-700' : 'bg-slate-800'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Dialog({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-xl p-5 m-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
