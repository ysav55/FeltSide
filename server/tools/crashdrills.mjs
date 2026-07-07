/**
 * M8.3 — crash drills.
 *
 * Forced `kill -9` of a REAL server against real Postgres, at five moments,
 * each followed by a restart (which runs RUNTIME §1 boot recovery). After
 * every drill we assert the three trust properties:
 *   (R) recovery: the server boots and rebuilds non-completed tables;
 *   (L) ledger reconciles: balance == Σ(transactions), no negatives;
 *   (X) export holds: a full cursor walk returns every recorded hand exactly
 *       once — no skip, no duplicate (at-least-once, monotone export_seq).
 *
 * The kill instant varies slightly by scenario (timing a SIGKILL from outside
 * is inherently racy), but the invariants above hold regardless of exactly
 * where the axe falls — which is the whole point of RUNTIME §1. Each drill
 * drives to (or into) its named state, then kills.
 *
 * Usage:
 *   CRASH_DB=postgres://…/feltside_crash node tools/crashdrills.mjs
 */
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import pg from 'pg';

const DB_URL = process.env.CRASH_DB || 'postgres://felts@127.0.0.1:55432/feltside_crash';
const PORT = Number(process.env.CRASH_PORT || 3997);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_ENV = {
  ...process.env,
  SUPABASE_DB_URL: DB_URL,
  EXPORT_API_KEY: 'crash-key',
  JWT_SECRET: 'crash-secret',
  COACH_EMAIL: 'coach@crash.local',
  COACH_INITIAL_PASSWORD: 'crash-coach-pw',
  PORT: String(PORT),
  AUTH_RL_PER_IP: '0',
  AUTH_RL_PER_EMAIL: '0',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let coachToken;

// ── server lifecycle ─────────────────────────────────────────────────────
let child = null;
function bootServer() {
  child = spawn('node', ['src/index.js'], { env: SERVER_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let recovered = 0;
  child.stdout.on('data', (b) => {
    for (const line of b.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.event === 'server_started') recovered = o.tablesRecovered ?? 0;
      } catch { /* non-JSON */ }
    }
  });
  child._recovered = () => recovered;
  return child;
}
async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error('server never became healthy');
}
function killHard() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}
async function restart() {
  bootServer();
  await waitHealthy();
  return child._recovered();
}

// ── api helper ───────────────────────────────────────────────────────────
async function api(path, { method = 'GET', token = coachToken, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `http_${res.status}`);
  return json;
}
async function loginCoach() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: SERVER_ENV.COACH_EMAIL, password: SERVER_ENV.COACH_INITIAL_PASSWORD }),
  }).then((x) => x.json());
  coachToken = r.token;
}
async function makePlayer(db, name, fund = 1_000_000) {
  const res = await api('/players', {
    method: 'POST', body: { display_name: name, email: `${name}@crash.local`, initial_password: 'pw-initial-1' },
  });
  const id = res.player.id;
  await api(`/bankroll/${id}/adjust`, { method: 'POST', body: { delta: fund, note: 'crash fund' } });
  // login + forced change → live token
  const first = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@crash.local`, password: 'pw-initial-1' }),
  }).then((x) => x.json());
  await fetch(`${BASE}/api/auth/change-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.token}` },
    body: JSON.stringify({ current_password: 'pw-initial-1', new_password: `pw-live-${name}` }),
  });
  const relog = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@crash.local`, password: `pw-live-${name}` }),
  }).then((x) => x.json());
  return { id, name, token: relog.token };
}

// ── invariant checks ─────────────────────────────────────────────────────
async function checkLedger(db) {
  const { rows: bad } = await db.query(`
    select a.player_id from bankroll_accounts a
      left join bankroll_transactions t on t.player_id = a.player_id
     group by a.player_id, a.balance
    having a.balance <> coalesce(sum(t.amount), 0)`);
  const { rows: neg } = await db.query('select 1 from bankroll_accounts where balance < 0');
  return { ok: bad.length === 0 && neg.length === 0, mismatched: bad.length, negative: neg.length };
}
async function exportWalk() {
  const seen = new Map();
  let cursor = null, dup = 0;
  for (;;) {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : '?limit=50';
    const res = await fetch(`${BASE}/export/v1/hands${q}`, {
      headers: { authorization: `Bearer ${SERVER_ENV.EXPORT_API_KEY}` },
    }).then((r) => r.json());
    for (const h of res.data) {
      const k = `${h.hand_id}:${h.revision}`;
      if (seen.has(k)) dup += 1;
      seen.set(k, true);
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return { count: seen.size, duplicates: dup };
}
async function recordedHandCount(db) {
  const { rows } = await db.query('select count(*)::int n from hands where export_seq is not null');
  return rows[0].n;
}

async function verify(db, name, { recovered, expectRecover }) {
  const ledger = await checkLedger(db);
  const walk = await exportWalk();
  const recorded = await recordedHandCount(db);
  const pass =
    ledger.ok &&
    walk.duplicates === 0 &&
    walk.count === recorded &&
    (!expectRecover || recovered >= expectRecover);
  results.push({ drill: name, pass, recovered, ledger, exportWalk: walk, recorded });
  console.log(JSON.stringify({ ev: 'DRILL', name, pass, recovered, ledger, walk, recorded }));
  return pass;
}

// ── a socket bot that drives a hand ──────────────────────────────────────
function connectBot(token, tableId, onState) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'] });
  s.on('connect', () => s.emit('table:enter', { tableId }, (r) => r?.table && onState(r.table, s)));
  s.on('table:state', (st) => st.tableId === tableId && onState(st, s));
  return s;
}

// ══ drills ════════════════════════════════════════════════════════════════
async function main() {
  const db = new pg.Pool({ connectionString: DB_URL, max: 3 });

  bootServer();
  await waitHealthy();
  await loginCoach();

  // Dedicated fresh players per drill — no cross-drill state contamination
  // (a busted/seated player from one drill must never affect the next).
  let seq = 0;
  const freshPlayers = async (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await makePlayer(db, `crash${seq++}`));
    return out;
  };

  // ── Drill 5 FIRST (mid-sync reconcile) — no hands yet, cleanest ledger ──
  {
    const snapshot = {
      entries: Array.from({ length: 8 }, (_, i) => ({
        crm_entry_id: `les_${i}`, type: 'lesson', title: `Lesson ${i}`,
        scheduled_start: new Date(Date.now() + (i + 2) * 3600_000).toISOString(),
        scheduled_end: new Date(Date.now() + (i + 3) * 3600_000).toISOString(),
        student_crm_ids: [],
      })),
    };
    // Fire the PUT and kill almost immediately — the reconcile is mid-flight.
    const put = fetch(`${BASE}/sync/v1/lessons`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVER_ENV.EXPORT_API_KEY}` },
      body: JSON.stringify(snapshot),
    }).catch(() => {});
    await sleep(15); // let it get into reconcile
    await killHard();
    await put;
    const recovered = await restart();
    await loginCoach();
    // Re-push the SAME snapshot — declarative reconcile must converge.
    await fetch(`${BASE}/sync/v1/lessons`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVER_ENV.EXPORT_API_KEY}` },
      body: JSON.stringify(snapshot),
    });
    const { rows } = await db.query(
      `select count(*)::int n from tables where crm_entry_id is not null and status = 'scheduled'`
    );
    const converged = rows[0].n === 8;
    const ledger = await checkLedger(db);
    results.push({ drill: 'mid-sync-reconcile', pass: converged && ledger.ok, recovered, converged, scheduled: rows[0].n, ledger });
    console.log(JSON.stringify({ ev: 'DRILL', name: 'mid-sync-reconcile', pass: converged && ledger.ok, converged, scheduled: rows[0].n, ledger }));
  }

  // ── Drill 3 (kill during showdown) — cash table, drive an all-in ───────
  {
    const [a, b] = await freshPlayers(2);
    const created = await api('/tables', {
      method: 'POST', token: a.token,
      body: { small_blind: 50, big_blind: 100, table_size: 6, name: 'Crash showdown' },
    });
    const tableId = created.table.tableId;
    await api(`/tables/${tableId}/join`, { method: 'POST', token: a.token, body: { buy_in: 10_000 } }).catch(() => {});
    await api(`/tables/${tableId}/join`, { method: 'POST', token: b.token, body: { buy_in: 10_000 } });

    let killed = false;
    const drive = (state, sock) => {
      if (killed) return;
      // At showdown / hand_complete, pull the trigger.
      if (state.phase === 'showdown' || state.phase === 'hand_complete') {
        killed = true;
        killHard();
        return;
      }
      const seat = state.seats.find((s) => s && (s.playerId === a.id || s.playerId === b.id) && state.toAct === s.seatIndex);
      if (!seat) return;
      // Both jam to force an all-in runout to showdown.
      const legal = state.currentBet - seat.betThisRound;
      const act = seat.stack > 0 && state.currentBet < 10_000
        ? { action: 'raise', amount: seat.betThisRound + seat.stack }
        : (legal > 0 ? { action: 'call' } : { action: 'check' });
      sock.emit('table:action', { tableId, ...act }, () => {});
    };
    const s1 = connectBot(a.token, tableId, drive);
    const s2 = connectBot(b.token, tableId, drive);
    // wait for the kill
    for (let i = 0; i < 100 && !killed; i++) await sleep(100);
    s1.disconnect(); s2.disconnect();
    await sleep(200);
    const recovered = await restart();
    await loginCoach();
    await verify(db, 'kill-during-showdown', { recovered, expectRecover: 1 });
  }

  // ── Drill 2 (kill during awaiting_deal) — coached table ────────────────
  {
    const [a, b] = await freshPlayers(2);
    const created = await api('/tables', {
      method: 'POST', token: coachToken,
      body: { small_blind: 50, big_blind: 100, table_size: 6, name: 'Crash deal', mode: 'coached_cash' },
    });
    const tableId = created.table.tableId;
    await api(`/tables/${tableId}/join`, { method: 'POST', token: a.token, body: {} });
    await api(`/tables/${tableId}/join`, { method: 'POST', token: b.token, body: {} });

    // Coach socket: set preflop policy to manual, then deal → awaiting_deal.
    const cs = io(BASE, { auth: { token: coachToken }, transports: ['websocket'] });
    let awaiting = false;
    await new Promise((res) => cs.on('connect', res));
    cs.emit('table:observe', { tableId }, () => {});
    cs.on('table:coach_awaiting_deal', () => { awaiting = true; });
    cs.on('table:state', (st) => { if (st.tableId === tableId && st.awaitingDeal) awaiting = true; });
    cs.emit('coach:command', { tableId, command: 'panel:policy', payload: { street: 'preflop', policy: 'manual' } }, () => {
      cs.emit('coach:command', { tableId, command: 'deal', payload: {} }, () => {});
    });
    for (let i = 0; i < 60 && !awaiting; i++) await sleep(100);
    cs.disconnect();
    await killHard();
    const recovered = await restart();
    await loginCoach();
    await verify(db, 'kill-during-awaiting-deal', { recovered, expectRecover: 1, awaitingHit: awaiting });
    results[results.length - 1].awaitingHit = awaiting;
  }

  // ── Drill 4 (kill mid-export cursor walk) ──────────────────────────────
  // Generate a batch of completed cash hands first, then interrupt a walk.
  {
    const [a, b] = await freshPlayers(2);
    const created = await api('/tables', {
      method: 'POST', token: a.token,
      body: { small_blind: 50, big_blind: 100, table_size: 6, name: 'Crash export' },
    });
    const tableId = created.table.tableId;
    const buyIn = created.buy_in?.defaultAmount ?? 10_000;
    const jA = await api(`/tables/${tableId}/join`, { method: 'POST', token: a.token, body: { buy_in: buyIn } })
      .then(() => 'ok').catch((e) => e.message);
    const jB = await api(`/tables/${tableId}/join`, { method: 'POST', token: b.token, body: { buy_in: buyIn } })
      .then(() => 'ok').catch((e) => e.message);
    console.log(JSON.stringify({ ev: 'export_setup', buyIn, createBuyIn: created.buy_in, jA, jB }));
    // check/call down many small hands
    let handsDone = 0;
    const drive = (state, sock) => {
      const seat = state.seats.find((s) => s && state.toAct === s.seatIndex && (s.playerId === a.id || s.playerId === b.id));
      if (!seat) return;
      const toCall = state.currentBet - seat.betThisRound;
      sock.emit('table:action', { tableId, action: toCall > 0 ? 'call' : 'check' }, () => {});
    };
    const s1 = connectBot(a.token, tableId, (st, sk) => { drive(st, sk); if (st.handNo > handsDone) handsDone = st.handNo; });
    const s2 = connectBot(b.token, tableId, drive);
    for (let i = 0; i < 200 && handsDone < 30; i++) await sleep(50);
    s1.disconnect(); s2.disconnect();
    await sleep(500);

    // Interrupted walk: read a couple of pages, then kill mid-walk.
    const seen = new Map();
    let cursor = null, pages = 0, crashedWalk = false;
    try {
      for (;;) {
        const q = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=5` : '?limit=5';
        const res = await fetch(`${BASE}/export/v1/hands${q}`, {
          headers: { authorization: `Bearer ${SERVER_ENV.EXPORT_API_KEY}` },
        }).then((r) => r.json());
        for (const h of res.data) seen.set(`${h.hand_id}:${h.revision}`, true);
        pages += 1;
        cursor = res.next_cursor;
        if (pages === 2) { await killHard(); crashedWalk = true; } // kill after 2 pages
        if (!res.has_more) break;
      }
    } catch { /* the walk died with the server, as intended */ }
    const recovered = await restart();
    await loginCoach();
    // Resume from the last good cursor — must see the REST with no skip/dup.
    for (;;) {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=5` : '?limit=5';
      const res = await fetch(`${BASE}/export/v1/hands${q}`, {
        headers: { authorization: `Bearer ${SERVER_ENV.EXPORT_API_KEY}` },
      }).then((r) => r.json());
      for (const h of res.data) {
        const k = `${h.hand_id}:${h.revision}`;
        seen.set(k, (seen.get(k) ? 'DUP' : true)); // resume overlap is fine (at-least-once)
      }
      if (!res.has_more) break;
      cursor = res.next_cursor;
    }
    const recorded = await recordedHandCount(db);
    // Every recorded hand seen at least once across interrupted+resumed walk.
    const missing = recorded - [...seen.keys()].length;
    const ledger = await checkLedger(db);
    const pass = missing === 0 && ledger.ok && crashedWalk;
    results.push({ drill: 'mid-export-cursor-walk', pass, recovered, recorded, seen: seen.size, missing, ledger });
    console.log(JSON.stringify({ ev: 'DRILL', name: 'mid-export-cursor-walk', pass, recovered, recorded, seen: seen.size, missing }));
  }

  // ── Drill 1 (kill during tournament level change) ──────────────────────
  {
    const presets = await api('/tournament-presets');
    const turbo = presets.data.find((p) => p.name === 'Lesson Turbo');
    const t = await api('/tournaments', { method: 'POST', body: { preset_id: turbo.id, name: 'Crash Cup' } });
    const tableId = t.table.tableId;
    const tourneyPlayers = await freshPlayers(6);
    for (const p of tourneyPlayers) await api(`/tournaments/${tableId}/register`, { method: 'POST', token: p.token });
    await api(`/tournaments/${tableId}/start`, { method: 'POST' });

    // Watch the level; kill right after it ticks 1 → 2 (a real level change).
    const cs = io(BASE, { auth: { token: coachToken }, transports: ['websocket'] });
    await new Promise((res) => cs.on('connect', res));
    let level = 1, killedAt = null;
    cs.emit('table:observe', { tableId }, () => {});
    cs.on('table:state', (st) => {
      if (st.tableId === tableId && st.tournament && st.tournament.level > level) {
        level = st.tournament.level;
        if (!killedAt) { killedAt = level; cs.disconnect(); killHard(); }
      }
    });
    // Lesson Turbo levels are 8 min — too long to wait. Force the change via
    // the coach command, then kill on the resulting broadcast.
    await sleep(500);
    cs.emit('coach:command', { tableId, command: 'advance-level' }, () => {});
    for (let i = 0; i < 100 && !killedAt; i++) await sleep(100);
    if (!killedAt) { cs.disconnect(); await killHard(); } // safety
    await sleep(200);
    const recovered = await restart();
    await loginCoach();
    // Assert the tournament came back at the advanced level (clock persisted).
    const { rows } = await db.query(`select state->'clock'->>'level' as lvl from tournaments order by created_at desc limit 1`);
    const restoredLevel = Number(rows[0]?.lvl ?? 0);
    const ledger = await checkLedger(db);
    const walk = await exportWalk();
    const recorded = await recordedHandCount(db);
    const pass = recovered >= 1 && restoredLevel >= 2 && ledger.ok && walk.duplicates === 0 && walk.count === recorded;
    results.push({ drill: 'kill-during-level-change', pass, recovered, restoredLevel, killedAt, ledger, walk, recorded });
    console.log(JSON.stringify({ ev: 'DRILL', name: 'kill-during-level-change', pass, recovered, restoredLevel, killedAt }));
  }

  // ── summary ────────────────────────────────────────────────────────────
  const allPass = results.every((r) => r.pass);
  console.log(JSON.stringify({ ev: 'SUMMARY', allPass, drills: results }));
  await db.end();
  await killHard();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  console.log(JSON.stringify({ ev: 'FATAL', error: String(err.stack || err) }));
  await killHard().catch(() => {});
  process.exit(2);
});
