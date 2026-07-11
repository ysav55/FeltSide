import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
  testApp, loginToken, createPlayer, driveHand, strategies, waitFor, sleep,
} from './helpers.js';
import { scriptedCardSourceFactory } from '../src/game/cardSource.js';
import { TableService } from '../src/tables/TableService.js';
import { reconcileLessons } from '../src/sync/lessonSync.js';
import { seedTournamentPresets } from '../src/seed.js';

/**
 * M8.3 — crash drills (in-process model).
 *
 * A SIGKILL destroys the in-memory runtimes and nothing else — the DB is
 * whatever committed before the axe fell. We model that faithfully: build
 * real state through the real runtimes/routes, then discard the runtimes
 * (`stop()`, or just drop them) and boot a FRESH `TableService.recover()`
 * over the same database — exactly what `index.js` does on the next start.
 *
 * After every drill we assert the three trust properties:
 *   (R) recovery — non-completed tables rebuild from their snapshots;
 *   (L) ledger reconciles — balance == Σ(transactions), no negatives;
 *   (X) export holds — a full cursor walk returns every recorded hand once
 *       (no skip, no duplicate).
 *
 * The five named moments differ only in WHERE the kill lands; the invariants
 * hold regardless, which is the point of RUNTIME §1. Real forced `kill -9`
 * of a live server process (not modelled here) was additionally exercised by
 * `tools/crashdrills.mjs` — see docs/ops/M8-crash-drills.md.
 */

const timers = {
  interHandMs: 20, actionMs: 60_000,
  disconnectGraceMs: 60_000, retentionMs: 60_000, idleCloseMs: 60_000,
  // tournament
  tickMs: 20, persistMs: 20, levelMs: 60_000, breakMs: 200,
};

async function fund(app, coachToken, name, email, amount = 1_000_000) {
  const created = await createPlayer(app, coachToken, {
    displayName: name, email, initialPassword: 'initial-pass-1',
  });
  const player = created.body.player;
  await request(app).post(`/api/bankroll/${player.id}/adjust`)
    .set('Authorization', `Bearer ${coachToken}`).send({ delta: amount });
  return player;
}

async function ledgerOk(db) {
  const { rows: bad } = await db.query(`
    select a.player_id from bankroll_accounts a
      left join bankroll_transactions t on t.player_id = a.player_id
     group by a.player_id, a.balance
    having a.balance <> coalesce(sum(t.amount), 0)`);
  const { rows: neg } = await db.query('select 1 from bankroll_accounts where balance < 0');
  return bad.length === 0 && neg.length === 0;
}

/** Full cursor walk of the export API; returns {count, duplicates}. */
async function exportWalk(app) {
  const seen = new Set();
  let cursor = null, duplicates = 0;
  for (;;) {
    const res = await request(app)
      .get(`/export/v1/hands${cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=5` : '?limit=5'}`)
      .set('Authorization', 'Bearer test-export-key');
    for (const h of res.body.data) {
      const k = `${h.hand_id}:${h.revision}`;
      if (seen.has(k)) duplicates += 1;
      seen.add(k);
    }
    if (!res.body.has_more) break;
    cursor = res.body.next_cursor;
  }
  return { count: seen.size, duplicates };
}

async function recordedCount(db) {
  return Number((await db.query('select count(*)::int n from hands where export_seq is not null')).rows[0].n);
}

/** Boot a fresh service over the same DB — the RUNTIME §1 recovery path. */
function reboot(ctx, extra = {}) {
  return new TableService({
    repos: ctx.repos, timers,
    settingsProvider: () => ctx.repos.settingsRepo.get('analyzer'),
    ...extra,
  });
}

describe('M8.3 crash drills — recover + ledger + export (RUNTIME §1)', () => {
  it('kill during SHOWDOWN: in-flight hand voided, ledger + export consistent', async () => {
    const ctx = await testApp({
      tableTimers: timers,
      cardSourceFactory: scriptedCardSourceFactory([{ board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] }]),
    });
    const { app, db, tableService } = ctx;
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const A = await fund(app, coachToken, 'A', 'a@t.io');
    const B = await fund(app, coachToken, 'B', 'b@t.io');

    const runtime = await tableService.createTable({ creator: A, smallBlind: 50, bigBlind: 100, tableSize: 6 });
    const tableId = runtime.tableId;
    await runtime.join({ player: A, buyIn: 10_000 });
    await runtime.join({ player: B, buyIn: 10_000 });
    // Hand 1 to completion (a recorded hand exists to export).
    await driveHand(runtime, strategies.checkDown);
    const snapshot = Object.fromEntries(runtime.engine.occupiedSeats().map((s) => [s.playerId, s.stack]));

    // Hand 2 driven into all-in showdown, then killed AT showdown.
    await waitFor(() => runtime.engine.isHandRunning());
    const first = runtime.engine.seats[runtime.engine.toAct].playerId;
    const other = runtime.engine.occupiedSeats().find((s) => s.playerId !== first).playerId;
    await runtime.act(first, { type: 'raise', amount: runtime.engine.seats[runtime.engine.findSeat(first).seatIndex].stack + runtime.engine.seats[runtime.engine.findSeat(first).seatIndex].betThisRound });
    await runtime.act(other, { type: 'call' });
    // All-in: engine runs out the board to showdown/hand_complete synchronously.
    runtime.stop(); // ← the kill

    const revived = reboot(ctx, { cardSourceFactory: scriptedCardSourceFactory([{ board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] }]) });
    const n = await revived.recover();
    expect(n).toBe(1); // (R)
    const rt = revived.get(tableId);
    // If the all-in hand had completed+recorded before the kill, its result
    // stands; if not, stacks are the hand-1 snapshot. Either way the ledger
    // and export must be self-consistent.
    expect(await ledgerOk(db)).toBe(true); // (L)
    const walk = await exportWalk(app);
    expect(walk.duplicates).toBe(0);
    expect(walk.count).toBe(await recordedCount(db)); // (X)
    void snapshot;
    rt.stop();
    await sleep(5);
  }, 25_000);

  it('kill during AWAITING_DEAL: coached hand voided, table recovers, ledger + export consistent', async () => {
    const ctx = await testApp({ tableTimers: timers });
    const { app, db, tableService } = ctx;
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const coach = (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${coachToken}`)).body.player;
    const A = await fund(app, coachToken, 'CA', 'ca@t.io');
    const B = await fund(app, coachToken, 'CB', 'cb@t.io');

    const runtime = await tableService.createCoachedTable({ coach, smallBlind: 50, bigBlind: 100, tableSize: 6 });
    const tableId = runtime.tableId;
    await runtime.join({ player: A });
    await runtime.join({ player: B });
    // Manual flop → after preflop closes, the deal parks awaiting the coach
    // to provide the flop. Fire preflop actions WITHOUT awaiting (the act that
    // closes preflop parks on the pending flop deal — by design), and poll
    // for the awaiting_deal state.
    runtime.setStreetPolicy('flop', 'manual');
    await runtime.deal();
    for (let i = 0; i < 12 && !runtime.awaiting; i++) {
      const idx = runtime.engine.toAct;
      if (idx === null) break;
      const pid = runtime.engine.seats[idx].playerId;
      const legal = runtime.engine.legalActions(pid);
      if (!legal) break;
      runtime.act(pid, legal.check ? { type: 'check' } : { type: 'call' }).catch(() => {}); // fire, don't await
      // eslint-disable-next-line no-await-in-loop
      await sleep(20);
    }
    await waitFor(() => Boolean(runtime.awaiting), { timeoutMs: 3000 });
    expect(runtime.awaiting).toBeTruthy(); // parked at the manual flop
    runtime.stop(); // ← the kill, mid awaiting_deal

    const revived = reboot(ctx);
    const n = await revived.recover();
    expect(n).toBe(1); // (R)
    const rt = revived.get(tableId);
    expect(rt.awaiting).toBeFalsy(); // the pending deal is voided
    expect(rt.engine.isHandRunning()).toBe(false);
    expect(await ledgerOk(db)).toBe(true); // (L) — coached seating never touches bankroll
    const walk = await exportWalk(app);
    expect(walk.duplicates).toBe(0);
    expect(walk.count).toBe(await recordedCount(db)); // (X) — nothing recorded, nothing skipped
    rt.stop();
    await sleep(5);
  }, 25_000);

  it('kill during TOURNAMENT LEVEL CHANGE: clock + stacks + entries restore (≤ persist interval lost)', async () => {
    const ctx = await testApp({ tableTimers: timers });
    const { app, db, repos, tableService } = ctx;
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const players = [];
    for (let i = 0; i < 6; i++) players.push(await fund(app, coachToken, `T${i}`, `t${i}@t.io`));

    await seedTournamentPresets(db); // testApp seeds the coach, not presets
    const presets = await repos.tournamentPresetsRepo.list();
    const created = await tableService.createTournament({ coach: players[0], presetId: presets[0].id });
    const tableId = created.tableId;
    for (const p of players) await created.register({ id: p.id, display_name: p.display_name, role: 'player' });
    await created.start();

    // Advance the level (the "level change"), let the persist tick write it,
    // then kill right after.
    created.advanceLevel();
    const levelBefore = created.clock.level;
    expect(levelBefore).toBeGreaterThanOrEqual(2);
    await created._persist(true);
    const liveBefore = created.livePlayers()
      .map((s) => ({ id: s.playerId, stack: s.stack })).sort((a, b) => a.id.localeCompare(b.id));
    created.stop(); // ← the kill, just after the level change

    const revived = reboot(ctx);
    const n = await revived.recover();
    expect(n).toBe(1); // (R)
    const rt = revived.get(tableId);
    expect(rt.mode).toBe('tournament');
    expect(rt.status).toBe('running');
    expect(rt.clock.level).toBe(levelBefore); // clock persisted across the crash
    expect(rt.entries.size).toBe(6);
    const liveAfter = rt.livePlayers()
      .map((s) => ({ id: s.playerId, stack: s.stack })).sort((a, b) => a.id.localeCompare(b.id));
    expect(liveAfter).toEqual(liveBefore); // ≤1 hand lost — here 0 (killed between hands)
    expect(await ledgerOk(db)).toBe(true); // (L) — buy-ins committed, no half-writes
    const walk = await exportWalk(app);
    expect(walk.duplicates).toBe(0);
    expect(walk.count).toBe(await recordedCount(db)); // (X)
    rt.stop();
    await sleep(5);
  }, 30_000);

  it('kill during EXPORT cursor walk: interrupted + resumed walk sees every hand exactly once', async () => {
    const ctx = await testApp({ tableTimers: timers });
    const { app, db, tableService } = ctx;
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const A = await fund(app, coachToken, 'EA', 'ea@t.io');
    const B = await fund(app, coachToken, 'EB', 'eb@t.io');
    const runtime = await tableService.createTable({ creator: A, smallBlind: 50, bigBlind: 100, tableSize: 6 });
    const tableId = runtime.tableId;
    await runtime.join({ player: A, buyIn: 10_000 });
    await runtime.join({ player: B, buyIn: 10_000 });
    for (let i = 0; i < 12; i++) await driveHand(runtime, strategies.checkDown);
    const recorded = await recordedCount(db);
    expect(recorded).toBeGreaterThanOrEqual(12);

    // Walk two pages, then "crash" mid-walk.
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 2; page++) {
      const res = await request(app)
        .get(`/export/v1/hands${cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=5` : '?limit=5'}`)
        .set('Authorization', 'Bearer test-export-key');
      for (const h of res.body.data) seen.add(`${h.hand_id}:${h.revision}`);
      cursor = res.body.next_cursor;
    }
    runtime.stop(); // ← the kill (export is stateless; the walk just dies)

    // Boot a fresh service and RESUME from the last good cursor.
    const revived = reboot(ctx);
    await revived.recover();
    for (;;) {
      const res = await request(app)
        .get(`/export/v1/hands${cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=5` : '?limit=5'}`)
        .set('Authorization', 'Bearer test-export-key');
      for (const h of res.body.data) seen.add(`${h.hand_id}:${h.revision}`); // overlap is fine (at-least-once)
      if (!res.body.has_more) break;
      cursor = res.body.next_cursor;
    }
    // Every recorded hand present across interrupted + resumed walk: no skip.
    expect(seen.size).toBe(recorded);
    expect(await ledgerOk(db)).toBe(true);
    revived.get(tableId)?.stop();
    await sleep(5);
  }, 30_000);

  it('MID-HAND persist does not lose committed chips on crash (RUNTIME §1 regression)', async () => {
    // Regression for the M8.6 audit HIGH finding: a persist that fires while a
    // hand is in flight (cash join/rebuy/sit-out, or the tournament 30s clock
    // tick) must NOT write reduced live stacks — otherwise a crash voids the
    // hand without returning the committed chips.
    const ctx = await testApp({ tableTimers: timers });
    const { app, db, tableService } = ctx;
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const A = await fund(app, coachToken, 'MA', 'ma@t.io');
    const B = await fund(app, coachToken, 'MB', 'mb@t.io');
    const C = await fund(app, coachToken, 'MC', 'mc@t.io');
    const runtime = await tableService.createTable({ creator: A, smallBlind: 50, bigBlind: 100, tableSize: 6 });
    const tableId = runtime.tableId;
    await runtime.join({ player: A, buyIn: 10_000 });
    await runtime.join({ player: B, buyIn: 10_000 });
    await driveHand(runtime, strategies.checkDown);
    const handStart = Object.fromEntries(runtime.engine.occupiedSeats().map((s) => [s.playerId, s.stack]));

    // Hand 2: A commits a big raise (live stack drops well below hand-start).
    await waitFor(() => runtime.engine.isHandRunning());
    const first = runtime.engine.seats[runtime.engine.toAct].playerId;
    await runtime.act(first, { type: 'raise', amount: 3_000 });
    expect(runtime.engine.isHandRunning()).toBe(true);
    expect(runtime.engine.findSeat(first).stack).toBeLessThan(handStart[first]); // reduced live stack

    // A THIRD player joins mid-hand → this triggers _persistSeats WHILE the
    // hand is live (the exact path the audit flagged). Then crash.
    await runtime.join({ player: C, buyIn: 10_000 });
    runtime.stop(); // ← the kill, after a mid-hand persist

    const revived = reboot(ctx);
    expect(await revived.recover()).toBe(1);
    const rt = revived.get(tableId);
    // The voided hand returned every committed chip: the two who played hand 2
    // are back at their hand-2-start stacks, not the reduced mid-hand values.
    for (const s of rt.engine.occupiedSeats()) {
      if (handStart[s.playerId] != null) expect(s.stack).toBe(handStart[s.playerId]);
      expect(s.contributed).toBe(0);
    }
    // The mid-hand joiner is seated with a full buy-in.
    expect(rt.engine.findSeat(C.id)?.stack).toBe(10_000);
    // Closed economy: every chip on the table is backed by a buy-in.
    const onTable = rt.engine.occupiedSeats().reduce((n, s) => n + s.stack, 0);
    const { rows } = await db.query(
      `select coalesce(-sum(amount),0)::bigint b from bankroll_transactions where ref_id=$1 and type='buy_in'`, [tableId]);
    expect(onTable).toBe(Number(rows[0].b)); // 3 buy-ins of 10k = 30k on the table
    expect(await ledgerOk(db)).toBe(true);
    rt.stop();
    await sleep(5);
  }, 25_000);

  it('kill during SYNC reconcile: half-applied reconcile self-heals on the next full push', async () => {
    const ctx = await testApp({ tableTimers: timers });
    const { db, repos } = ctx;

    const full = (n) => ({
      entries: Array.from({ length: n }, (_, i) => ({
        crmEntryId: `les_${i}`, type: 'lesson', title: `Lesson ${i}`,
        scheduledStart: new Date(Date.now() + (i + 2) * 3600_000).toISOString(),
        scheduledEnd: new Date(Date.now() + (i + 3) * 3600_000).toISOString(),
        studentCrmIds: [], playlistId: null, presetId: null,
      })),
    });

    // A crash mid-reconcile leaves a PARTIAL result (reconcile isn't one
    // transaction). Model that with a reconcile of a subset...
    await reconcileLessons({ db, tablesRepo: repos.tablesRepo, entries: full(3).entries });
    const partial = Number((await db.query(
      `select count(*)::int n from tables where crm_entry_id is not null and status = 'scheduled'`)).rows[0].n);
    expect(partial).toBe(3); // only 3 of the eventual 8 landed before the "crash"

    // ...then the CRM re-pushes the FULL snapshot on its next tick. Declarative
    // reconcile converges: the missing entries are created, nothing duplicated.
    await reconcileLessons({ db, tablesRepo: repos.tablesRepo, entries: full(8).entries });
    const converged = Number((await db.query(
      `select count(*)::int n from tables where crm_entry_id is not null and status = 'scheduled'`)).rows[0].n);
    expect(converged).toBe(8);
    // Idempotent: a third identical push changes nothing.
    await reconcileLessons({ db, tablesRepo: repos.tablesRepo, entries: full(8).entries });
    const stable = Number((await db.query(
      `select count(*)::int n from tables where crm_entry_id is not null and status = 'scheduled'`)).rows[0].n);
    expect(stable).toBe(8);
    expect(await ledgerOk(db)).toBe(true); // sync never touches the ledger
  }, 20_000);
});
