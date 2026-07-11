import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { testApp, loginToken, sleep } from './helpers.js';
import { seedTournamentPresets } from '../src/seed.js';
import { TableService } from '../src/tables/TableService.js';

/**
 * M7 acceptance: a full simulated 18-player, 3-table tournament with
 * scripted bots. Proves the TOURNAMENTS.md invariants end to end:
 * balancing (§4), breaking + final-table redraw (§4), hand-for-hand at the
 * bubble (§3), closed-economy payouts to the chip (§5), clock persistence
 * across a restart (RUNTIME §1), and interventions (§6).
 */

const KEY = 'test-export-key';

// levelMs is generous: the clock burns real time, and runaway blinds would
// force multi-way blind all-ins that could multi-bust through the bubble.
const FAST = {
  levelMs: 8_000, breakMs: 30, tickMs: 10,
  actionMs: 60_000, interHandMs: 1, persistMs: 20,
};

/** Mixed bots: strictly-below-median or blind-pressured stacks jam. */
const mixed = (pid, legal, engine) => {
  const seat = engine.findSeat(pid);
  const stacks = engine.occupiedSeats().map((s) => s.stack).sort((a, b) => a - b);
  const median = stacks[Math.floor(stacks.length / 2)];
  const isShort = seat.stack < median || seat.stack < engine.config.bigBlind * 8;
  if (isShort && legal.raise) return { type: 'raise', amount: legal.raise.maxTo };
  if (isShort && legal.bet) return { type: 'bet', amount: legal.bet.max };
  if (legal.call) return { type: 'call' };
  return legal.check ? { type: 'check' } : { type: 'fold' };
};

const passive = (pid, legal) =>
  legal.check ? { type: 'check' } : { type: 'fold' };

const checkCall = (pid, legal) =>
  legal.call ? { type: 'call' } : (legal.check ? { type: 'check' } : { type: 'fold' });

/**
 * Near the bubble: only the shortest stack jams and only the chip leader
 * calls — at most one player is ever at risk, so eliminations come one at
 * a time and the field passes exactly through the bubble count.
 */
const singleElimination = (pid, legal, engine) => {
  const seats = engine.occupiedSeats();
  const short = seats.reduce((a, b) => (a.stack < b.stack ? a : b));
  const big = seats.reduce((a, b) => (a.stack > b.stack ? a : b));
  if (pid === short.playerId) {
    if (legal.raise) return { type: 'raise', amount: legal.raise.maxTo };
    if (legal.bet) return { type: 'bet', amount: legal.bet.max };
    return legal.call ? { type: 'call' } : { type: 'check' };
  }
  if (pid === big.playerId) return checkCall(pid, legal);
  return legal.check ? { type: 'check' } : { type: 'fold' };
};

async function fixture({ players = 18, roll = 100_000 } = {}) {
  const ctx = await testApp({ tableTimers: FAST });
  await seedTournamentPresets(ctx.db);
  const { playersRepo, bankrollRepo } = ctx.repos;
  const ids = [];
  for (let i = 0; i < players; i++) {
    const p = await playersRepo.create({
      displayName: `Bot${i + 1}`, email: `bot${i + 1}@test.local`,
      passwordHash: 'x', role: 'player', mustChangePassword: false,
    });
    await bankrollRepo.createAccount(p.id);
    await bankrollRepo.applyTransaction({
      playerId: p.id, type: 'coach_adjustment', amount: roll, note: 'roll',
    });
    ids.push({ id: p.id, name: `Bot${i + 1}` });
  }
  const coachToken = await loginToken(ctx.app, 'coach@test.local', 'coach-secret-1');
  const presets = await ctx.repos.tournamentPresetsRepo.list();
  return { ...ctx, ids, coachToken, presets };
}

/**
 * Drives all tables until `until(runtime)` or completion. Acts directly on
 * the engines (bypasses the pause gate so tests can flush in-flight hands).
 */
async function drive(runtime, { policy = mixed, until = null, each = null, timeoutMs = 120_000 } = {}) {
  const start = Date.now();
  while (runtime.status === 'running') {
    if (until && until(runtime)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`drive timeout (live=${runtime.liveCount()}, level=${runtime.clock.level})`);
    }
    let acted = false;
    for (const t of [...runtime.tables.values()]) {
      const e = t.engine;
      if (!e.isHandRunning() || e.toAct === null) continue;
      const pid = e.seats[e.toAct].playerId;
      const legal = e.legalActions(pid);
      if (!legal) continue;
      try {
        await e.act(pid, policy(pid, legal, e, t.no));
        acted = true;
      } catch { /* boundary race — retry */ }
    }
    if (each) each(runtime);
    if (!acted) await sleep(3);
  }
}

/**
 * Deterministic tournament script: all eliminations happen at the lowest-
 * numbered active table (one at a time — shorty jams, chip leader calls,
 * everyone else folds); other tables play passively. This forces every §4
 * mechanism to fire: the target table keeps shrinking → balance moves in →
 * the field compresses → break → final-table redraw → bubble one bust at a
 * time → hand-for-hand at exactly paid+1.
 */
const targeted = (runtime) => (pid, legal, engine, tableNo) => {
  const active = [...runtime.tables.values()].filter((t) => t.engine.occupiedSeats().length > 0);
  const target = active.reduce((a, b) => (a.no < b.no ? a : b));
  return tableNo === target.no
    ? singleElimination(pid, legal, engine)
    : passive(pid, legal);
};

const settle = async (runtime) => {
  await drive(runtime, {
    policy: checkCall,
    until: (rt) => ![...rt.tables.values()].some((t) => t.engine.isHandRunning()),
  });
  for (const t of runtime.tables.values()) await t.chain;
};

const tableCounts = (rt) =>
  [...rt.tables.values()].map((t) => t.engine.occupiedSeats().length).filter((n) => n > 0);

describe('M7 acceptance — 18 players, 3 tables (TOURNAMENTS.md)', () => {
  it('runs the whole tournament: balance, break, redraw, hand-for-hand, payouts to the chip', async () => {
    const { app, repos, tableService, ids, coachToken, presets } = await fixture();
    const turbo = presets[0]; // Lesson Turbo, 6-max → 18 players = 3 tables

    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: turbo.id, name: 'Acceptance Cup' });
    const runtime = tableService.get(created.body.table.tableId);

    for (const p of ids) {
      await runtime.register({ id: p.id, display_name: p.name, role: 'player' });
    }
    expect(runtime.entries.size).toBe(18);
    expect(runtime.prizePool()).toBe(18 * turbo.config.buy_in);

    await runtime.start();
    // Initial draw: 3 tables of 6 (fewest tables that fit the field).
    expect(tableCounts(runtime).sort()).toEqual([6, 6, 6]);

    // Event capture. Broadcasts happen at consistent points (after boundary
    // work), so (handForHand, live) pairs read off the emit stream are exact.
    const events = [];
    const hfhSamples = [];
    const emit = runtime.emit;
    runtime.emit = (type, payload) => {
      events.push({ type, payload });
      if (type === 'state') {
        hfhSamples.push({ hfh: runtime.handForHand, live: runtime.liveCount() });
      }
      emit(type, payload);
    };
    const paidPlaces = 4; // field 18 → 40/25/20/15
    let gapViolationStreak = 0;
    let maxGapViolationStreak = 0;

    await drive(runtime, {
      policy: targeted(runtime),
      timeoutMs: 150_000,
      each: (rt) => {
        const counts = tableCounts(rt);
        const anyRunning = [...rt.tables.values()].some((t) => t.engine.isHandRunning());

        // §4 invariant: whenever every table is between hands and no break/
        // redraw is pending, table sizes differ by at most 1. Boundary work
        // runs on promise chains — tolerate the microtask window, fail on a
        // persistent violation (a real balancing bug never clears).
        if (!anyRunning && counts.length > 1 && !rt._structureChangeDue()
            && Math.max(...counts) - Math.min(...counts) >= 2) {
          gapViolationStreak += 1;
          maxGapViolationStreak = Math.max(maxGapViolationStreak, gapViolationStreak);
        } else {
          gapViolationStreak = 0;
        }

        // Closed chip economy at every sample.
        const chips = [...rt.tables.values()].reduce((n, t) => n + t.engine.totalChips(), 0);
        expect(chips).toBe(18 * turbo.config.blind_ladder[0].bb * 50);
      },
    });

    expect(runtime.status).toBe('completed');
    expect(maxGapViolationStreak).toBeLessThan(20); // never a persistent ≥2 gap

    // Balancing and structure events all fired.
    const kinds = new Set(events.map((e) => e.type));
    expect(kinds.has('player_moved')).toBe(true);   // §4 auto-balance
    expect(kinds.has('table_break')).toBe(true);    // §4 breaking
    expect(kinds.has('final_table')).toBe(true);    // §4 final-table redraw
    expect(kinds.has('elimination')).toBe(true);
    expect(kinds.has('tournament_complete')).toBe(true);

    // §3 hand-for-hand: engaged exactly at bubble (live == paid+1), never
    // elsewhere; released once the bubble burst.
    for (const s of hfhSamples.filter((x) => x.hfh)) expect(s.live).toBe(paidPlaces + 1);
    expect(hfhSamples.some((s) => s.hfh)).toBe(true);
    const lastHfh = hfhSamples.map((s) => s.hfh).lastIndexOf(true);
    expect(hfhSamples.slice(lastHfh + 1).some((s) => !s.hfh && s.live <= paidPlaces)).toBe(true);

    // The clock ran: blinds escalated past level 1.
    expect(runtime.clock.level).toBeGreaterThan(1);

    // §5 payouts: exact standard split of the full pool, closed economy.
    const pool = 18 * turbo.config.buy_in;
    const entries = await repos.tournamentsRepo.listEntries(runtime.tournamentId);
    const payouts = entries.map((e) => Number(e.payout)).filter((p) => p > 0)
      .sort((a, b) => b - a);
    expect(payouts).toEqual([
      Math.floor(pool * 0.40), Math.floor(pool * 0.25),
      Math.floor(pool * 0.20), Math.floor(pool * 0.15),
    ]);
    expect(entries.reduce((n, e) => n + Number(e.payout), 0)).toBe(pool);

    // Finish positions are exactly 1..18.
    expect(entries.map((e) => e.finish_position).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 18 }, (_, i) => i + 1));

    // Bankrolls reconcile: nothing minted, nothing burned.
    let total = 0;
    for (const p of ids) total += await repos.bankrollRepo.getBalance(p.id);
    expect(total).toBe(18 * 100_000); // pool went out and came back, net zero

    // Export (§4.3): the session carries finish positions for all 18.
    const sessions = await request(app).get('/export/v1/sessions')
      .set('Authorization', `Bearer ${KEY}`);
    const ses = sessions.body.data.find((s) => s.table_mode === 'tournament');
    expect(ses.participants).toHaveLength(18);
    expect(new Set(ses.participants.map((p) => p.finish_position)).size).toBe(18);
  }, 180_000);

  it('survives a restart mid-tournament: clock, stacks and entries restore (RUNTIME §1)', async () => {
    const { app, repos, tableService, ids, coachToken, presets } = await fixture({ players: 12 });
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: presets[0].id, name: 'Restart Cup' });
    const tableId = created.body.table.tableId;
    const runtime = tableService.get(tableId);
    for (const p of ids) await runtime.register({ id: p.id, display_name: p.name, role: 'player' });
    await runtime.start();

    // Play until a third of the field is gone, then "crash".
    await drive(runtime, { until: (rt) => rt.liveCount() <= 8 });
    runtime.pause(true); // no new hands while we flush (index.js stops the process)
    await settle(runtime);
    await runtime._persist(true);
    const levelBefore = runtime.clock.level;
    const liveBefore = runtime.livePlayers()
      .map((s) => ({ playerId: s.playerId, stack: s.stack }))
      .sort((a, b) => a.playerId.localeCompare(b.playerId));
    const bustedBefore = [...runtime.eliminationOrder];
    runtime.stop();
    tableService.runtimes.clear();

    // Fresh service over the same database — the RUNTIME §1 boot path.
    const service2 = new TableService({
      repos: tableService.repos,
      timers: FAST,
      settingsProvider: tableService.settingsProvider,
    });
    expect(await service2.recover()).toBe(1);
    const revived = service2.get(tableId);
    expect(revived.mode).toBe('tournament');
    expect(revived.status).toBe('running');
    expect(revived.clock.level).toBe(levelBefore);
    expect(revived.entries.size).toBe(12);
    expect([...revived.eliminationOrder]).toEqual(bustedBefore);
    const liveAfter = revived.livePlayers()
      .map((s) => ({ playerId: s.playerId, stack: s.stack }))
      .sort((a, b) => a.playerId.localeCompare(b.playerId));
    expect(liveAfter).toEqual(liveBefore); // restart lost at most the in-flight hand

    // The revived tournament plays to completion; the economy still closes.
    await drive(revived);
    expect(revived.status).toBe('completed');
    const pool = 12 * presets[0].config.buy_in;
    const entries = await repos.tournamentsRepo.listEntries(revived.tournamentId);
    expect(entries.reduce((n, e) => n + Number(e.payout), 0)).toBe(pool);
    expect(entries.map((e) => e.finish_position).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  }, 180_000);

  it('late reg, re-entry and add-on move real money inside the windows (§1, §3)', async () => {
    const { app, repos, tableService, ids, coachToken } = await fixture({ players: 6 });
    const base = (await repos.tournamentPresetsRepo.list())[0].config;
    const preset = await repos.tournamentPresetsRepo.create({
      name: 'Windows', config: {
        ...base,
        late_reg_until_level: 4,
        reentry: { allowed: true, until_level: 4, max: 2 },
        addon: { allowed: true, at_break_after_level: 1, chips: 5000, cost: base.buy_in },
      },
    });
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: preset.id });
    const runtime = tableService.get(created.body.table.tableId);
    const buyIn = preset.config.buy_in;

    // 4 register now; the 5th arrives late; the 6th stays out.
    for (const p of ids.slice(0, 4)) {
      await runtime.register({ id: p.id, display_name: p.name, role: 'player' });
    }
    await runtime.start();

    // Late registration while running, level ≤ 4: full stack, seated at once.
    const late = ids[4];
    await runtime.register({ id: late.id, display_name: late.name, role: 'player' });
    expect(runtime.liveCount()).toBe(5);
    expect(await repos.bankrollRepo.getBalance(late.id)).toBe(100_000 - buyIn);
    const lateSeat = runtime._findSeat(late.id);
    expect(lateSeat.seat.stack)
      .toBe(preset.config.blind_ladder[0].bb * preset.config.starting_stack_bb);

    // Manufacture a bust inside the re-entry window: between hands, shrink
    // the shortest stack to one chip and play a hand — repeat until someone
    // actually busts (the blind eats them within a hand or two).
    const table = [...runtime.tables.values()][0];
    const started = Date.now();
    while (runtime.pendingReentry.size === 0 && runtime.status === 'running') {
      if (Date.now() - started > 60_000) throw new Error('no bust happened');
      await settle(runtime);
      if (runtime.pendingReentry.size > 0) break;
      const seats = table.engine.occupiedSeats();
      seats.reduce((a, b) => (a.stack < b.stack ? a : b)).stack = 1;
      const handNo = table.engine.handNo;
      await drive(runtime, {
        policy: checkCall,
        until: () => table.engine.handNo > handNo && !table.engine.isHandRunning(),
      });
      for (const t of runtime.tables.values()) await t.chain;
    }
    expect(runtime.status).toBe('running');
    const bustedId = [...runtime.pendingReentry][0];
    const balBefore = await repos.bankrollRepo.getBalance(bustedId);
    const entryBefore = runtime.entries.get(bustedId).entries;
    await runtime.reenter({ id: bustedId, display_name: 'again', role: 'player' });
    expect(await repos.bankrollRepo.getBalance(bustedId)).toBe(balBefore - buyIn);
    expect(runtime.entries.get(bustedId).entries).toBe(entryBefore + 1);
    expect(runtime._findSeat(bustedId)).toBeTruthy(); // fresh full stack, seated
    expect(runtime.eliminationOrder).not.toContain(bustedId);
    // The pool grew — the re-entry counts toward field size.
    expect(runtime.prizePool()).toBe(6 * buyIn);
    expect(runtime.fieldSize()).toBe(6);

    // Add-on at the break after level 1.
    runtime.pause(true);
    await settle(runtime);
    runtime.clock.onBreak = true;
    runtime.clock.breakMsRemaining = 60_000;
    runtime.clock.level = 2;
    const anyLive = runtime.livePlayers()[0];
    const balB4 = await repos.bankrollRepo.getBalance(anyLive.playerId);
    const stackB4 = runtime._findSeat(anyLive.playerId).seat.stack;
    await runtime.addon({ id: anyLive.playerId, display_name: anyLive.name, role: 'player' });
    expect(await repos.bankrollRepo.getBalance(anyLive.playerId)).toBe(balB4 - buyIn);
    expect(runtime._findSeat(anyLive.playerId).seat.stack).toBe(stackB4 + 5000);
    await expect(runtime.addon({ id: anyLive.playerId }))
      .rejects.toMatchObject({ code: 'addon_taken' });

    // Outside the window: plain register is refused; coach override admits (§6).
    runtime.clock.onBreak = false;
    runtime.clock.level = 9;
    const out = ids[5];
    await expect(runtime.register({ id: out.id, display_name: out.name, role: 'player' }))
      .rejects.toMatchObject({ code: 'registration_closed' });
    await runtime.register({ id: out.id, display_name: out.name, role: 'player' }, { override: true });
    expect(runtime.entries.has(out.id)).toBe(true);
    runtime.stop();
  }, 120_000);

  it('coach interventions: pause freezes the clock, level controls, manual eliminate, manual move, balance off (§6)', async () => {
    const { app, tableService, ids, coachToken, presets } = await fixture({ players: 12 });
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: presets[0].id });
    const runtime = tableService.get(created.body.table.tableId);
    for (const p of ids) await runtime.register({ id: p.id, display_name: p.name, role: 'player' });
    await runtime.start();
    expect(tableCounts(runtime).sort()).toEqual([6, 6]);

    // Pause: the level clock freezes.
    runtime.pause(true);
    const ms = runtime.clock.msRemaining;
    await sleep(60);
    expect(runtime.clock.msRemaining).toBe(ms);

    // Advance / extend level.
    const level = runtime.clock.level;
    runtime.advanceLevel();
    expect(runtime.clock.level).toBe(level + 1);
    const before = runtime.clock.msRemaining;
    runtime.extendLevel(5_000);
    expect(runtime.clock.msRemaining).toBe(before + 5_000);

    // Flush the in-flight first hands, then manual eliminations (no-shows).
    await settle(runtime);
    runtime.setAutoBalance(false); // pure manual mode (Jo's requirement)
    const victims = runtime.livePlayers().slice(0, 2);
    for (const v of victims) await runtime.coachEliminate(v.playerId);
    expect(runtime.liveCount()).toBe(10);
    for (const v of victims) expect(runtime.eliminationOrder).toContain(v.playerId);

    // With balancing off the coach makes it 6/4 by hand — and it stays 6/4.
    const [a, b] = [...runtime.tables.values()];
    const emptyAt = (tbl) => tbl.engine.seats.findIndex((s) => s === null);
    while (a.engine.occupiedSeats().length < 6) {
      runtime.coachMove(b.engine.occupiedSeats()[0].playerId, a.no, emptyAt(a));
    }
    let counts = tableCounts(runtime);
    expect(Math.max(...counts) - Math.min(...counts)).toBe(2);

    // §4: auto-balance back on resumes around whatever the coach did.
    runtime.setAutoBalance(true);
    counts = tableCounts(runtime);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);

    // Fast table switching (§9): the coach view follows setViewTable.
    runtime.setViewTable(b.no);
    expect(runtime.coachViewTable).toBe(b.no);
    expect(runtime.publicState('coach-viewer').viewingTableNo).toBe(b.no);
    expect(runtime.coachState().tables).toHaveLength(2);

    runtime.stop();
  }, 60_000);
});
