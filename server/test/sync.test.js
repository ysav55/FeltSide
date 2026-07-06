import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { testApp, TEST_CONFIG, loginToken, createPlayer } from './helpers.js';

// M3 acceptance #2 — sync reconcile suite: add / update / cancel /
// never-touch-started / all-entries-removed; idempotent double-push.

const KEY = TEST_CONFIG.exportApiKey;
const put = (app, body) =>
  request(app).put('/sync/v1/lessons')
    .set('Authorization', `Bearer ${KEY}`).send(body);

const STU_LINKED = 'stu_01HZXW5T9GXKQ4YB2M8RLNKD01';
const STU_UNKNOWN = 'stu_01HZXW5T9GXKQ4YB2M8RUNKN02';

function lessonEntry(overrides = {}) {
  return {
    crm_entry_id: 'evt_01HZXTESTLESSON000000000001',
    type: 'lesson',
    title: 'Group — 3-bet pots',
    scheduled_start: new Date(Date.now() + 3600_000).toISOString(),
    scheduled_end: new Date(Date.now() + 7200_000).toISOString(),
    student_crm_ids: [STU_LINKED, STU_UNKNOWN],
    playlist_id: 'pls_a1',
    tournament_preset_id: null,
    ...overrides,
  };
}

function tournamentEntry(overrides = {}) {
  return {
    crm_entry_id: 'evt_01HZXTESTTOURNEY00000000002',
    type: 'tournament',
    title: 'Weekly Turbo',
    scheduled_start: new Date(Date.now() + 86_400_000).toISOString(),
    scheduled_end: new Date(Date.now() + 90_000_000).toISOString(),
    student_crm_ids: [],
    playlist_id: null,
    tournament_preset_id: 'tpr_a1',
    ...overrides,
  };
}

/** App + one CRM-linked player. */
async function syncFixture() {
  const ctx = await testApp();
  const { app } = ctx;
  const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
  const created = await createPlayer(app, coachToken, {
    displayName: 'Dana K', email: 'dana@t.io', initialPassword: 'initial-pass-1',
  });
  const danaId = created.body.player.id;
  await request(app).put(`/api/players/${danaId}/crm-student-id`)
    .set('Authorization', `Bearer ${coachToken}`)
    .send({ crm_student_id: STU_LINKED });
  return { ...ctx, coachToken, danaId };
}

const scheduled = async (repos) =>
  (await repos.tablesRepo.listByCrmEntry()).filter((t) => t.status === 'scheduled');

describe('PUT /sync/v1/lessons — validation', () => {
  it('rejects malformed snapshots with 400 invalid_snapshot', async () => {
    const { app } = await testApp();
    for (const bad of [
      {}, { entries: 'nope' },
      { entries: [{ ...lessonEntry(), type: 'party' }] },
      { entries: [{ ...lessonEntry(), crm_entry_id: '' }] },
      { entries: [{ ...lessonEntry(), scheduled_start: 'not-a-date' }] },
      { entries: [{ ...lessonEntry(), student_crm_ids: 'stu_x' }] },
      { entries: [lessonEntry(), lessonEntry()] }, // duplicate ids in one snapshot
    ]) {
      const res = await put(app, bad);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'invalid_snapshot' });
    }
  });
});

describe('PUT /sync/v1/lessons — reconcile', () => {
  it('creates scheduled tables, maps students, surfaces unmapped ids in the lobby', async () => {
    const { app, repos, danaId } = await syncFixture();
    const res = await put(app, { entries: [lessonEntry(), tournamentEntry()] });
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const rows = await scheduled(repos);
    expect(rows).toHaveLength(2);
    const lesson = rows.find((t) => t.mode === 'coached_cash');
    const tourney = rows.find((t) => t.mode === 'tournament');

    expect(lesson.crm_entry_id).toBe(lessonEntry().crm_entry_id);
    expect(lesson.config.name).toBe('Group — 3-bet pots');
    expect(lesson.config.playlistId).toBe('pls_a1');
    expect(lesson.config.seatPlayerIds).toEqual([danaId]);       // soft seat list
    expect(lesson.config.unmappedStudentIds).toEqual([STU_UNKNOWN]); // never blocks
    expect(lesson.scheduled_start).toBeTruthy();

    expect(tourney.crm_entry_id).toBe(tournamentEntry().crm_entry_id);
    expect(tourney.config.tournamentPresetId).toBe('tpr_a1');    // inert until M7

    // Lobby (JWT side): both visible with start times; join is client-blocked
    // and there is no runtime to join server-side.
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const lobby = await request(app).get('/api/tables')
      .set('Authorization', `Bearer ${coachToken}`);
    const lobbyScheduled = lobby.body.data.filter((t) => t.status === 'scheduled');
    expect(lobbyScheduled).toHaveLength(2);
    for (const t of lobbyScheduled) {
      expect(t.scheduled_start).toBeTruthy();
      expect(t.config.name).toBeTruthy();
    }
    const joinAttempt = await request(app).post(`/api/tables/${lesson.id}/join`)
      .set('Authorization', `Bearer ${coachToken}`).send({ buy_in: 10_000 });
    expect(joinAttempt.status).toBe(404); // no runtime until M4 activates it
  });

  it('updates changed entries in place and is idempotent on double-push', async () => {
    const { app, repos } = await syncFixture();
    await put(app, { entries: [lessonEntry()] });
    const [before] = await scheduled(repos);

    // Identical push → nothing new.
    await put(app, { entries: [lessonEntry()] });
    const afterSame = await scheduled(repos);
    expect(afterSame).toHaveLength(1);
    expect(afterSame[0].id).toBe(before.id);

    // Changed title + time → same row, updated fields.
    const moved = lessonEntry({
      title: 'Rescheduled — river play',
      scheduled_start: new Date(Date.now() + 10_800_000).toISOString(),
    });
    await put(app, { entries: [moved] });
    const afterMove = await scheduled(repos);
    expect(afterMove).toHaveLength(1);
    expect(afterMove[0].id).toBe(before.id);
    expect(afterMove[0].config.name).toBe('Rescheduled — river play');
    expect(new Date(afterMove[0].scheduled_start).toISOString())
      .toBe(moved.scheduled_start);
  });

  it('removes scheduled entries that left the snapshot; empty snapshot clears all', async () => {
    const { app, repos } = await syncFixture();
    await put(app, { entries: [lessonEntry(), tournamentEntry()] });
    expect(await scheduled(repos)).toHaveLength(2);

    await put(app, { entries: [lessonEntry()] }); // tournament cancelled CRM-side
    const afterCancel = await scheduled(repos);
    expect(afterCancel).toHaveLength(1);
    expect(afterCancel[0].mode).toBe('coached_cash');

    await put(app, { entries: [] }); // everything cancelled
    expect(await scheduled(repos)).toHaveLength(0);
  });

  it('NEVER touches a table whose session started — update or disappearance', async () => {
    const { app, db, repos } = await syncFixture();
    await put(app, { entries: [lessonEntry()] });
    const [table] = await scheduled(repos);

    // The lesson starts (M4 will do this transition; simulate it directly).
    await db.query(`update tables set status = 'active' where id = $1`, [table.id]);

    // A changed entry does not touch the started table…
    await put(app, { entries: [lessonEntry({ title: 'Should not apply' })] });
    const activeAfterUpdate = await repos.tablesRepo.findById(table.id);
    expect(activeAfterUpdate.status).toBe('active');
    expect(activeAfterUpdate.config.name).toBe('Group — 3-bet pots');

    // …and neither does its disappearance from the snapshot.
    await put(app, { entries: [] });
    const survivor = await repos.tablesRepo.findById(table.id);
    expect(survivor).not.toBeNull();
    expect(survivor.status).toBe('active');
  });

  it('prunes scheduled-never-started tables 24h past their start (RUNTIME §3)', async () => {
    const { app, repos } = await syncFixture();
    const stale = lessonEntry({
      crm_entry_id: 'evt_01HZXTESTSTALE000000000003',
      scheduled_start: new Date(Date.now() - 25 * 3600_000).toISOString(),
      scheduled_end: new Date(Date.now() - 24 * 3600_000).toISOString(),
    });
    // First push creates it (the CRM should not push stale entries, but the
    // engine backstops); the prune inside the SAME reconcile removes it.
    await put(app, { entries: [stale] });
    expect(await scheduled(repos)).toHaveLength(0);

    // Direct repo check of the prune primitive the boot/hourly path uses.
    await put(app, { entries: [lessonEntry()] });
    const pruned = await repos.tablesRepo.pruneStaleScheduled(
      new Date(Date.now() + 2 * 3600_000).toISOString() // cutoff after its start
    );
    expect(pruned).toBe(1);
  });
});
