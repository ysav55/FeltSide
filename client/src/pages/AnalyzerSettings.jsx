import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import RangeMatrix from '../components/RangeMatrix.jsx';

/**
 * Analyzer Settings (TAXONOMY §6): reference charts (the shared range
 * matrix), per-tag kill switches, thresholds. Strictly non-retroactive —
 * saves apply from the next dealt hand.
 */
export default function AnalyzerSettings({ player, onLogout }) {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [openChart, setOpenChart] = useState(null); // { group, blind?, pos }
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api('/analyzer-settings').then((res) => {
      setData(res);
      setSettings(res.settings);
    }).catch(() => setStatus('Could not load settings.'));
  }, []);

  const currentChart = useMemo(() => {
    if (!openChart || !settings) return null;
    return openChart.group === 'open'
      ? settings.charts.open[openChart.pos]
      : settings.charts.defend[openChart.blind][openChart.pos];
  }, [openChart, settings]);

  if (!settings) {
    return <div className="min-h-screen bg-slate-950 text-slate-400 p-8">{status ?? 'Loading…'}</div>;
  }

  const setChart = (range) => {
    setSettings((s) => {
      const next = structuredClone(s);
      if (openChart.group === 'open') next.charts.open[openChart.pos] = range;
      else next.charts.defend[openChart.blind][openChart.pos] = range;
      return next;
    });
  };

  const resetChart = () => {
    const d = data.defaults;
    setChart(openChart.group === 'open'
      ? d.charts.open[openChart.pos]
      : d.charts.defend[openChart.blind][openChart.pos]);
  };

  async function save() {
    setStatus(null);
    try {
      const res = await api('/analyzer-settings', { method: 'PUT', body: settings });
      setSettings(res.settings);
      setStatus('Saved — applies from the next hand (non-retroactive).');
    } catch (err) {
      setStatus(`Save failed: ${err.message}`);
    }
  }

  const chartButton = (group, pos, blind = null) => {
    const key = blind ? `${group}.${blind}.${pos}` : `${group}.${pos}`;
    const active = openChart && (openChart.group === group && openChart.pos === pos && openChart.blind === blind);
    return (
      <button
        key={key}
        type="button"
        onClick={() => setOpenChart(active ? null : { group, pos, blind })}
        className={`rounded px-2 py-1 text-xs font-mono border
          ${active ? 'border-emerald-500 bg-emerald-950' : 'border-slate-700 bg-slate-800 hover:bg-slate-700'}`}
      >
        {pos}
      </button>
    );
  };

  const t = settings.thresholds;
  const num = (key) => (
    <input
      type="number"
      value={t[key]}
      onChange={(e) => setSettings((s) => ({
        ...s, thresholds: { ...s.thresholds, [key]: Number(e.target.value) },
      }))}
      className="w-20 rounded bg-slate-800 border border-slate-700 px-2 py-1 text-sm"
    />
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div>
          <a href="/" className="text-xl font-semibold text-emerald-400">FeltSide</a>
          <span className="text-slate-400 text-sm ml-3">Analyzer settings</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-400">{player.display_name}</span>
          <button onClick={onLogout} className="text-slate-500 hover:text-slate-300">Sign out</button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4 flex flex-col gap-6">
        {status && <p className="text-sm text-amber-300">{status}</p>}

        <section>
          <h2 className="text-lg font-medium mb-2">Reference charts</h2>
          <p className="text-slate-500 text-sm mb-3">
            Open-raise per position; blind defense keyed by the opener. Click a chart to edit
            it in the matrix; "reset" restores the seeded standard.
          </p>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="w-24 text-slate-400 text-sm">Open</span>
              {Object.keys(settings.charts.open).map((pos) => chartButton('open', pos))}
            </div>
            {['BB', 'SB'].map((blind) => (
              <div key={blind} className="flex items-center gap-2 flex-wrap">
                <span className="w-24 text-slate-400 text-sm">{blind} defend vs</span>
                {Object.keys(settings.charts.defend[blind]).map((pos) => chartButton('defend', pos, blind))}
              </div>
            ))}
          </div>
          {openChart && (
            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-300 font-mono">
                  {openChart.group === 'open' ? `open · ${openChart.pos}` : `defend · ${openChart.blind} vs ${openChart.pos}`}
                </span>
                <button type="button" onClick={resetChart} className="text-xs text-slate-400 hover:text-slate-200 underline">
                  reset to default
                </button>
              </div>
              <div className="overflow-x-auto">
                <RangeMatrix value={currentChart ?? ''} onChange={setChart} />
              </div>
              <textarea
                value={currentChart ?? ''}
                onChange={(e) => setChart(e.target.value)}
                rows={2}
                className="w-full rounded bg-slate-900 border border-slate-800 p-2 text-xs font-mono"
              />
            </div>
          )}
        </section>

        <section>
          <h2 className="text-lg font-medium mb-2">Thresholds</h2>
          <div className="grid sm:grid-cols-2 gap-3 text-sm">
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">All-in favorite equity &gt; %</span>{num('allinFavoritePct')}
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">All-in underdog equity &lt; %</span>{num('allinUnderdogPct')}
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Board connected rank span ≤</span>{num('boardConnectedSpan')}
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Multiway players ≥</span>{num('multiwayMinPlayers')}
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Missed-river-value floor</span>
              <select
                value={t.missedRiverValueFloor}
                onChange={(e) => setSettings((s) => ({
                  ...s, thresholds: { ...s.thresholds, missedRiverValueFloor: e.target.value },
                }))}
                className="rounded bg-slate-800 border border-slate-700 px-2 py-1"
              >
                {['ONE_PAIR', 'TWO_PAIR', 'THREE_OF_A_KIND', 'STRAIGHT', 'FLUSH'].map((v) => (
                  <option key={v} value={v}>{v.toLowerCase().replaceAll('_', ' ')}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-slate-400">…in position only</span>
              <input
                type="checkbox"
                checked={t.missedRiverValueInPositionOnly}
                onChange={(e) => setSettings((s) => ({
                  ...s, thresholds: { ...s.thresholds, missedRiverValueInPositionOnly: e.target.checked },
                }))}
              />
            </label>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-medium mb-2">Tag kill switches</h2>
          <div className="grid sm:grid-cols-3 gap-1 text-sm">
            {(data.tags ?? []).map(({ tag, tag_type: type }) => (
              <label key={tag} className="flex items-center gap-2 text-slate-300">
                <input
                  type="checkbox"
                  checked={settings.killSwitches[tag] !== false}
                  onChange={(e) => setSettings((s) => ({
                    ...s,
                    killSwitches: { ...s.killSwitches, [tag]: e.target.checked ? true : false },
                  }))}
                />
                <span className="font-mono text-xs">{tag}</span>
                <span className="text-[10px] text-slate-600">{type}</span>
              </label>
            ))}
          </div>
        </section>

        <div>
          <button onClick={save} className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 font-medium">
            Save settings
          </button>
        </div>
      </main>
    </div>
  );
}
