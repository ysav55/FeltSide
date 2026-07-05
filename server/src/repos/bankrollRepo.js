export class InsufficientBalanceError extends Error {
  constructor() {
    super('insufficient_balance');
    this.name = 'InsufficientBalanceError';
  }
}

function isCheckViolation(err) {
  // pg raises code 23514; PGlite surfaces the message text.
  return err?.code === '23514' || /check constraint/i.test(err?.message || '');
}

export function buildBankrollRepo(db) {
  return {
    async createAccount(playerId) {
      await db.query(
        `insert into bankroll_accounts (player_id) values ($1)
         on conflict (player_id) do nothing`,
        [playerId]
      );
    },

    async getBalance(playerId) {
      const { rows } = await db.query(
        'select balance from bankroll_accounts where player_id = $1',
        [playerId]
      );
      return rows[0] ? Number(rows[0].balance) : null;
    },

    /** Atomic ledger write via the Postgres function (RUNTIME §5). */
    async applyTransaction({ playerId, type, amount, refId = null, note = null }) {
      try {
        const { rows } = await db.query(
          'select * from apply_bankroll_transaction($1, $2, $3, $4, $5)',
          [playerId, type, amount, refId, note]
        );
        return rows[0];
      } catch (err) {
        if (isCheckViolation(err)) throw new InsufficientBalanceError();
        throw err;
      }
    },

    async listTransactions(playerId, limit = 100) {
      const { rows } = await db.query(
        `select id, player_id, type, amount, ref_id, note, balance_after, created_at
           from bankroll_transactions
          where player_id = $1
          order by created_at desc, id
          limit $2`,
        [playerId, limit]
      );
      return rows;
    },

    /** Auditable invariant: balance == sum(transactions). */
    async sumTransactions(playerId) {
      const { rows } = await db.query(
        `select coalesce(sum(amount), 0)::bigint as total
           from bankroll_transactions where player_id = $1`,
        [playerId]
      );
      return Number(rows[0].total);
    },
  };
}
