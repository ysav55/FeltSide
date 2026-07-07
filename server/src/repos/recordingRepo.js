import { computeCounters } from '../game/counters.js';

/**
 * Export-seq stamping (CONTRACT §3): every stamp takes this advisory lock
 * inside its transaction, so seq assignment order == commit order ==
 * visibility order. A poll can therefore never observe seq N while a lower
 * seq is still uncommitted — "resuming from a returned cursor never skips".
 */
const EXPORT_SEQ_LOCK = 815001;

/**
 * Run `fn` inside ONE transaction on ONE connection (M8.6 fix). On a
 * `pg.Pool`, `begin`/`pg_advisory_xact_lock`/`commit` issued as separate
 * `pool.query()` calls can each land on a DIFFERENT pooled connection — so
 * the advisory lock and the transaction would not actually span the
 * statements, and under concurrent tables the export_seq ordering guarantee
 * (§3) would break. Pinning a client makes the lock real. PGlite (tests) has
 * no `connect()` and is single-connection, so it runs `fn` on `db` directly.
 */
async function withTx(db, fn) {
  if (typeof db.connect === 'function') {
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1)', [EXPORT_SEQ_LOCK]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  // Single-connection fallback (PGlite): the pool hazard cannot arise.
  await db.query('begin');
  try {
    await db.query('select pg_advisory_xact_lock($1)', [EXPORT_SEQ_LOCK]);
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

export function buildRecordingRepo(db) {
  return {
    async openSession({ tableId, tableMode, crmEntryId = null, coachPlayerId = null }) {
      const { rows } = await db.query(
        `insert into sessions (table_id, table_mode, crm_entry_id, coach_player_id)
         values ($1, $2, $3, $4) returning *`,
        [tableId, tableMode, crmEntryId, coachPlayerId]
      );
      return rows[0];
    },

    async finalizeSession(sessionId) {
      return withTx(db, async (tx) => {
        const { rows } = await tx.query(
          `update sessions
              set status = 'completed', ended_at = now(),
                  hand_count = (select count(*) from hands where session_id = $1),
                  export_seq = nextval('export_seq')
            where id = $1 and status = 'open'
            returning *`,
          [sessionId]
        );
        return rows[0] || null;
      });
    },

    /**
     * Revision bump (CONTRACT §4.5): coach re-tagging re-emits the full hand.
     * Re-stamping export_seq puts the hand back into the cursor stream; M6
     * triggers bumps — the plumbing and its tests land in M3.
     */
    async bumpRevision(handId) {
      return withTx(db, async (tx) => {
        const { rows } = await tx.query(
          `update hands
              set revision = revision + 1, export_seq = nextval('export_seq')
            where id = $1
            returning *`,
          [handId]
        );
        return rows[0] || null;
      });
    },

    async findOpenSession(tableId) {
      const { rows } = await db.query(
        `select * from sessions where table_id = $1 and status = 'open'
          order by started_at desc limit 1`,
        [tableId]
      );
      return rows[0] || null;
    },

    /** Tags for an already-recorded hand (live coach tagging after completion). */
    async addHandTags(handId, tags) {
      for (const t of tags) {
        await db.query(
          `insert into hand_tags (hand_id, tag, tag_type, player_id, action_seq)
           values ($1, $2, $3, $4, $5)`,
          [handId, t.tag, t.tag_type, t.player_id ?? null, t.action_seq ?? null]
        );
      }
    },

    /**
     * Writes a completed hand (hands + participants + actions + tags) in
     * one DB transaction. Voided hands never reach this function.
     */
    async recordHand(sessionId, record, tags = []) {
      const counters = computeCounters(record);
      return withTx(db, async (tx) => {
        const { rows } = await tx.query(
          `insert into hands (session_id, origin, board, pot, export_seq)
           values ($1, $2, $3, $4, nextval('export_seq')) returning id`,
          [sessionId, record.origin, JSON.stringify(record.board), record.pot]
        );
        const handId = rows[0].id;

        for (const p of record.participants) {
          const c = counters[p.playerId];
          await tx.query(
            `insert into hand_participants
               (hand_id, player_id, position, hole_cards, stack_start,
                stack_end, is_winner, vpip, pfr, three_bet_opp, three_bet,
                saw_flop, cbet_opp, cbet, wtsd, wsd)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [handId, p.playerId, p.position, JSON.stringify(p.holeCards),
             p.stackStart, p.stackEnd, p.isWinner,
             c.vpip, c.pfr, c.three_bet_opp, c.three_bet,
             c.saw_flop, c.cbet_opp, c.cbet, c.wtsd, c.wsd]
          );
        }

        for (const a of record.actions) {
          await tx.query(
            `insert into hand_actions (hand_id, seq, player_id, street, action, amount, reverted)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [handId, a.seq, a.playerId, a.street, a.action, a.amount, a.reverted ?? false]
          );
        }

        for (const t of tags) {
          await tx.query(
            `insert into hand_tags (hand_id, tag, tag_type, player_id, action_seq)
             values ($1, $2, $3, $4, $5)`,
            [handId, t.tag, t.tag_type, t.player_id ?? null, t.action_seq ?? null]
          );
        }

        return handId;
      });
    },
  };
}
