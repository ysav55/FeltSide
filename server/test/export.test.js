import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
  testApp, TEST_CONFIG, loginToken, createPlayer, driveHand, strategies,
} from './helpers.js';
import { createApp } from '../src/app.js';
import { scriptedCardSourceFactory } from '../src/game/cardSource.js';
import { TAG_VOCABULARY, TAG_VOCABULARY_VERSION } from '../src/export/vocabulary.js';

// M3 acceptance #1 — contract-compliance suite. Every shape is asserted
// literally against CONTRACT.md; cursor tests prove total order, no-skip
// across restarts, at-least-once on overlap, and invalid_cursor behavior.

const KEY = TEST_CONFIG.exportApiKey;
const authed = (app, path) =>
  request(app).get(path).set('Authorization', `Bearer ${KEY}`);

const ROYAL_BOARD = { board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] }; // board plays → splits

const STU_DANA = 'stu_01HZXW5T9GXKQ4YB2M8RDANA01';

/** 2 linked-ish players, one table, `hands` completed hands, table closed. */
async function playedFixture({ hands = 3, close = true } = {}) {
  const script = [];
  for (let i = 0; i < hands + 8; i++) script.push(ROYAL_BOARD);
  const ctx = await testApp({
    tableTimers: {
      interHandMs: 10, actionMs: 60_000,
      disconnectGraceMs: 60_000, retentionMs: 60_000, idleCloseMs: 60_000,
    },
    cardSourceFactory: scriptedCardSourceFactory(script),
  });
  const { app, tableService } = ctx;
  const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');

  const players = {};
  for (const [name, email] of [['Dana K', 'dana@t.io'], ['Ben R', 'ben@t.io']]) {
    const created = await createPlayer(app, coachToken, {
      displayName: name, email, initialPassword: 'initial-pass-1',
    });
    const id = created.body.player.id;
    players[name] = { id };
    const login = await request(app).post('/api/auth/login')
      .send({ email, password: 'initial-pass-1' });
    await request(app).post('/api/auth/change-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ current_password: 'initial-pass-1', new_password: 'passw0rd-x' });
    players[name].token = login.body.token;
    await request(app).post(`/api/bankroll/${id}/adjust`)
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ delta: 100_000, note: 'test roll' });
  }
  // Dana is CRM-linked; Ben is not.
  await request(app).put(`/api/players/${players['Dana K'].id}/crm-student-id`)
    .set('Authorization', `Bearer ${coachToken}`)
    .send({ crm_student_id: STU_DANA });

  const created = await request(app).post('/api/tables')
    .set('Authorization', `Bearer ${players['Dana K'].token}`)
    .send({ small_blind: 50, big_blind: 100, table_size: 6, name: 'Export fixture' });
  const tableId = created.body.table.tableId;
  for (const name of ['Dana K', 'Ben R']) {
    await request(app).post(`/api/tables/${tableId}/join`)
      .set('Authorization', `Bearer ${players[name].token}`)
      .send({ buy_in: 10_000 });
  }
  const runtime = tableService.get(tableId);
  for (let i = 0; i < hands; i++) await driveHand(runtime, strategies.checkDown);
  if (close) await tableService.closeTable(tableId, 'test');
  return { ...ctx, coachToken, players, tableId };
}

/** Walk a cursored endpoint to exhaustion; returns { records, cursors }. */
async function walk(app, path, { limit = 100, from = undefined } = {}) {
  const records = [];
  const cursors = [];
  let cursor = from;
  for (;;) {
    const url = `${path}?limit=${limit}` + (cursor ? `&cursor=${cursor}` : '');
    const res = await authed(app, url);
    expect(res.status).toBe(200);
    records.push(...res.body.data);
    if (res.body.next_cursor !== null) {
      cursors.push(res.body.next_cursor);
      cursor = res.body.next_cursor;
    }
    if (!res.body.has_more || res.body.next_cursor === null) break;
  }
  return { records, cursors, cursor };
}

describe('CONTRACT §2 — auth', () => {
  it('401 invalid_api_key on every endpoint without / with a wrong key', async () => {
    const { app } = await testApp();
    const gets = [
      '/export/v1/meta', '/export/v1/players', '/export/v1/sessions',
      '/export/v1/hands', '/export/v1/playlists', '/export/v1/tournament-presets',
    ];
    for (const path of gets) {
      const bare = await request(app).get(path);
      expect(bare.status).toBe(401);
      expect(bare.body).toEqual({ code: 'invalid_api_key' });
      const wrong = await request(app).get(path).set('Authorization', 'Bearer nope');
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({ code: 'invalid_api_key' });
    }
    const put = await request(app).put('/sync/v1/lessons').send({ entries: [] });
    expect(put.status).toBe(401);
    expect(put.body).toEqual({ code: 'invalid_api_key' });
  });
});

describe('CONTRACT §4.1 — meta', () => {
  it('serves versions and the full TAXONOMY vocabulary', async () => {
    const { app } = await testApp();
    const res = await authed(app, '/export/v1/meta');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['contract_version', 'engine_version', 'tag_vocabulary_version', 'tags']
    );
    expect(res.body.contract_version).toBe(1);
    expect(res.body.tag_vocabulary_version).toBe(TAG_VOCABULARY_VERSION);
    expect(typeof res.body.engine_version).toBe('string');
    expect(res.body.tags).toEqual(TAG_VOCABULARY);
    // Spot-check the vocabulary itself: both classes present, no others.
    const types = new Set(res.body.tags.map((t) => t.tag_type));
    expect(types).toEqual(new Set(['descriptor', 'mistake']));
    expect(res.body.tags.find((t) => t.tag === 'OPEN_LIMP').tag_type).toBe('mistake');
    expect(res.body.tags.find((t) => t.tag === 'CBET_FLOP').tag_type).toBe('descriptor');
    expect(res.body.tags.every((t) => typeof t.description === 'string')).toBe(true);
  });
});

describe('CONTRACT §4.2 — players', () => {
  it('full snapshot: linked + unlinked player accounts, coach excluded', async () => {
    const { app, players, coach } = await playedFixture({ hands: 1 });
    const res = await authed(app, '/export/v1/players');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    for (const p of res.body.data) {
      expect(Object.keys(p).sort()).toEqual(
        ['created_at', 'crm_student_id', 'display_name', 'player_id', 'status']
      );
      expect(p.status).toBe('active');
      expect(new Date(p.created_at).toISOString()).toBe(p.created_at);
    }
    const dana = res.body.data.find((p) => p.player_id === players['Dana K'].id);
    const ben = res.body.data.find((p) => p.player_id === players['Ben R'].id);
    expect(dana.crm_student_id).toBe(STU_DANA);
    expect(ben.crm_student_id).toBeNull();
    expect(res.body.data.some((p) => p.player_id === coach.id)).toBe(false);
  });
});

describe('CONTRACT §4.3 — sessions', () => {
  it('exports completed sessions only, with per-participant aggregates', async () => {
    const { app, tableService, tableId, players } =
      await playedFixture({ hands: 3, close: false });

    // Session still open → nothing exports.
    const before = await authed(app, '/export/v1/sessions');
    expect(before.body).toEqual({ data: [], next_cursor: null, has_more: false });

    await tableService.closeTable(tableId, 'test');
    const res = await authed(app, '/export/v1/sessions');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const s = res.body.data[0];
    expect(Object.keys(s).sort()).toEqual([
      'coach_player_id', 'crm_entry_id', 'ended_at', 'hand_count',
      'participants', 'session_id', 'started_at', 'table_mode',
    ]);
    expect(s.table_mode).toBe('uncoached_cash');
    expect(s.crm_entry_id).toBeNull();
    expect(s.coach_player_id).toBeNull();
    expect(s.hand_count).toBe(3);
    expect(new Date(s.started_at).toISOString()).toBe(s.started_at);
    expect(new Date(s.ended_at).toISOString()).toBe(s.ended_at);
    expect(s.participants).toHaveLength(2);
    for (const p of s.participants) {
      expect(Object.keys(p).sort()).toEqual([
        'crm_student_id', 'finish_position', 'hands_played', 'net_chips', 'player_id',
      ]);
      expect(p.hands_played).toBe(3);
      expect(typeof p.net_chips).toBe('number');
      expect(p.finish_position).toBeNull();
    }
    // Split boards + blinds cancel out: chips are conserved across the table.
    expect(s.participants.reduce((sum, p) => sum + p.net_chips, 0)).toBe(0);
    const dana = s.participants.find((p) => p.player_id === players['Dana K'].id);
    expect(dana.crm_student_id).toBe(STU_DANA);
  });
});

describe('CONTRACT §4.4 — hands', () => {
  it('exports the exact hand payload: booleans, actions, review_url, tags []', async () => {
    const { app, players } = await playedFixture({ hands: 2 });
    const res = await authed(app, '/export/v1/hands');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    for (const h of res.body.data) {
      expect(Object.keys(h).sort()).toEqual([
        'actions', 'board', 'hand_id', 'origin', 'participants', 'played_at',
        'pot', 'review_url', 'revision', 'session_id', 'table_mode', 'tags',
      ]);
      expect(h.table_mode).toBe('uncoached_cash');
      expect(h.origin).toBe('rng');
      expect(h.revision).toBe(1);
      expect(h.review_url).toBe(`https://engine.test/review/${h.hand_id}`);
      expect(h.board).toHaveLength(5);
      expect(typeof h.pot).toBe('number');
      expect(h.tags).toEqual([]);
      expect(new Date(h.played_at).toISOString()).toBe(h.played_at);

      expect(h.participants).toHaveLength(2);
      for (const p of h.participants) {
        expect(Object.keys(p).sort()).toEqual([
          'cbet', 'cbet_opp', 'crm_student_id', 'hole_cards', 'is_winner',
          'pfr', 'player_id', 'position', 'saw_flop', 'stack_end',
          'stack_start', 'three_bet', 'three_bet_opp', 'vpip', 'wsd', 'wtsd',
        ]);
        expect(['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO']).toContain(p.position);
        expect(Array.isArray(p.hole_cards)).toBe(true);
        expect(p.hole_cards).toHaveLength(2);
        for (const key of ['vpip', 'pfr', 'three_bet_opp', 'three_bet',
          'saw_flop', 'cbet_opp', 'cbet', 'wtsd', 'wsd', 'is_winner']) {
          expect(typeof p[key]).toBe('boolean');
        }
        expect(typeof p.stack_start).toBe('number');
        expect(typeof p.stack_end).toBe('number');
      }
      const dana = h.participants.find((p) => p.player_id === players['Dana K'].id);
      expect(dana.crm_student_id).toBe(STU_DANA);

      expect(h.actions.length).toBeGreaterThan(0);
      expect(h.actions.map((a) => a.seq)).toEqual(
        [...h.actions.map((a) => a.seq)].sort((x, y) => x - y)
      );
      for (const a of h.actions) {
        expect(Object.keys(a).sort()).toEqual(
          ['action', 'amount', 'player_id', 'seq', 'street']
        );
        expect(['preflop', 'flop', 'turn', 'river']).toContain(a.street);
        expect(typeof a.amount).toBe('number');
      }
      // Checked-down hands reach showdown: both saw the flop and showdown.
      expect(h.participants.every((p) => p.saw_flop && p.wtsd)).toBe(true);
    }
  });
});

describe('CONTRACT §3 — cursor semantics', () => {
  it('total order, pagination, resume-never-skips across an app restart', async () => {
    const { app, db } = await playedFixture({ hands: 5 });

    const all = await walk(app, '/export/v1/hands');
    expect(all.records).toHaveLength(5);
    const ids = all.records.map((h) => h.hand_id);
    expect(new Set(ids).size).toBe(5);

    // Page size 2: same records, same order, has_more honest.
    const paged = await walk(app, '/export/v1/hands', { limit: 2 });
    expect(paged.records.map((h) => h.hand_id)).toEqual(ids);
    const first = await authed(app, '/export/v1/hands?limit=2');
    expect(first.body.has_more).toBe(true);
    expect(first.body.data).toHaveLength(2);

    // "Restart": a brand-new app over the same DB resumes from the stored
    // cursor without skipping.
    const app2 = createApp({ db, config: TEST_CONFIG });
    const resumed = await walk(app2, '/export/v1/hands', {
      limit: 2, from: first.body.next_cursor,
    });
    expect(resumed.records.map((h) => h.hand_id)).toEqual(ids.slice(2));

    // At-least-once: re-reading from an old cursor re-delivers identically.
    const again = await walk(app, '/export/v1/hands', { from: first.body.next_cursor });
    expect(again.records.map((h) => h.hand_id)).toEqual(ids.slice(2));

    // End of stream: empty page, null cursor, no more.
    const end = await authed(app, `/export/v1/hands?cursor=${all.cursor}`);
    expect(end.body).toEqual({ data: [], next_cursor: null, has_more: false });
  });

  it('rejects garbage cursors with 400 invalid_cursor', async () => {
    const { app } = await testApp();
    for (const bad of ['garbage', 'AAAA', Buffer.from('v2:12').toString('base64url'), '%%%']) {
      const res = await authed(app, `/export/v1/hands?cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'invalid_cursor' });
    }
    const sessions = await authed(app, '/export/v1/sessions?cursor=garbage');
    expect(sessions.status).toBe(400);
    expect(sessions.body).toEqual({ code: 'invalid_cursor' });
  });

  it('clamps limit to [1, 500] and defaults to 100', async () => {
    const { app } = await playedFixture({ hands: 3 });
    const zero = await authed(app, '/export/v1/hands?limit=0');
    expect(zero.status).toBe(200);
    expect(zero.body.data).toHaveLength(1); // clamped up to 1
    const big = await authed(app, '/export/v1/hands?limit=99999');
    expect(big.status).toBe(200); // clamped down to 500, no error
    expect(big.body.data).toHaveLength(3);
    const junk = await authed(app, '/export/v1/hands?limit=abc');
    expect(junk.status).toBe(200); // default 100
    expect(junk.body.data).toHaveLength(3);
  });

  it('sessions cursor orders by completion and resumes cleanly', async () => {
    const { app, tableService, players } = await playedFixture({ hands: 1 });
    // A second table completes later → strictly after the first in the stream.
    const created = await request(app).post('/api/tables')
      .set('Authorization', `Bearer ${players['Dana K'].token}`)
      .send({ small_blind: 50, big_blind: 100, table_size: 6 });
    const tableId = created.body.table.tableId;
    for (const name of ['Dana K', 'Ben R']) {
      await request(app).post(`/api/tables/${tableId}/join`)
        .set('Authorization', `Bearer ${players[name].token}`)
        .send({ buy_in: 10_000 });
    }
    await driveHand(tableService.get(tableId), strategies.checkDown);
    await tableService.closeTable(tableId, 'test');

    const page1 = await authed(app, '/export/v1/sessions?limit=1');
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.has_more).toBe(true);
    const page2 = await authed(app, `/export/v1/sessions?limit=1&cursor=${page1.body.next_cursor}`);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.has_more).toBe(false);
    expect(page2.body.data[0].session_id).not.toBe(page1.body.data[0].session_id);
  });
});

describe('CONTRACT §4.5 — revision plumbing', () => {
  it('a revision bump re-emits the full hand later in the stream', async () => {
    const { app, repos } = await playedFixture({ hands: 3 });
    const all = await walk(app, '/export/v1/hands');
    const target = all.records[0];

    const bumped = await repos.recordingRepo.bumpRevision(target.hand_id);
    expect(Number(bumped.revision)).toBe(2);

    // The consumer resumes from its stored end-of-stream cursor and receives
    // ONLY the re-emitted hand, full payload, revision incremented.
    const resumed = await authed(app, `/export/v1/hands?cursor=${all.cursor}`);
    expect(resumed.body.data).toHaveLength(1);
    const re = resumed.body.data[0];
    expect(re.hand_id).toBe(target.hand_id);
    expect(re.revision).toBe(2);
    expect(re.participants).toEqual(target.participants);
    expect(re.actions).toEqual(target.actions);
    expect(resumed.body.has_more).toBe(false);

    // A fresh full walk still delivers every hand exactly once per position,
    // with the bumped hand at the END of the stream (re-stamped seq).
    const rewalk = await walk(app, '/export/v1/hands');
    expect(rewalk.records).toHaveLength(3);
    expect(rewalk.records[rewalk.records.length - 1].hand_id).toBe(target.hand_id);
  });
});

describe('CONTRACT §4.6 / §4.7 — catalogs', () => {
  it('serve valid empty catalogs until M4/M7', async () => {
    const { app } = await testApp();
    const playlists = await authed(app, '/export/v1/playlists');
    expect(playlists.status).toBe(200);
    expect(playlists.body).toEqual({ data: [] });
    const presets = await authed(app, '/export/v1/tournament-presets');
    expect(presets.status).toBe(200);
    expect(presets.body).toEqual({ data: [] });
  });
});
