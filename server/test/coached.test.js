import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { testApp, TEST_CONFIG, sleep, waitFor } from './helpers.js';
import { reconcileLessons } from '../src/sync/lessonSync.js';

// M4 acceptance A — coached mode: awaiting_deal E2E, origin matrix,
// server-side visibility, undo/rollback chip conservation,
// scenario → playlist → drill, lifecycle, live coach tagging.

const KEY = TEST_CONFIG.exportApiKey;
const authed = (app, path) => request(app).get(path).set('Authorization', `Bearer ${KEY}`);

async function coachedFixture({ players = 2, tableSize = 6 } = {}) {
  const ctx = await testApp();
  const { repos, tableService, coach } = ctx;
  const roster = [];
  for (let i = 0; i < players; i++) {
    roster.push(await repos.playersRepo.create({
      displayName: `P${i + 1}`, email: `p${i + 1}@t.io`, passwordHash: 'x', role: 'player',
    }));
  }
  const runtime = await tableService.createCoachedTable({
    coach, smallBlind: 50, bigBlind: 100, tableSize,
  });
  for (const p of roster) await runtime.join({ player: p });
  return { ...ctx, runtime, roster };
}

/** Check/call every decision until the hand completes (handles awaiting via cb). */
async function checkDown(runtime, { onAwaiting = null } = {}) {
  const { engine } = runtime;
  const started = Date.now();
  while (engine.isHandRunning()) {
    if (Date.now() - started > 5000) throw new Error('checkDown stuck');
    if (runtime.awaiting) {
      if (!onAwaiting) throw new Error('unexpected awaiting_deal');
      await onAwaiting();
      continue;
    }
    const idx = engine.toAct;
    if (idx === null) { await sleep(2); continue; }
    const pid = engine.seats[idx].playerId;
    const legal = engine.legalActions(pid);
    // Don't await: an act that closes a street onto a manual slot parks
    // until the coach provides — the loop keeps watching state instead.
    const p = runtime.act(pid, legal.check ? { type: 'check' } : { type: 'call' });
    p.catch(() => {});
    await Promise.race([p, waitFor(() => runtime.awaiting || engine.toAct !== idx || !engine.isHandRunning())]);
  }
  await runtime._enqueue(async () => {}); // recording barrier
}

const lastHand = async (db) =>
  (await db.query('select * from hands order by export_seq desc limit 1')).rows[0];

const clearPanel = (runtime, roster) => {
  for (const p of roster) runtime.setHoleSlot(p.id, null);
  for (let i = 0; i < 5; i++) runtime.setBoardSlot(i, null);
  for (const s of ['flop', 'turn', 'river']) runtime.setStreetPolicy(s, 'auto');
};

describe('DEALING §3 — street-by-street (awaiting_deal E2E)', () => {
  it('turn card chosen AFTER flop betting; players see a neutral wait', async () => {
    const { runtime, roster, db } = await coachedFixture();
    const [p1, p2] = roster;
    runtime.setStreetPolicy('turn', 'manual');
    await runtime.deal();

    // Preflop + flop betting play out normally.
    await checkDown(runtime, {
      onAwaiting: async () => {
        // The awaiting moment: flop is out, turn is the coach's call.
        expect(runtime.engine.board).toHaveLength(3);
        const view = runtime.publicState(p2.id);
        expect(view.awaitingDeal).toBe(true);
        // Neutral: nothing in the player view names cards or slots.
        expect(JSON.stringify(view)).not.toContain('panel');
        // Acting is rejected while the dealer acts; timers are moot (none).
        await expect(runtime.act(p1.id, { type: 'check' })).rejects.toThrow('awaiting_deal');
        await expect(runtime.undo()).rejects.toThrow('awaiting_deal');
        // Coach picks the turn NOW — after having seen the flop betting.
        runtime.setBoardSlot(3, 'Qs');
        await runtime.provideStreet(null);
        expect(runtime.engine.board[3]).toBe('Qs');
      },
    });

    expect((await lastHand(db)).board[3]).toBe('Qs');
  });

  it('the one-key RNG escape hatch releases a manual street', async () => {
    const { runtime } = await coachedFixture();
    runtime.setStreetPolicy('river', 'manual');
    await runtime.deal();
    await checkDown(runtime, {
      onAwaiting: async () => {
        expect(runtime.awaiting.street).toBe('river');
        await runtime.rngRest();
      },
    });
    expect(runtime.engine.isHandRunning()).toBe(false);
  });

  it('pre-staging: turn/river filled before the flop is dealt', async () => {
    const { runtime, db } = await coachedFixture();
    runtime.setBoardSlot(3, 'Qd');
    runtime.setBoardSlot(4, '2s');
    await runtime.deal();
    await checkDown(runtime); // never awaits — the cards were staged
    const hand = await lastHand(db);
    expect(hand.board[3]).toBe('Qd');
    expect(hand.board[4]).toBe('2s');
  });
});

describe('DEALING §1.4 — origin matrix (computed, never declared)', () => {
  it('rng / manual / hybrid / partial / range / scenario', async () => {
    const { runtime, roster, db } = await coachedFixture();
    const [p1, p2] = roster;

    // All untouched → rng.
    await runtime.deal();
    await checkDown(runtime);
    expect((await lastHand(db)).origin).toBe('rng');

    // Everything specified (both seats + full board) → manual.
    clearPanel(runtime, roster);
    runtime.setHoleSlot(p1.id, { mode: 'cards', cards: ['Ah', 'Kd'] });
    runtime.setHoleSlot(p2.id, { mode: 'cards', cards: ['Qs', 'Qc'] });
    ['2c', '7s', 'Jh', '3d', '9c'].forEach((c, i) => runtime.setBoardSlot(i, c));
    await runtime.deal();
    await checkDown(runtime);
    expect((await lastHand(db)).origin).toBe('manual');

    // One seat typed, one untouched → hybrid.
    clearPanel(runtime, roster);
    runtime.setHoleSlot(p1.id, { mode: 'cards', cards: ['Ah', 'Kd'] });
    await runtime.deal();
    await checkDown(runtime);
    expect((await lastHand(db)).origin).toBe('hybrid');

    // Half a seat typed → hybrid (a partially-specified slot).
    clearPanel(runtime, roster);
    runtime.setHoleSlot(p1.id, { mode: 'cards', cards: ['Ah', null] });
    runtime.setHoleSlot(p2.id, { mode: 'cards', cards: ['Qs', 'Qc'] });
    ['2c', '7s', 'Jh', '3d', '9c'].forEach((c, i) => runtime.setBoardSlot(i, c));
    await runtime.deal();
    await checkDown(runtime);
    expect((await lastHand(db)).origin).toBe('hybrid');

    // Range draw counts as specified; rest untouched → hybrid.
    clearPanel(runtime, roster);
    runtime.setHoleSlot(p1.id, { mode: 'range', range: 'AA,KK' });
    await runtime.deal();
    const drawn = runtime.engine.findSeat(p1.id).holeCards;
    expect(['A', 'K']).toContain(drawn[0][0]);
    expect(drawn[0][0]).toBe(drawn[1][0]); // a pair from the range
    await checkDown(runtime);
    expect((await lastHand(db)).origin).toBe('hybrid');

    // Loaded from a scenario → scenario, regardless of content.
    clearPanel(runtime, roster);
    runtime.applyScenario({ panel: { slots: {}, board: [null, null, null, null, null] } });
    await runtime.deal();
    await checkDown(runtime);
    expect((await lastHand(db)).origin).toBe('scenario');
  });
});

describe('PRD §3.1 — visibility (server-side, non-negotiable)', () => {
  it('players never see other hole cards; coach sees ONLY assigned/range draws', async () => {
    const { runtime, roster, coach } = await coachedFixture({ players: 3 });
    const [p1, p2, p3] = roster;
    runtime.setHoleSlot(p1.id, { mode: 'cards', cards: ['Ah', 'Kd'] });
    runtime.setHoleSlot(p2.id, { mode: 'range', range: 'QQ' });
    // p3 stays pure RNG.
    await runtime.deal();

    // A player payload NEVER contains another's hole cards.
    const p2View = runtime.publicState(p2.id);
    for (const seat of p2View.seats.filter(Boolean)) {
      if (seat.playerId !== p2.id) expect(seat.holeCards).toBeNull();
      else expect(seat.holeCards).toHaveLength(2);
    }
    expect(JSON.stringify(runtime.publicState(p3.id))).not.toContain('"Ah"');

    // Coach sidebar: assigned cards + the QQ range draw — never p3's RNG hand.
    const coachView = runtime.coachState();
    expect(coachView.assigned[p1.id]).toEqual(['Ah', 'Kd']);
    expect(coachView.assigned[p2.id].every((c) => c[0] === 'Q')).toBe(true);
    expect(coachView.assigned[p3.id]).toBeUndefined();
    const p3Cards = runtime.engine.findSeat(p3.id).holeCards;
    // Quoted match: card values are JSON strings (bare substrings can
    // coincide with uuid fragments).
    expect(JSON.stringify(coachView)).not.toContain(`"${p3Cards[0]}"`);
    expect(JSON.stringify(coachView)).not.toContain(`"${p3Cards[1]}"`);

    // Coach's shared-table view (observing, unseated): closed like anyone's.
    const coachPublic = runtime.publicState(coach.id);
    for (const seat of coachPublic.seats.filter(Boolean)) {
      expect(seat.holeCards).toBeNull();
    }
  });

  it('a half-typed seat reveals only the typed card to the coach', async () => {
    const { runtime, roster } = await coachedFixture();
    runtime.setHoleSlot(roster[0].id, { mode: 'cards', cards: ['Ah', null] });
    await runtime.deal();
    expect(runtime.coachState().assigned[roster[0].id]).toEqual(['Ah']);
  });
});

describe('M4 §7 — coach controls with chip conservation', () => {
  it('undo restores state, marks (never erases) actions, tags UNDO_USED', async () => {
    const { runtime, roster, db } = await coachedFixture();
    const { engine } = runtime;
    await runtime.deal();
    const total = engine.totalChips();
    const actor = engine.seats[engine.toAct].playerId;

    await runtime.act(actor, { type: 'raise', amount: 300 });
    expect(engine.totalChips()).toBe(total);
    await runtime.undo();
    expect(engine.totalChips()).toBe(total);
    expect(engine.toAct).toBe(engine.findSeat(actor).seatIndex);
    const undone = engine.actions.find((a) => a.action === 'raise');
    expect(undone.reverted).toBe(true); // marked, still in the log

    await checkDown(runtime);
    const hand = await lastHand(db);
    const { rows: acts } = await db.query(
      'select action, reverted from hand_actions where hand_id = $1 order by seq', [hand.id]
    );
    expect(acts.some((a) => a.action === 'raise' && a.reverted)).toBe(true);
    const { rows: tags } = await db.query(
      'select tag from hand_tags where hand_id = $1', [hand.id]
    );
    expect(tags.map((t) => t.tag)).toContain('UNDO_USED');
  });

  it('street rollback re-deals the street; bets on it are reverted; chips conserved', async () => {
    const { runtime, roster } = await coachedFixture();
    const { engine } = runtime;
    // Deterministic cards: typed holes + typed flop → every card is known.
    runtime.setHoleSlot(roster[0].id, { mode: 'cards', cards: ['Ah', 'Kd'] });
    runtime.setHoleSlot(roster[1].id, { mode: 'cards', cards: ['Qs', 'Qc'] });
    ['2h', '7d', 'Jc'].forEach((c, i) => runtime.setBoardSlot(i, c));
    await runtime.deal();
    const total = engine.totalChips();

    // Get through preflop to the flop.
    while (engine.phase === 'preflop') {
      const pid = engine.seats[engine.toAct].playerId;
      const legal = engine.legalActions(pid);
      await runtime.act(pid, legal.check ? { type: 'check' } : { type: 'call' });
    }
    const flopBefore = [...engine.board];
    expect(flopBefore).toEqual(['2h', '7d', 'Jc']);
    const bettor = engine.seats[engine.toAct].playerId;
    await runtime.act(bettor, { type: 'bet', amount: 400 });
    expect(engine.findSeat(bettor).betThisRound).toBe(400);

    // Force a DIFFERENT flop on the re-deal (cards known to be free).
    runtime.setBoardSlot(0, '3h');
    runtime.setBoardSlot(1, '8d');
    runtime.setBoardSlot(2, 'Tc');
    await runtime.rollbackStreet();

    expect(engine.totalChips()).toBe(total);
    expect(engine.findSeat(bettor).betThisRound).toBe(0);       // bet rolled back
    expect(engine.board).not.toEqual(flopBefore);               // street re-dealt
    expect(engine.board).toHaveLength(3);
    expect(engine.actions.some((a) => a.action === 'bet' && a.reverted)).toBe(true);
    expect(engine.undoUsed).toBe(true);

    await checkDown(runtime);
    expect(engine.totalChips()).toBe(total);
  });

  it('force street auto-checks a quiet round; refuses over unmatched bets', async () => {
    const { runtime } = await coachedFixture();
    const { engine } = runtime;
    await runtime.deal();
    // Preflop: get to the flop.
    while (engine.phase === 'preflop') {
      const pid = engine.seats[engine.toAct].playerId;
      const legal = engine.legalActions(pid);
      await runtime.act(pid, legal.check ? { type: 'check' } : { type: 'call' });
    }
    const total = engine.totalChips();
    await runtime.forceStreet(); // nobody bet — checks around
    expect(engine.phase).toBe('turn');
    expect(engine.totalChips()).toBe(total);

    const bettor = engine.seats[engine.toAct].playerId;
    await runtime.act(bettor, { type: 'bet', amount: 300 });
    await expect(runtime.forceStreet()).rejects.toThrow('bets_unmatched');
    expect(engine.totalChips()).toBe(total);
  });

  it('award pot ends the hand to the chosen player; stacks/blinds adjust between hands', async () => {
    const { runtime, roster, db } = await coachedFixture();
    const { engine } = runtime;
    await runtime.deal();
    const total = engine.totalChips();
    const [p1, p2] = roster;
    const actor = engine.seats[engine.toAct].playerId;
    await runtime.act(actor, { type: 'call', amount: 0 });
    await runtime.awardPot(p2.id);
    await runtime._enqueue(async () => {});
    expect(engine.isHandRunning()).toBe(false);
    expect(engine.totalChips()).toBe(total);
    expect((await lastHand(db)).id).toBeTruthy();

    // Between hands: stack + blind controls.
    await runtime.setStack(p1.id, 25_000);
    expect(engine.findSeat(p1.id).stack).toBe(25_000);
    await runtime.setBlinds(100, 200);
    expect(engine.config.bigBlind).toBe(200);
    await runtime.deal();
    await expect(runtime.setStack(p1.id, 1)).rejects.toThrow('hand_in_progress');
    await checkDown(runtime);
  });

  it('live coach tagging mid-hand lands on the recorded hand as tag_type coach', async () => {
    const { runtime, roster, db } = await coachedFixture();
    await runtime.deal();
    await runtime.coachTag({ tag: 'missed value on river', playerId: roster[0].id });
    await checkDown(runtime);
    const hand = await lastHand(db);
    const { rows } = await db.query(
      `select tag, tag_type, player_id from hand_tags where hand_id = $1 and tag_type = 'coach'`,
      [hand.id]
    );
    expect(rows).toEqual([
      { tag: 'missed value on river', tag_type: 'coach', player_id: roster[0].id },
    ]);
    // Post-hand tagging attaches to the last completed hand.
    await runtime.coachTag({ tag: 'review this one' });
    const { rows: after } = await db.query(
      `select count(*)::int as n from hand_tags where hand_id = $1 and tag_type = 'coach'`,
      [hand.id]
    );
    expect(after[0].n).toBe(2);
  });
});

describe('M4 §9 — scenarios, playlists, drills', () => {
  it('save-as-scenario → playlist → drill order with fresh range draws; §4.6 export real', async () => {
    const { app, runtime, roster, repos, coach, db } = await coachedFixture();
    const [p1] = roster;

    runtime.setHoleSlot(p1.id, { mode: 'range', range: 'AA,KK' });
    runtime.setStreetPolicy('river', 'rng');
    const s1 = await runtime.saveScenario({ name: 'Premium pair spot', createdBy: coach.id });
    runtime.setHoleSlot(p1.id, { mode: 'range', range: 'QQ' });
    const s2 = await runtime.saveScenario({ name: 'Queens drill', createdBy: coach.id });

    const playlist = await repos.playlistsRepo.create({
      name: '3-bet pots OOP', createdBy: coach.id, scenarioIds: [s1.id, s2.id],
    });

    const drill = await runtime.loadPlaylist(playlist.id);
    expect(drill.scenarios).toHaveLength(2);
    expect(runtime.panel.fromScenario).toBe(true);
    expect(runtime.panel.streetPolicy.river).toBe('rng'); // policy snapshotted

    // Drill 1 several times: every deal draws fresh from AA/KK.
    const seen = new Set();
    for (let i = 0; i < 4; i++) {
      await runtime.deal();
      const cards = runtime.engine.findSeat(p1.id).holeCards;
      expect(['A', 'K']).toContain(cards[0][0]);
      expect(cards[0][0]).toBe(cards[1][0]);
      seen.add(cards.join(''));
      await checkDown(runtime);
      expect((await lastHand(db)).origin).toBe('scenario');
    }

    // Next drill applies scenario 2.
    runtime.nextDrill();
    await runtime.deal();
    expect(runtime.engine.findSeat(p1.id).holeCards.every((c) => c[0] === 'Q')).toBe(true);
    await checkDown(runtime);

    // §4.6 playlists export is real now.
    const exp = await authed(app, '/export/v1/playlists');
    expect(exp.body.data).toHaveLength(1);
    expect(exp.body.data[0]).toMatchObject({
      playlist_id: playlist.id, name: '3-bet pots OOP', scenario_count: 2,
    });
    expect(new Date(exp.body.data[0].updated_at).toISOString()).toBe(exp.body.data[0].updated_at);
  });
});

describe('TAXONOMY §6 — settings are strictly non-retroactive', () => {
  it('a kill-switch change applies from the NEXT hand only', async () => {
    const { runtime, roster, repos, db } = await coachedFixture();
    // Every checked-down heads-up hand limps → OPEN_LIMP fires by default.
    await runtime.deal();
    // Mid-hand settings change: must NOT affect the hand in flight.
    await repos.settingsRepo.set('analyzer', { killSwitches: { OPEN_LIMP: false } });
    await checkDown(runtime);
    const first = await lastHand(db);
    const tagsOf = async (handId) =>
      (await db.query('select tag from hand_tags where hand_id = $1', [handId]))
        .rows.map((r) => r.tag);
    expect(await tagsOf(first.id)).toContain('OPEN_LIMP'); // snapshot from deal time

    await runtime.deal();
    await checkDown(runtime);
    const second = await lastHand(db);
    expect(second.id).not.toBe(first.id);
    expect(await tagsOf(second.id)).not.toContain('OPEN_LIMP'); // next hand: applied
    expect(await tagsOf(second.id)).toContain('LIMPED_POT');    // others untouched
  });
});

describe('M4 §1 — coached lifecycle from a lesson', () => {
  it('scheduled → open at lesson time → soft seat list → session exports with lesson + coach ids', async () => {
    const { app, db, repos, tableService, coach } = await testApp();
    const dana = await repos.playersRepo.create({
      displayName: 'Dana K', email: 'dana@t.io', passwordHash: 'x', role: 'player',
    });
    await repos.playersRepo.setCrmStudentId(dana.id, 'stu_01HZXLESSON0000000000000001');
    const ben = await repos.playersRepo.create({
      displayName: 'Ben R', email: 'ben@t.io', passwordHash: 'x', role: 'player',
    });

    await reconcileLessons({
      db, tablesRepo: repos.tablesRepo,
      entries: [{
        crmEntryId: 'evt_01HZXLESSONEVENT00000000001', type: 'lesson',
        title: 'River play', scheduledStart: new Date(Date.now() + 60_000).toISOString(),
        scheduledEnd: new Date(Date.now() + 3_660_000).toISOString(),
        studentCrmIds: ['stu_01HZXLESSON0000000000000001'], playlistId: null, presetId: null,
      }],
    });
    const [scheduled] = (await repos.tablesRepo.listByCrmEntry());
    expect(scheduled.status).toBe('scheduled');

    const runtime = await tableService.openScheduled(scheduled.id, coach);
    // Soft list: mapped student joins; unmapped player is guided away…
    await runtime.join({ player: dana });
    await expect(runtime.join({ player: ben })).rejects.toThrow('not_on_seat_list');
    // …the coach overrides from the table (soft, never blocking him).
    runtime.setOpenSeating(true);
    await runtime.join({ player: ben });
    // The coach can also seat himself.
    await runtime.join({ player: coach });

    await runtime.deal();
    await checkDown(runtime);
    await tableService.closeTable(scheduled.id, 'ended_by_coach');

    const res = await authed(app, '/export/v1/sessions');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].table_mode).toBe('coached_cash');
    expect(res.body.data[0].crm_entry_id).toBe('evt_01HZXLESSONEVENT00000000001');
    expect(res.body.data[0].coach_player_id).toBe(coach.id);
  });
});
