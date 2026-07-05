import { computeCounters } from '../game/counters.js';

export function buildRecordingRepo(db) {
  return {
    async openSession({ tableId, tableMode, crmEntryId = null }) {
      const { rows } = await db.query(
        `insert into sessions (table_id, table_mode, crm_entry_id)
         values ($1, $2, $3) returning *`,
        [tableId, tableMode, crmEntryId]
      );
      return rows[0];
    },

    async finalizeSession(sessionId) {
      const { rows } = await db.query(
        `update sessions
            set status = 'completed', ended_at = now(),
                hand_count = (select count(*) from hands where session_id = $1)
          where id = $1 and status = 'open'
          returning *`,
        [sessionId]
      );
      return rows[0] || null;
    },

    async findOpenSession(tableId) {
      const { rows } = await db.query(
        `select * from sessions where table_id = $1 and status = 'open'
          order by started_at desc limit 1`,
        [tableId]
      );
      return rows[0] || null;
    },

    /**
     * Writes a completed hand (hands + participants + actions) in one DB
     * transaction. Voided hands never reach this function.
     */
    async recordHand(sessionId, record) {
      const counters = computeCounters(record);
      await db.query('begin');
      try {
        const { rows } = await db.query(
          `insert into hands (session_id, origin, board, pot)
           values ($1, $2, $3, $4) returning id`,
          [sessionId, record.origin, JSON.stringify(record.board), record.pot]
        );
        const handId = rows[0].id;

        for (const p of record.participants) {
          const c = counters[p.playerId];
          await db.query(
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
          await db.query(
            `insert into hand_actions (hand_id, seq, player_id, street, action, amount)
             values ($1, $2, $3, $4, $5, $6)`,
            [handId, a.seq, a.playerId, a.street, a.action, a.amount]
          );
        }

        await db.query('commit');
        return handId;
      } catch (err) {
        await db.query('rollback');
        throw err;
      }
    },
  };
}
