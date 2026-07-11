import { Router } from 'express';
import { InsufficientBalanceError } from '../repos/bankrollRepo.js';

export function buildBankrollRoutes({ playersRepo, bankrollRepo, requireAuth, requireCoach }) {
  const router = Router();

  async function accountView(playerId) {
    const balance = await bankrollRepo.getBalance(playerId);
    if (balance === null) return null;
    const transactions = await bankrollRepo.listTransactions(playerId);
    return { player_id: playerId, balance, transactions };
  }

  router.get('/me', requireAuth(), async (req, res, next) => {
    try {
      const view = await accountView(req.player.id);
      if (!view) return res.status(404).json({ error: 'no_account' });
      res.json(view);
    } catch (err) { next(err); }
  });

  router.get('/:playerId', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const view = await accountView(req.params.playerId);
      if (!view) return res.status(404).json({ error: 'no_account' });
      res.json(view);
    } catch (err) { next(err); }
  });

  // Coach adjustment: { delta } or { reset_to } ("reset to X" is computed
  // as a delta so the log stays append-only — RUNTIME §5), optional note.
  router.post('/:playerId/adjust', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const { delta, reset_to: resetTo, note } = req.body || {};
      const hasDelta = Number.isInteger(delta);
      const hasReset = Number.isInteger(resetTo);
      if (hasDelta === hasReset) { // exactly one of the two
        return res.status(400).json({ error: 'delta_xor_reset_to_required' });
      }
      if (hasReset && resetTo < 0) {
        return res.status(400).json({ error: 'reset_to_must_be_non_negative' });
      }

      let amount = delta;
      if (hasReset) {
        const balance = await bankrollRepo.getBalance(req.params.playerId);
        if (balance === null) return res.status(404).json({ error: 'no_account' });
        amount = resetTo - balance;
      }

      const tx = await bankrollRepo.applyTransaction({
        playerId: req.params.playerId,
        type: 'coach_adjustment',
        amount,
        note: note || null,
      });
      res.status(201).json({ transaction: tx });
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return res.status(400).json({ error: 'insufficient_balance' });
      }
      if (err?.message?.includes('bankroll_account_missing')) {
        return res.status(404).json({ error: 'no_account' });
      }
      next(err);
    }
  });

  return router;
}
