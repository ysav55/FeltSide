/**
 * CRM → engine lesson sync (CONTRACT §8): declarative snapshot reconcile.
 *
 * The pushed body is the FULL set of upcoming schedule entries within the
 * CRM's horizon. The engine reconciles: create new, update changed, remove
 * scheduled entries that disappeared — and NEVER touches a table whose
 * session already started (anything not in status 'scheduled'). Idempotent
 * by construction; safe on every CRM scheduler tick.
 */

const ENTRY_TYPES = new Set(['lesson', 'tournament']);

/** Validates the request body. Returns entries array, or null when invalid. */
export function parseSnapshot(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.entries)) return null;
  const entries = [];
  const seen = new Set();
  for (const raw of body.entries) {
    if (!raw || typeof raw !== 'object') return null;
    const {
      crm_entry_id: crmEntryId, type, title,
      scheduled_start: start, scheduled_end: end,
      student_crm_ids: studentIds,
      playlist_id: playlistId = null,
      tournament_preset_id: presetId = null,
    } = raw;
    if (typeof crmEntryId !== 'string' || crmEntryId === '') return null;
    if (seen.has(crmEntryId)) return null; // one entry per id, snapshot semantics
    if (!ENTRY_TYPES.has(type)) return null;
    if (typeof title !== 'string') return null;
    if (!isIsoDate(start) || !isIsoDate(end)) return null;
    if (!Array.isArray(studentIds) || studentIds.some((s) => typeof s !== 'string')) return null;
    if (playlistId !== null && typeof playlistId !== 'string') return null;
    if (presetId !== null && typeof presetId !== 'string') return null;
    seen.add(crmEntryId);
    entries.push({
      crmEntryId, type, title,
      scheduledStart: start, scheduledEnd: end,
      studentCrmIds: studentIds, playlistId, presetId,
    });
  }
  return entries;
}

export async function reconcileLessons({ db, tablesRepo, entries, now = () => new Date() }) {
  const summary = { created: 0, updated: 0, removed: 0, pruned: 0, skippedStarted: 0 };

  // Resolve student mappings in one query; unmapped ids are stored and
  // surfaced (lobby badge), never blocking (CONTRACT §8).
  const allCrmIds = [...new Set(entries.flatMap((e) => e.studentCrmIds))];
  const mapped = new Map();
  if (allCrmIds.length > 0) {
    const { rows } = await db.query(
      `select id, crm_student_id from players
        where crm_student_id = any($1) and role = 'player'`,
      [allCrmIds]
    );
    for (const row of rows) mapped.set(row.crm_student_id, row.id);
  }

  const existing = await tablesRepo.listByCrmEntry();
  const byEntryId = new Map(existing.map((t) => [t.crm_entry_id, t]));
  const snapshotIds = new Set(entries.map((e) => e.crmEntryId));

  for (const entry of entries) {
    const mode = entry.type === 'tournament' ? 'tournament' : 'coached_cash';
    const config = {
      name: entry.title,
      syncType: entry.type,
      playlistId: entry.playlistId,            // inert until M4
      tournamentPresetId: entry.presetId,      // inert until M7
      studentCrmIds: entry.studentCrmIds,
      seatPlayerIds: entry.studentCrmIds
        .filter((id) => mapped.has(id))
        .map((id) => mapped.get(id)),          // soft seat list (coach overrides)
      unmappedStudentIds: entry.studentCrmIds.filter((id) => !mapped.has(id)),
    };
    const current = byEntryId.get(entry.crmEntryId);
    if (!current) {
      await tablesRepo.createScheduled({
        mode, config, crmEntryId: entry.crmEntryId,
        scheduledStart: entry.scheduledStart, scheduledEnd: entry.scheduledEnd,
      });
      summary.created += 1;
    } else if (current.status === 'scheduled') {
      await tablesRepo.updateScheduled(current.id, {
        mode, config,
        scheduledStart: entry.scheduledStart, scheduledEnd: entry.scheduledEnd,
      });
      summary.updated += 1;
    } else {
      summary.skippedStarted += 1; // started — never touched
    }
  }

  // Scheduled entries that disappeared from the snapshot are removed;
  // started tables survive even when their entry disappears.
  for (const table of existing) {
    if (snapshotIds.has(table.crm_entry_id)) continue;
    if (table.status !== 'scheduled') { summary.skippedStarted += 1; continue; }
    if (await tablesRepo.deleteScheduled(table.id)) summary.removed += 1;
  }

  // RUNTIME §3 backstop: scheduled-never-started, 24h past scheduled start.
  const cutoff = new Date(now().getTime() - 24 * 60 * 60 * 1000).toISOString();
  summary.pruned = await tablesRepo.pruneStaleScheduled(cutoff);

  return summary;
}

function isIsoDate(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}
