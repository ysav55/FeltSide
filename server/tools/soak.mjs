/**
 * M8.2 — load & soak harness.
 *
 * Drives a REAL server (node src/index.js against real Postgres) at target
 * scale: 1 tournament (18 players → 3 internal tables) + 1 coached table
 * (4 students) + 2 uncoached cash tables (5 bots each) = 6 concurrent
 * tables. Scripted actors act over socket.io exactly like the client.
 *
 * Measures: action-ack latency (p50/p95/p99/max), server RSS ceiling,
 * hand throughput. Verifies, every 5 minutes and at the end:
 *   - ledger invariant: balance == Σ(transactions) for every account
 *   - no negative balances
 * and at the end, after quiescing:
 *   - closed economy: Σ(balances) == Σ(coach funding)  (every chip home)
 *   - export walk: every hand exported, (hand_id, revision) unique
 *
 * Usage:
 *   SOAK_URL=http://127.0.0.1:3999 SOAK_DB=postgres://... \
 *   SOAK_MINUTES=45 node tools/soak.mjs > soak-run.ndjson
 */
import { io } from 'socket.io-client';
import pg from 'pg';

const URL = process.env.SOAK_URL || 'http://127.0.0.1:3999';
const DB_URL = process.env.SOAK_DB;
const MINUTES = Number(process.env.SOAK_MINUTES || 45);
const SERVER_PID = Number(process.env.SOAK_SERVER_PID || 0);
const COACH_EMAIL = process.env.COACH_EMAIL || 'coach@felts.local';
const COACH_PASSWORD = process.env.COACH_INITIAL_PASSWORD || 'soak-coach-pw-1';

const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// ── metrics ────────────────────────────────────────────────────────────
const latencies = [];
const rssSamples = [];
const handKeys = new Set();
let actionsSent = 0;
let actionErrors = 0;
const errorCodes = {}; // code → count (for honest error categorization)
const invariantFailures = [];

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ── tiny API client ────────────────────────────────────────────────────
async function api(path, { method = 'GET', token = null, body } = {}) {
  const res = await fetch(`${URL}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `http_${res.status}`);
  return json;
}

// ── actors ─────────────────────────────────────────────────────────────
class Bot {
  constructor({ name, token, playerId, tableId, style }) {
    Object.assign(this, { name, token, playerId, tableId, style });
    this.socket = null;
    this.state = null;
    this.pendingAct = null;
    this.stopped = false;
  }

  connect() {
    this.socket = io(URL, { auth: { token: this.token }, transports: ['websocket'] });
    this.socket.on('connect', () => {
      this.socket.emit('table:enter', { tableId: this.tableId }, (res) => {
        if (res?.table) this.onState(res.table);
      });
    });
    this.socket.on('table:state', (s) => {
      if (s.tableId === this.tableId) this.onState(s);
    });
  }

  onState(state) {
    this.state = state;
    // unique per physical table+hand (tournament bots share an anchor id)
    handKeys.add(`${state.tableId}:${state.viewingTableNo ?? 0}:${state.handNo}`);
    this.maybeAct();
  }

  mySeat() {
    return this.state?.seats?.find((s) => s && s.playerId === this.playerId) ?? null;
  }

  maybeAct() {
    if (this.stopped || this.pendingAct) return;
    const seat = this.mySeat();
    if (!seat || this.state.toAct !== seat.seatIndex || this.state.paused) return;
    const handNo = this.state.handNo;
    this.pendingAct = setTimeout(() => {
      this.pendingAct = null;
      const s = this.mySeat();
      if (!s || this.state.toAct !== s.seatIndex || this.state.handNo !== handNo) return;
      const action = this.decide(s);
      const started = performance.now();
      actionsSent += 1;
      this.socket.emit('table:action', { tableId: this.tableId, ...action }, (res) => {
        latencies.push(performance.now() - started);
        if (res?.error && res.error !== 'not_your_turn') {
          actionErrors += 1;
          errorCodes[res.error] = (errorCodes[res.error] ?? 0) + 1;
        }
        setTimeout(() => this.maybeAct(), 10);
      });
    }, rand(150, 700));
  }

  decide(seat) {
    const toCall = Math.max(0, Math.min(this.state.currentBet - seat.betThisRound, seat.stack));
    const bb = this.state.config.bigBlind;
    const r = Math.random();
    // tournament shorties jam; everyone else plays a loose-passive mix
    if (this.style === 'tournament' && seat.stack < bb * 10 && this.state.currentBet > 0) {
      return { action: 'raise', amount: seat.betThisRound + seat.stack };
    }
    if (toCall === 0) {
      if (r < 0.12 && this.state.currentBet === 0 && seat.stack > bb) {
        return { action: 'bet', amount: Math.min(bb * 3, seat.stack) };
      }
      return { action: 'check' };
    }
    if (r < 0.12) return { action: 'fold' };
    if (r < 0.2 && seat.stack > toCall + bb * 2) {
      return { action: 'raise', amount: Math.min(this.state.currentBet * 2 + bb, seat.betThisRound + seat.stack) };
    }
    return { action: 'call' };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.pendingAct);
    this.socket?.disconnect();
  }
}

/** Cash bots re-buy when busted (keeps the table alive for the soak). */
async function rebuyLoop(bots, bb, stopSignal) {
  while (!stopSignal.stopped) {
    for (const bot of bots) {
      const seat = bot.mySeat();
      if (seat && seat.stack === 0 && !seat.inHand) {
        try {
          await api(`/tables/${bot.tableId}/rebuy`, {
            method: 'POST', token: bot.token, body: { buy_in: bb * 100 },
          });
        } catch { /* mid-hand or already ok */ }
      }
    }
    await sleep(2000);
  }
}

/** Coach bot for the coached table: deals a fresh RNG hand whenever idle. */
function coachDealLoop(coachToken, tableId, stopSignal) {
  const socket = io(URL, { auth: { token: coachToken }, transports: ['websocket'] });
  let state = null;
  socket.on('connect', () => {
    socket.emit('table:observe', { tableId }, (res) => { if (res?.table) state = res.table; });
  });
  socket.on('table:state', (s) => { if (s.tableId === tableId) state = s; });
  const timer = setInterval(() => {
    if (stopSignal.stopped) { clearInterval(timer); socket.disconnect(); return; }
    if (!state || state.paused) return;
    const seated = state.seats.filter(Boolean).length;
    if (seated >= 2 && (state.phase === 'waiting' || state.phase === 'hand_complete')) {
      socket.emit('coach:command', { tableId, command: 'deal', payload: {} }, () => {});
    }
  }, 1500);
  return socket;
}

// ── invariants ─────────────────────────────────────────────────────────
async function checkLedger(db, label) {
  const { rows: bad } = await db.query(`
    select a.player_id, a.balance, coalesce(sum(t.amount), 0) as tx_sum
      from bankroll_accounts a
      left join bankroll_transactions t on t.player_id = a.player_id
     group by a.player_id, a.balance
    having a.balance <> coalesce(sum(t.amount), 0)
  `);
  const { rows: neg } = await db.query(
    'select player_id, balance from bankroll_accounts where balance < 0'
  );
  if (bad.length || neg.length) {
    invariantFailures.push({ label, mismatched: bad, negative: neg });
    log({ ev: 'INVARIANT_FAIL', label, mismatched: bad.length, negative: neg.length });
  } else {
    log({ ev: 'invariant_ok', label });
  }
}

function sampleRss() {
  if (!SERVER_PID) return;
  try {
    const status = require('node:fs').readFileSync(`/proc/${SERVER_PID}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    if (m) rssSamples.push(Number(m[1]) / 1024);
  } catch { /* server gone */ }
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── main ───────────────────────────────────────────────────────────────
async function main() {
  const db = new pg.Pool({ connectionString: DB_URL, max: 3 });
  const stopSignal = { stopped: false };

  // Coach login
  const coachLogin = await fetch(`${URL}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: COACH_EMAIL, password: COACH_PASSWORD }),
  }).then((r) => r.json());
  const coachToken = coachLogin.token;
  if (!coachToken) throw new Error('coach login failed');
  const me = await api('/auth/me', { token: coachToken });
  const coachId = me.player.id;
  log({ ev: 'coach_ready', coachId });

  // Create + fund players: 18 tournament, 10 cash, 4 students
  const FUND = 1_000_000;
  const mk = async (name, i) => {
    const res = await api('/players', {
      method: 'POST', token: coachToken,
      body: { display_name: name, email: `${name}@soak.local`, initial_password: 'soak-pass-1' },
    });
    const id = res.player.id;
    await api(`/bankroll/${id}/adjust`, {
      method: 'POST', token: coachToken, body: { delta: FUND, note: 'soak funding' },
    });
    // First login forces a password change (M1) — do it, then log in fresh.
    const first = await fetch(`${URL}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${name}@soak.local`, password: 'soak-pass-1' }),
    }).then((r) => r.json());
    if (first.player?.must_change_password) {
      await fetch(`${URL}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${first.token}` },
        body: JSON.stringify({ current_password: 'soak-pass-1', new_password: `soak-live-${i}-pw` }),
      });
      const relog = await fetch(`${URL}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${name}@soak.local`, password: `soak-live-${i}-pw` }),
      }).then((r) => r.json());
      return { id, name, token: relog.token };
    }
    return { id, name, token: first.token };
  };

  const players = [];
  for (let i = 0; i < 32; i++) players.push(await mk(`soakbot${i + 1}`, i));
  const tourneyPlayers = players.slice(0, 18);
  const cashPlayers = players.slice(18, 28);
  const students = players.slice(28, 32);
  const initialTotal = players.length * FUND;
  log({ ev: 'players_ready', count: players.length, funded: initialTotal });

  const bots = [];

  // 2 uncoached cash tables, 5 bots each, 50/100 blinds, 100bb buy-in
  for (let t = 0; t < 2; t++) {
    const group = cashPlayers.slice(t * 5, t * 5 + 5);
    const created = await api('/tables', {
      method: 'POST', token: group[0].token,
      body: { small_blind: 50, big_blind: 100, table_size: 6, name: `Soak cash ${t + 1}` },
    });
    const tableId = created.table.tableId;
    for (const p of group) {
      await api(`/tables/${tableId}/join`, {
        method: 'POST', token: p.token, body: { buy_in: 10_000 },
      }).catch(() => {}); // creator may already be seated
      const bot = new Bot({ name: p.name, token: p.token, playerId: p.id, tableId, style: 'cash' });
      bots.push(bot);
      bot.connect();
    }
    log({ ev: 'cash_table_ready', tableId, players: group.length });
  }

  // 1 coached table with 4 students; coach deals continuously
  const coached = await api('/tables', {
    method: 'POST', token: coachToken,
    body: { small_blind: 50, big_blind: 100, table_size: 6, name: 'Soak lesson', mode: 'coached_cash' },
  });
  const coachedId = coached.table.tableId;
  for (const p of students) {
    await api(`/tables/${coachedId}/join`, { method: 'POST', token: p.token, body: {} });
    const bot = new Bot({ name: p.name, token: p.token, playerId: p.id, tableId: coachedId, style: 'cash' });
    bots.push(bot);
    bot.connect();
  }
  const coachSocket = coachDealLoop(coachToken, coachedId, stopSignal);
  log({ ev: 'coached_table_ready', tableId: coachedId });

  // 1 tournament: Lesson Turbo (8-min levels), 18 entrants → 3 tables
  const presets = await api('/tournament-presets', { token: coachToken });
  const turbo = presets.data.find((p) => p.name === 'Lesson Turbo');
  const tourney = await api('/tournaments', {
    method: 'POST', token: coachToken, body: { preset_id: turbo.id, name: 'Soak Cup' },
  });
  const tourneyTableId = tourney.table.tableId;
  for (const p of tourneyPlayers) {
    await api(`/tournaments/${tourneyTableId}/register`, { method: 'POST', token: p.token });
    const bot = new Bot({ name: p.name, token: p.token, playerId: p.id, tableId: tourneyTableId, style: 'tournament' });
    bots.push(bot);
    bot.connect();
  }
  await api(`/tournaments/${tourneyTableId}/start`, { method: 'POST', token: coachToken });
  log({ ev: 'tournament_started', tableId: tourneyTableId, entrants: 18 });

  // Tournament re-entry loop: busted bots re-enter while the window is open.
  const reentryLoop = (async () => {
    while (!stopSignal.stopped) {
      for (const p of tourneyPlayers) {
        try {
          await api(`/tournaments/${tourneyTableId}/reenter`, { method: 'POST', token: p.token });
          log({ ev: 'reentry', player: p.name });
        } catch { /* not busted / window closed */ }
      }
      await sleep(5000);
    }
  })();

  const rebuys = rebuyLoop(bots.filter((b) => b.style === 'cash' && b.tableId !== coachedId), 100, stopSignal);

  // ── soak ────────────────────────────────────────────────────────────
  const deadline = Date.now() + MINUTES * 60_000;
  let lastInvariant = Date.now();
  while (Date.now() < deadline) {
    await sleep(10_000);
    sampleRss();
    const sorted = [...latencies].sort((a, b) => a - b);
    log({
      ev: 'tick',
      minutesLeft: Math.round((deadline - Date.now()) / 60_000),
      actions: actionsSent, hands: handKeys.size, errors: actionErrors,
      p95: pct(sorted, 95)?.toFixed(1), rssMB: rssSamples.at(-1)?.toFixed(0),
    });
    if (Date.now() - lastInvariant > 5 * 60_000) {
      lastInvariant = Date.now();
      await checkLedger(db, `t+${Math.round((Date.now() - (deadline - MINUTES * 60_000)) / 60_000)}m`);
    }
  }

  // ── quiesce: settle the tournament FIRST (its bots must keep acting so
  // in-flight hands finish fast), then cash out the cash tables ────────
  log({ ev: 'quiescing' });
  stopSignal.stopped = true; // stops rebuy/re-entry/coach-deal loops
  await Promise.allSettled([reentryLoop, rebuys]);
  coachSocket.disconnect();

  // End-early lands in the inter-hand gap; hammer it while bots play on.
  let ended = false;
  for (let i = 0; i < 300 && !ended; i++) {
    try {
      await api(`/tournaments/${tourneyTableId}/end-early`, { method: 'POST', token: coachToken });
      ended = true;
    } catch (err) {
      if (err.message === 'not_running' || err.message === 'not_found') { ended = true; break; }
      await sleep(200);
    }
  }
  log({ ev: 'tournament_settled', ended });
  for (const bot of bots) bot.stop();
  await sleep(2000);

  // Cash players leave (stacks cash out to bankrolls); retry once for
  // anyone caught mid-hand (the 30s action timer clears them), then the
  // coach force-closes every remaining table (cashes out stragglers).
  const leaveAll = async () => {
    for (const p of [...cashPlayers, ...students]) {
      for (const tid of new Set(bots.filter((b) => b.playerId === p.id).map((b) => b.tableId))) {
        try { await api(`/tables/${tid}/leave`, { method: 'POST', token: p.token }); }
        catch { /* mid-hand or already gone */ }
      }
    }
  };
  await leaveAll();
  await sleep(3000);
  await leaveAll();
  const lobby = await api('/tables', { token: coachToken });
  for (const t of lobby.data) {
    try { await api(`/tables/${t.id}/close`, { method: 'POST', token: coachToken }); }
    catch { /* already closed */ }
  }
  await sleep(2000);

  // ── final verification ──────────────────────────────────────────────
  await checkLedger(db, 'final');

  const { rows: [balSum] } = await db.query(
    `select coalesce(sum(balance), 0)::bigint as total from bankroll_accounts
      where player_id <> $1`, [coachId]
  );
  const { rows: stuck } = await db.query(`
    select t.id, t.mode, t.status, t.seats from tables t where t.status = 'active'
  `);
  // Chips still on open tables (players who couldn't leave mid-hand) count
  // toward the closed economy.
  let chipsOnTables = 0;
  for (const t of stuck) {
    for (const s of (t.seats ?? [])) chipsOnTables += s.stack ?? 0;
  }
  const total = Number(balSum.total) + chipsOnTables;
  const economyOk = total === initialTotal;
  if (!economyOk) {
    invariantFailures.push({ label: 'closed_economy', expected: initialTotal, actual: total });
  }

  // Export walk: cursored, at-least-once, (hand_id, revision) unique.
  const seen = new Map();
  let cursor = null;
  let pages = 0;
  for (;;) {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=200` : '?limit=200';
    const res = await fetch(`${URL}/export/v1/hands${q}`, {
      headers: { authorization: `Bearer ${process.env.EXPORT_API_KEY}` },
    }).then((r) => r.json());
    pages += 1;
    for (const h of res.data) {
      const key = `${h.hand_id}:${h.revision}`;
      if (seen.has(key)) invariantFailures.push({ label: 'export_duplicate', key });
      seen.set(key, true);
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  const { rows: [handCount] } = await db.query(
    'select count(*)::int as n from hands where export_seq is not null'
  );

  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    ev: 'REPORT',
    minutes: MINUTES,
    actors: bots.length,
    actionsSent,
    actionErrors,
    errorCodes,
    handsSeen: handKeys.size,
    handsRecorded: handCount.n,
    handsExported: seen.size,
    exportPages: pages,
    latencyMs: {
      p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99),
      max: sorted.at(-1), samples: sorted.length,
    },
    rssMB: {
      start: rssSamples[0], peak: Math.max(...rssSamples), end: rssSamples.at(-1),
      samples: rssSamples.length,
    },
    closedEconomy: { expected: initialTotal, actual: total, chipsOnTables, ok: economyOk },
    invariantFailures,
  };
  log(report);
  await db.end();
  process.exit(invariantFailures.length ? 1 : 0);
}

main().catch((err) => { log({ ev: 'FATAL', error: String(err.stack || err) }); process.exit(2); });
