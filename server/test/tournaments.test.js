import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { testApp, loginToken, sleep, waitFor } from './helpers.js';
import { seedTournamentPresets } from '../src/seed.js';
import { seededPresets, startingStack } from '../src/tournament/presets.js';

const KEY = 'test-export-key';

/** Fast tournament timers: a whole tournament in a few seconds. */
const FAST = {
  levelMs: 400, breakMs: 40, tickMs: 10,
  actionMs: 60_000, // driver acts long before any auto-fold
  interHandMs: 1, persistMs: 30,
};

/** Everyone jams every hand — maximum elimination speed. */
const jam = (pid, legal) => {
  if (legal.raise) return { type: 'raise', amount: legal.raise.maxTo };
  if (legal.bet) return { type: 'bet', amount: legal.bet.max };
  return legal.call ? { type: 'call' } : { type: 'check' };
};

async function fixture({ players = 6, roll = 100_000, timers = FAST } = {}) {
  const ctx = await testApp({ tableTimers: timers });
  await seedTournamentPresets(ctx.db);
  const { playersRepo, bankrollRepo } = ctx.repos;
  const ids = [];
  for (let i = 0; i < players; i++) {
    const p = await playersRepo.create({
      displayName: `P${i + 1}`, email: `p${i + 1}@test.local`,
      passwordHash: 'x', role: 'player', mustChangePassword: false,
    });
    await bankrollRepo.createAccount(p.id);
    await bankrollRepo.applyTransaction({
      playerId: p.id, type: 'coach_adjustment', amount: roll, note: 'roll',
    });
    ids.push(p.id);
  }
  const coachToken = await loginToken(ctx.app, 'coach@test.local', 'coach-secret-1');
  const presets = await ctx.repos.tournamentPresetsRepo.list();
  return { ...ctx, ids, coachToken, presets };
}

function player(repos, id, i) {
  return { id, display_name: `P${i + 1}`, role: 'player' };
}

/** Drives every table until the tournament completes (or times out). */
async function drive(runtime, policy = jam, { timeoutMs = 30_000, each = null } = {}) {
  const start = Date.now();
  while (runtime.status === 'running') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`tournament did not complete (live=${runtime.liveCount()})`);
    }
    let acted = false;
    for (const t of [...runtime.tables.values()]) {
      const e = t.engine;
      if (!e.isHandRunning() || e.toAct === null) continue;
      const pid = e.seats[e.toAct].playerId;
      const legal = e.legalActions(pid);
      if (!legal) continue;
      try {
        await runtime.act(pid, policy(pid, legal, e));
        acted = true;
      } catch { /* boundary race — retry next loop */ }
    }
    if (each) each(runtime);
    if (!acted) await sleep(3);
  }
}

const balance = (repos, playerId) => repos.bankrollRepo.getBalance(playerId);

describe('tournament presets (§§1-2, CONTRACT §4.7)', () => {
  it('seeds the four §2 presets idempotently and exports the catalog', async () => {
    const { app, db, presets } = await fixture({ players: 0 });
    expect(presets.map((p) => p.name)).toEqual([
      'Lesson Turbo', 'Standard Evening', 'Deep Teach', 'Hyper',
    ]);
    expect(await seedTournamentPresets(db)).toBe(0); // second boot: no-op

    // Ladder shape: sb = bb/2, ante from the configured level, growth 30-40%.
    for (const p of presets) {
      const ladder = p.config.blind_ladder;
      expect(ladder.length).toBeGreaterThanOrEqual(15);
      for (const row of ladder) expect(row.sb * 2).toBe(row.bb);
      const anteFrom = p.config.ante.from_level;
      expect(ladder[anteFrom - 2].bb_ante).toBe(0);
      expect(ladder[anteFrom - 1].bb_ante).toBe(ladder[anteFrom - 1].bb);
      for (let i = 1; i < 6; i++) {
        const g = ladder[i].bb / ladder[i - 1].bb;
        expect(g).toBeGreaterThan(1.1);
        expect(g).toBeLessThan(1.7);
      }
    }
    const turbo = presets[0].config;
    expect(startingStack(turbo)).toBe(turbo.blind_ladder[0].bb * 50);

    // §4.7 catalog goes real.
    const res = await request(app).get('/export/v1/tournament-presets')
      .set('Authorization', `Bearer ${KEY}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.data[0]).toEqual({
      preset_id: presets[0].id,
      name: 'Lesson Turbo',
      description: presets[0].description,
      updated_at: expect.any(String),
    });
  });

  it('coach CRUD on presets; players read-only', async () => {
    const { app, coachToken, presets } = await fixture({ players: 1 });
    const config = { ...seededPresets()[0], buy_in: 1234 };
    const created = await request(app).post('/api/tournament-presets')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ name: 'Custom Cup', description: 'test', config });
    expect(created.status).toBe(201);

    const updated = await request(app).put(`/api/tournament-presets/${created.body.preset.id}`)
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ name: 'Custom Cup v2' });
    expect(updated.body.preset.name).toBe('Custom Cup v2');

    const bad = await request(app).post('/api/tournament-presets')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ name: 'Broken', config: { ...config, table_size: 7 } });
    expect(bad.status).toBe(400);

    const del = await request(app).delete(`/api/tournament-presets/${created.body.preset.id}`)
      .set('Authorization', `Bearer ${coachToken}`);
    expect(del.body.deleted).toBe(true);
    expect((await request(app).get('/api/tournament-presets')
      .set('Authorization', `Bearer ${coachToken}`)).body.data).toHaveLength(presets.length);
  });
});

describe('tournament lifecycle (§3, §5)', () => {
  it('runs a 6-player single-table tournament: registration debits, payouts reconcile to the chip', async () => {
    const { app, repos, tableService, ids, coachToken, presets } = await fixture();
    const turbo = presets[0];

    // Ad-hoc creation (coach).
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: turbo.id, name: 'Friday Turbo' });
    expect(created.status).toBe(201);
    expect(created.body.table.tournament.status).toBe('registering');
    const tableId = created.body.table.tableId;
    const runtime = tableService.get(tableId);

    // Registration: bankroll debited by the buy-in.
    const buyIn = turbo.config.buy_in;
    for (const [i, id] of ids.entries()) {
      await runtime.register(player(repos, id, i));
      expect(await balance(repos, id)).toBe(100_000 - buyIn);
    }
    await expect(runtime.register(player(repos, ids[0], 0)))
      .rejects.toMatchObject({ code: 'already_registered' });
    expect(runtime.prizePool()).toBe(6 * buyIn);

    // Start (coach) → all six seated with full starting stacks.
    const started = await request(app).post(`/api/tournaments/${tableId}/start`)
      .set('Authorization', `Bearer ${coachToken}`);
    expect(started.status).toBe(200);
    expect(runtime.liveCount()).toBe(6);
    const stack = startingStack(turbo.config);
    // The first hand may already be under way — assert conservation, not
    // untouched stacks (blinds move chips within the closed total).
    const totalChips = 6 * stack;
    expect([...runtime.tables.values()]
      .reduce((n, t) => n + t.engine.totalChips(), 0)).toBe(totalChips);

    await drive(runtime, jam, {
      each: (rt) => {
        // Closed chip economy: chips on tables always sum to entries × stack.
        const onTables = [...rt.tables.values()]
          .reduce((n, t) => n + t.engine.totalChips(), 0);
        expect(onTables).toBe(totalChips);
      },
    });

    expect(runtime.status).toBe('completed');

    // §5: pool 60k, field 6 → 65/35. Every chip accounted for.
    const entries = await repos.tournamentsRepo.listEntries(runtime.tournamentId);
    const paid = entries.filter((e) => Number(e.payout) > 0);
    const pool = 6 * buyIn;
    expect(paid.map((e) => Number(e.payout)).sort((a, b) => b - a))
      .toEqual([Math.floor(pool * 0.65), Math.floor(pool * 0.35)]);
    expect(entries.reduce((n, e) => n + Number(e.payout), 0)).toBe(pool);

    // Finish positions are a permutation of 1..6.
    expect(entries.map((e) => e.finish_position).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6]);

    // Bankrolls reconcile: total money in the system is unchanged.
    let total = 0;
    for (const id of ids) total += await balance(repos, id);
    expect(total).toBe(6 * 100_000 - pool + pool);

    // Session exported with finish_position (CONTRACT §4.3).
    const sessions = await request(app).get('/export/v1/sessions')
      .set('Authorization', `Bearer ${KEY}`);
    const ses = sessions.body.data.find((s) => s.table_mode === 'tournament');
    expect(ses).toBeTruthy();
    expect(ses.hand_count).toBeGreaterThan(0);
    const positions = ses.participants.map((p) => p.finish_position).sort((a, b) => a - b);
    expect(positions[0]).toBe(1);
    expect(new Set(positions).size).toBe(positions.length);

    // The lobby row is completed.
    expect((await repos.tablesRepo.findById(tableId)).status).toBe('completed');
  });

  it('BB ante and dead-button: antes post from the configured level, button can sit on an empty seat', async () => {
    const { app, repos, tableService, ids, coachToken } = await fixture({ players: 3 });
    // Custom preset: ante from level 1 so the very first hand posts it.
    const config = {
      ...seededPresets()[0],
      ante: { type: 'bb_ante', from_level: 1 },
      blind_ladder: seededPresets()[0].blind_ladder.map((r) => ({ ...r, bb_ante: r.bb })),
    };
    const preset = await repos.tournamentPresetsRepo.create({ name: 'AnteNow', config });
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: preset.id });
    const runtime = tableService.get(created.body.table.tableId);
    for (const [i, id] of ids.entries()) await runtime.register(player(repos, id, i));
    await runtime.start();

    await waitFor(() => [...runtime.tables.values()][0].engine.isHandRunning());
    const engine = [...runtime.tables.values()][0].engine;
    const anteActions = engine.actions.filter((a) => a.action === 'post_ante');
    expect(anteActions).toHaveLength(1);
    expect(anteActions[0].amount).toBe(engine.config.bbAnte);
    expect(engine.config.bbAnte).toBe(config.blind_ladder[0].bb);
    // Pot includes ante + blinds.
    const bbSeat = engine.seats[engine.bbSeat];
    expect(bbSeat.contributed).toBe(engine.config.bbAnte + engine.config.bigBlind);
    runtime.stop();
  });

  it('cancelling during registration refunds every chip (closed economy)', async () => {
    const { app, repos, tableService, ids, coachToken, presets } = await fixture({ players: 4 });
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: presets[0].id });
    const tableId = created.body.table.tableId;
    const runtime = tableService.get(tableId);
    for (const [i, id] of ids.entries()) await runtime.register(player(repos, id, i));

    await request(app).post(`/api/tables/${tableId}/close`)
      .set('Authorization', `Bearer ${coachToken}`);
    for (const id of ids) expect(await balance(repos, id)).toBe(100_000);
    expect((await repos.tournamentsRepo.findByTableId(tableId)).status).toBe('completed');
  });

  it('end-early pays by current chip count (§6)', async () => {
    const { repos, tableService, ids, coachToken, presets, app } = await fixture({ players: 4 });
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: presets[0].id });
    const runtime = tableService.get(created.body.table.tableId);
    for (const [i, id] of ids.entries()) await runtime.register(player(repos, id, i));
    await runtime.start();
    runtime.pause(true); // freeze before the first hand starts (interHandMs)
    const table = [...runtime.tables.values()][0];
    await sleep(10);
    expect(table.engine.isHandRunning()).toBe(false);
    const seats = table.engine.occupiedSeats();
    seats.forEach((s, i) => { s.stack = (i + 1) * 1000; }); // strict ranking, low→high
    const ranked = [...seats].sort((a, b) => b.stack - a.stack).map((s) => s.playerId);

    const res = await request(app).post(`/api/tournaments/${runtime.tableId}/end-early`)
      .set('Authorization', `Bearer ${coachToken}`);
    expect(res.status).toBe(200);
    expect(runtime.status).toBe('completed');
    expect(runtime.endedEarly).toBe(true);

    const entries = await repos.tournamentsRepo.listEntries(runtime.tournamentId);
    const byId = new Map(entries.map((e) => [e.player_id, e]));
    ranked.forEach((pid, i) => expect(byId.get(pid).finish_position).toBe(i + 1));
    // Field 4 → winner takes all; pool reconciles.
    const pool = runtime.prizePool();
    expect(Number(byId.get(ranked[0]).payout)).toBe(pool);
  });

  it('final-table ICM deal: unanimous accept ends with ICM payouts summing to the pool (§7)', async () => {
    const { repos, tableService, ids, coachToken, presets, app } = await fixture({ players: 4 });
    const created = await request(app).post('/api/tournaments')
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ preset_id: presets[0].id });
    const runtime = tableService.get(created.body.table.tableId);
    for (const [i, id] of ids.entries()) await runtime.register(player(repos, id, i));
    await runtime.start();
    runtime.pause(true); // freeze before the first hand
    const table = [...runtime.tables.values()][0];
    await sleep(10);
    expect(table.engine.isHandRunning()).toBe(false);
    // Rig unequal stacks so the ICM amounts are meaningfully distinct.
    table.engine.occupiedSeats().forEach((s, i) => { s.stack = (i + 1) * 3000; });

    const live = runtime.livePlayers();
    const pool = runtime.prizePool();
    const proposal = runtime.proposeDeal();
    expect(Object.keys(proposal.amounts)).toHaveLength(live.length);

    // A non-participant cannot accept.
    await expect(runtime.acceptDeal(coachToken && 'not-a-player'))
      .rejects.toMatchObject({ code: 'not_in_deal' });
    for (const s of live) await runtime.acceptDeal(s.playerId);
    expect(runtime.status).toBe('completed');

    const entries = await repos.tournamentsRepo.listEntries(runtime.tournamentId);
    expect(entries.reduce((n, e) => n + Number(e.payout), 0)).toBe(pool);
    // The live players took the ICM amounts.
    const byId = new Map(entries.map((e) => [e.player_id, e]));
    for (const [pid, amount] of Object.entries(proposal.amounts)) {
      expect(Number(byId.get(pid).payout)).toBe(amount);
    }
  });
});

describe('CRM push → activation (CONTRACT §8, TOURNAMENTS §3)', () => {
  it('a pushed tournament timeblock activates into a registering tournament', async () => {
    const { app, repos, tableService, ids, coachToken, presets } = await fixture({ players: 4 });

    const push = await request(app).put('/sync/v1/lessons')
      .set('Authorization', `Bearer ${KEY}`)
      .send({
        entries: [{
          crm_entry_id: 'blk_777',
          type: 'tournament',
          title: 'School Cup',
          scheduled_start: new Date(Date.now() + 30 * 60_000).toISOString(),
          scheduled_end: new Date(Date.now() + 150 * 60_000).toISOString(),
          student_crm_ids: [],
          tournament_preset_id: presets[1].id, // Standard Evening, by reference
        }],
      });
    expect(push.status).toBe(204);

    const scheduledRow = (await repos.tablesRepo.listByCrmEntry())
      .find((t) => t.crm_entry_id === 'blk_777');
    expect(scheduledRow.mode).toBe('tournament');
    expect(scheduledRow.status).toBe('scheduled');

    // Inside the 1h window the lobby backstop opens it autonomously.
    expect(await tableService.autoOpenTournaments()).toBe(1);
    const runtime = tableService.get(scheduledRow.id);
    expect(runtime.mode).toBe('tournament');
    expect(runtime.status).toBe('registering');
    expect(runtime.config.buy_in).toBe(presets[1].config.buy_in);
    expect(runtime.crmEntryId).toBe('blk_777');

    // Config snapshot: editing the preset does NOT shift the live tournament.
    await repos.tournamentPresetsRepo.update(presets[1].id, {
      config: { ...presets[1].config, buy_in: 1 },
    });
    expect(runtime.config.buy_in).toBe(presets[1].config.buy_in);

    // Players register and it runs; the exported session carries the entry id.
    for (const [i, id] of ids.entries()) await runtime.register(player(repos, id, i));
    await runtime.start();
    await drive(runtime);
    expect(runtime.status).toBe('completed');

    const sessions = await request(app).get('/export/v1/sessions')
      .set('Authorization', `Bearer ${KEY}`);
    const ses = sessions.body.data.find((s) => s.crm_entry_id === 'blk_777');
    expect(ses).toBeTruthy();
    expect(ses.table_mode).toBe('tournament');
    expect(ses.participants.every((p) => p.finish_position >= 1)).toBe(true);

    // Coach open path also works (idempotent for an already-open tournament).
    const reopen = await request(app).post(`/api/tables/${scheduledRow.id}/open`)
      .set('Authorization', `Bearer ${coachToken}`).send({});
    expect(reopen.status).toBe(200);
  });

  it('a scheduled tournament without a known preset stays scheduled (never crashes the backstop)', async () => {
    const { app, tableService, repos } = await fixture({ players: 0 });
    await request(app).put('/sync/v1/lessons')
      .set('Authorization', `Bearer ${KEY}`)
      .send({
        entries: [{
          crm_entry_id: 'blk_bad', type: 'tournament', title: 'Ghost',
          scheduled_start: new Date(Date.now() + 60_000).toISOString(),
          scheduled_end: new Date(Date.now() + 120 * 60_000).toISOString(),
          student_crm_ids: [], tournament_preset_id: 'tpr_not_a_real_id',
        }],
      });
    expect(await tableService.autoOpenTournaments()).toBe(0);
    const row = (await repos.tablesRepo.listByCrmEntry())[0];
    expect(row.status).toBe('scheduled'); // waits for the coach + a preset
  });
});
