/**
 * Client-side replay reconstruction for the review page. Mirrors the
 * server's ReplayEngine frame model (server/src/game/ReplayEngine.js) for
 * responsive local stepping — the server's version is the authority and is
 * covered by the 50-hand reconstruction property test; this one is for
 * display only.
 *
 * Action amount semantics (must match TableEngine):
 *   post_sb / post_bb / call → chips ADDED
 *   bet / raise              → TOTAL bet-to level (added = amount − betThisRound)
 */
const STREET_BOARD = { preflop: 0, flop: 3, turn: 4, river: 5 };

export function buildReplay(hand) {
  const board = hand.board ?? [];
  const actions = (hand.actions ?? [])
    .filter((a) => !a.reverted)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const seats = hand.participants.map((p) => ({
    playerId: p.playerId, name: p.name, position: p.position,
    holeCards: p.holeCards ?? null, isWinner: Boolean(p.isWinner),
    stack: p.stackStart, betThisRound: 0, committed: 0, folded: false,
  }));
  const seatOf = new Map(seats.map((s) => [s.playerId, s]));

  const frames = [];
  let street = 'preflop';
  let currentBet = 0;
  let pot = 0;

  const snap = (cursor, lastAction) => ({
    cursor,
    lastAction: lastAction ? { ...lastAction } : null,
    street,
    board: board.slice(0, STREET_BOARD[street] ?? 0),
    pot,
    currentBet,
    seats: seats.map((s) => ({ ...s, holeCards: s.holeCards ? [...s.holeCards] : null })),
    toAct: cursor < actions.length ? actions[cursor].playerId : null,
  });

  frames.push(snap(0, null));
  for (let k = 0; k < actions.length; k++) {
    const a = actions[k];
    if (a.street !== street) {
      for (const s of seats) s.betThisRound = 0;
      currentBet = 0;
      street = a.street;
    }
    const seat = seatOf.get(a.playerId);
    if (seat) {
      let added = 0;
      if (a.action === 'post_sb' || a.action === 'post_bb' || a.action === 'call') added = a.amount;
      else if (a.action === 'bet' || a.action === 'raise') { added = a.amount - seat.betThisRound; currentBet = a.amount; }
      else if (a.action === 'fold') seat.folded = true;
      seat.stack -= added;
      seat.betThisRound += added;
      seat.committed += added;
      pot += added;
      if (a.action === 'call' && seat.betThisRound > currentBet) currentBet = seat.betThisRound;
    }
    frames.push(snap(k + 1, a));
  }

  return {
    handId: hand.handId,
    frames,
    frameCount: frames.length,
    frameAt: (c) => frames[Math.max(0, Math.min(c | 0, frames.length - 1))],
    cursorForSeq: (seq) => {
      const i = frames.findIndex((f) => f.lastAction && f.lastAction.seq === seq);
      return i === -1 ? null : i;
    },
    streetCursors: () => {
      const out = {};
      for (const f of frames) if (f.lastAction && out[f.street] === undefined) out[f.street] = f.cursor;
      if (out.preflop === undefined && frames.length > 1) out.preflop = 1;
      return out;
    },
  };
}
