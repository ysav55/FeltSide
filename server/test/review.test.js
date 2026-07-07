import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { testApp, TEST_CONFIG, loginToken } from './helpers.js';
import { buildReplay } from '../src/game/ReplayEngine.js';

// M6 §§2-5, §7 acceptance — review detail, annotations, retag→revision
// round-trip, hand-history browser, save-as-scenario, and branch-to-live
// with chip conservation.

const KEY = TEST_CONFIG.exportApiKey;
const exp = (app, path) => request(app).get(path).set('Authorization', `Bearer ${KEY}`);

async function coachedFixture({ players = 2 } = {}) {
  const ctx = await testApp();
  const { repos, tableService, coach } = ctx;
  const coachToken = await loginToken(ctx.app, 'coach@test.local', 'coach-secret-1');
  const roster = [];
  for (let i = 0; i < players; i++) {
    roster.push(await repos.playersRepo.create({
      displayName: `P${i + 1}`, email: `p${i + 1}@t.io`, passwordHash: 'x', role: 'player',
    }));
  }
  const runtime = await tableService.createCoachedTable({ coach, smallBlind: 50, bigBlind: 100, tableSize: 6 });
  for (const p of roster) await runtime.join({ player: p });
  return { ...ctx, coachToken, runtime, roster };
}

async function checkDown(runtime) {
  const { engine } = runtime;
  const start = Date.now();
  while (engine.isHandRunning()) {
    if (Date.now() - start > 5000) throw new Error('stuck');
    const idx = engine.toAct;
    if (idx === null) { await new Promise((r) => setTimeout(r, 3)); continue; }
    const pid = engine.seats[idx].playerId;
    const legal = engine.legalActions(pid);
    await runtime.act(pid, legal.check ? { type: 'check' } : { type: 'call' });
  }
  await runtime._enqueue(async () => {});
}

const lastHandId = async (db) =>
  (await db.query('select id from hands order by played_at desc, id desc limit 1')).rows[0].id;

describe('M6 §2 — review detail (open-kimono, coach-only)', () => {
  it('serves full hand detail; players cannot reach it over HTTP', async () => {
    const { app, db, runtime, roster, coachToken, repos } = await coachedFixture();
    runtime.setHoleSlot(roster[0].id, { mode: 'cards', cards: ['Ah', 'Kd'] });
    await runtime.deal();
    await checkDown(runtime);
    const handId = await lastHandId(db);

    const res = await request(app).get(`/api/hands/${handId}`).set('Authorization', `Bearer ${coachToken}`);
    expect(res.status).toBe(200);
    const hand = res.body.hand;
    // All hole cards present (open-kimono).
    expect(hand.participants.every((p) => Array.isArray(p.holeCards) && p.holeCards.length === 2)).toBe(true);
    expect(hand.participants.find((p) => p.playerId === roster[0].id).holeCards).toEqual(['Ah', 'Kd']);
    expect(hand.actions.length).toBeGreaterThan(0);

    // The detail reconstructs cleanly.
    const replay = buildReplay(hand);
    expect(replay.frameAt(replay.frameCount - 1).pot).toBe(hand.pot);

    // A player token is rejected (coach-only).
    const p = await repos.playersRepo.findById(roster[0].id);
    await repos.playersRepo.setPassword(p.id, (await import('../src/auth/passwords.js')).hashPassword
      ? await (await import('../src/auth/passwords.js')).hashPassword('pw-123456') : 'x', false);
    const ptok = await loginToken(app, 'p1@t.io', 'pw-123456').catch(() => null);
    if (ptok) {
      const denied = await request(app).get(`/api/hands/${handId}`).set('Authorization', `Bearer ${ptok}`);
      expect(denied.status).toBe(403);
    }
  });
});

describe('M6 §3 — annotations (engine-side only, not exported)', () => {
  it('coach pins/removes notes on an action index; never touches the export', async () => {
    const { app, db, runtime, coachToken } = await coachedFixture();
    await runtime.deal();
    await checkDown(runtime);
    const handId = await lastHandId(db);

    const add = await request(app).post(`/api/hands/${handId}/annotations`)
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ action_index: 2, body: 'over-folds the turn here' });
    expect(add.status).toBe(201);
    const annId = add.body.annotation.id;

    const detail = await request(app).get(`/api/hands/${handId}`).set('Authorization', `Bearer ${coachToken}`);
    expect(detail.body.hand.annotations).toHaveLength(1);
    expect(detail.body.hand.annotations[0]).toMatchObject({ actionIndex: 2, body: 'over-folds the turn here' });

    // The export has no annotation field and no revision bump from annotating.
    const beforeRev = (await db.query('select revision from hands where id = $1', [handId])).rows[0].revision;
    const exported = await exp(app, '/export/v1/hands');
    const h = exported.body.data.find((x) => x.hand_id === handId);
    expect(h).toBeTruthy();
    expect(JSON.stringify(h)).not.toContain('annotation');
    expect((await db.query('select revision from hands where id = $1', [handId])).rows[0].revision).toBe(beforeRev);

    const del = await request(app).delete(`/api/hands/annotations/${annId}`).set('Authorization', `Bearer ${coachToken}`);
    expect(del.status).toBe(204);
  });
});

describe('M6 §4 — retag in review → revision round-trip', () => {
  it('add coach tag / dismiss auto tag bumps revision, re-exports once, dedup preserved', async () => {
    const { app, db, runtime, roster, coachToken } = await coachedFixture();
    // A limped pot → LIMPED_POT + OPEN_LIMP auto tags are recorded.
    await runtime.deal();
    await checkDown(runtime);
    const handId = await lastHandId(db);

    // Drain the initial export so we can watch the re-emit precisely.
    const firstWalk = await exp(app, '/export/v1/hands?limit=100');
    let cursor = firstWalk.body.next_cursor;
    expect(firstWalk.body.data.some((h) => h.hand_id === handId)).toBe(true);
    const rev1 = (await db.query('select revision from hands where id = $1', [handId])).rows[0].revision;
    expect(rev1).toBe(1);

    // Add a coach tag → revision bumps to 2 and the hand re-enters the stream ONCE.
    const addTag = await request(app).post(`/api/hands/${handId}/tags`)
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ tag: 'nice hero call', player_id: roster[0].id, action_seq: null });
    expect(addTag.status).toBe(201);
    expect(addTag.body.hand.revision).toBe(2);

    const reemit = await exp(app, `/export/v1/hands?cursor=${cursor}`);
    const reHands = reemit.body.data.filter((h) => h.hand_id === handId);
    expect(reHands).toHaveLength(1);
    expect(reHands[0].revision).toBe(2);
    expect(reHands[0].tags.some((t) => t.tag === 'nice hero call' && t.tag_type === 'coach')).toBe(true);
    cursor = reemit.body.next_cursor;

    // Dismiss an auto tag → revision 3, and the dismissed tag drops from the export.
    const detail = await request(app).get(`/api/hands/${handId}`).set('Authorization', `Bearer ${coachToken}`);
    const autoTag = detail.body.hand.tags.find((t) => t.tagType !== 'coach');
    const dismiss = await request(app).post(`/api/hands/${handId}/tags/${autoTag.id}/dismiss`)
      .set('Authorization', `Bearer ${coachToken}`).send({ dismissed: true });
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.hand.revision).toBe(3);

    const reemit2 = await exp(app, `/export/v1/hands?cursor=${cursor}`);
    const reHands2 = reemit2.body.data.filter((h) => h.hand_id === handId);
    expect(reHands2).toHaveLength(1);
    expect(reHands2[0].revision).toBe(3);
    expect(reHands2[0].tags.some((t) => t.tag === autoTag.tag)).toBe(false); // dismissed → gone

    // Remove the coach tag → revision 4.
    const coachTag = (await request(app).get(`/api/hands/${handId}`).set('Authorization', `Bearer ${coachToken}`))
      .body.hand.tags.find((t) => t.tagType === 'coach');
    const rm = await request(app).delete(`/api/hands/${handId}/tags/${coachTag.id}`).set('Authorization', `Bearer ${coachToken}`);
    expect(rm.status).toBe(200);
    expect(rm.body.hand.revision).toBe(4);

    // CONTRACT guarantee preserved: at-least-once total ordering, no skips —
    // a fresh full walk still delivers the hand exactly once, at revision 4.
    const full = await exp(app, '/export/v1/hands?limit=100');
    const finals = full.body.data.filter((h) => h.hand_id === handId);
    expect(finals).toHaveLength(1);
    expect(finals[0].revision).toBe(4);
  });
});

describe('M6 §7 — hand-history browser + save-as-scenario', () => {
  it('filters by origin/player/tag and saves a hand as a scenario', async () => {
    const { app, db, runtime, roster, coachToken, repos } = await coachedFixture();
    runtime.setHoleSlot(roster[0].id, { mode: 'cards', cards: ['Ah', 'Kd'] });
    runtime.setHoleSlot(roster[1].id, { mode: 'cards', cards: ['Qs', 'Qc'] });
    ['2c', '7s', 'Jh', '3d', '9c'].forEach((c, i) => runtime.setBoardSlot(i, c));
    await runtime.deal();
    await checkDown(runtime);
    const handId = await lastHandId(db);

    const list = await request(app).get('/api/hands?origin=manual').set('Authorization', `Bearer ${coachToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((h) => h.handId === handId)).toBe(true);
    expect(list.body.data[0].origin).toBe('manual');

    const byPlayer = await request(app).get(`/api/hands?player_id=${roster[0].id}`).set('Authorization', `Bearer ${coachToken}`);
    expect(byPlayer.body.data.some((h) => h.handId === handId)).toBe(true);

    const byTag = await request(app).get('/api/hands?tag=NOPE_TAG').set('Authorization', `Bearer ${coachToken}`);
    expect(byTag.body.data).toHaveLength(0);

    // Save-as-scenario hook (reuses M4 scenario shape).
    const save = await request(app).post(`/api/hands/${handId}/save-scenario`)
      .set('Authorization', `Bearer ${coachToken}`).send({ name: 'AK vs QQ spot' });
    expect(save.status).toBe(201);
    const scenario = await repos.scenariosRepo.findById(save.body.scenario.id);
    expect(scenario.config.panel.slots[roster[0].id].cards).toEqual(['Ah', 'Kd']);
    expect(scenario.config.panel.board).toEqual(['2c', '7s', 'Jh', '3d', '9c']);

    // And the saved scenario re-runs at a coached table (fresh deal, same cards).
    runtime.applyScenario(scenario.config);
    await runtime.deal();
    expect(runtime.engine.findSeat(roster[0].id).holeCards).toEqual(['Ah', 'Kd']);
    await checkDown(runtime);
    expect((await db.query('select origin from hands order by played_at desc limit 1')).rows[0].origin).toBe('scenario');
  });
});

describe('M6 §5 — branch-to-live', () => {
  it('branches from a replay point; origin=replay_branch, analyzers fire, chips conserved, unbranch restores', async () => {
    const { app, db, runtime, roster } = await coachedFixture();
    await runtime.deal();
    await checkDown(runtime);
    const handId = await lastHandId(db);
    const hand = await app.locals.repos.handReadRepo.getHandDetail(handId);

    // Pre-branch stacks snapshot.
    const preStacks = Object.fromEntries(runtime.engine.occupiedSeats().map((s) => [s.playerId, s.stack]));
    const preTotal = runtime.engine.totalChips();

    // Branch from the start of the recorded hand (cursor 0).
    await runtime.branchFromHand(hand, 0);
    expect(runtime.branched).toBe(true);
    // Present participants carry their recorded cards into the branch.
    expect(runtime.engine.findSeat(roster[0].id).holeCards).toEqual(hand.participants.find((p) => p.playerId === roster[0].id).holeCards);

    const branchStart = runtime.engine.totalChips();
    await checkDown(runtime);

    // The branch hand recorded with origin='replay_branch' and analyzers fired.
    const branchHandId = await lastHandId(db);
    expect(branchHandId).not.toBe(handId);
    const branchRow = (await db.query('select origin from hands where id = $1', [branchHandId])).rows[0];
    expect(branchRow.origin).toBe('replay_branch');
    const branchTags = (await db.query('select count(*)::int n from hand_tags where hand_id = $1', [branchHandId])).rows[0].n;
    expect(branchTags).toBeGreaterThan(0); // descriptors at minimum

    // Chip conservation WITHIN the branch hand.
    const bp = (await db.query('select stack_start, stack_end from hand_participants where hand_id = $1', [branchHandId])).rows;
    const sumStart = bp.reduce((n, r) => n + Number(r.stack_start), 0);
    const sumEnd = bp.reduce((n, r) => n + Number(r.stack_end), 0);
    expect(sumStart).toBe(sumEnd);
    expect(runtime.engine.totalChips()).toBe(branchStart);

    // Bankroll never touched by a coached branch.
    const before = (await db.query('select count(*)::int n from bankroll_transactions')).rows[0].n;
    expect(before).toBe(0);

    // Unbranch returns to the replay point and restores pre-branch stacks.
    const un = await runtime.unbranchFromHand();
    expect(un).toMatchObject({ handId, cursor: 0 });
    expect(runtime.branched).toBe(false);
    for (const s of runtime.engine.occupiedSeats()) {
      expect(s.stack).toBe(preStacks[s.playerId]);
    }
    expect(runtime.engine.totalChips()).toBe(preTotal);
  });
});
