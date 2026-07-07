/**
 * ReplayEngine — pure, immutable reconstruction of a recorded hand
 * (PRD §5, M6). REBUILT, not graduated: the legacy module (legacy/game/
 * ReplayEngine.js) was welded to the old GameManager state shape and its
 * architecture *was* ARCH-05 — every helper mutated a shared `state` by
 * reference and `branch()` did an unbounded `JSON.parse(JSON.stringify(state))`.
 * See docs/decisions/0010.
 *
 * This version derives an immutable array of frames (one per non-reverted
 * action) by folding over the action log. Nothing is mutated in place; the
 * input hand is never touched; memory is bounded by (#actions × #players),
 * which for a poker hand is tiny — no snapshot of a live game object.
 *
 * Action amount semantics (must match TableEngine exactly):
 *   post_sb / post_bb / call → `amount` is chips ADDED this action
 *   bet / raise              → `amount` is the TOTAL bet-to level on the
 *                              street; chips added = amount − betThisRound
 *   check / fold             → 0
 * betThisRound resets to 0 at each street boundary.
 */

const STREET_BOARD = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** Cards visible once `street` has been dealt. */
function boardThrough(fullBoard, street) {
  return fullBoard.slice(0, STREET_BOARD[street] ?? 0);
}

function freezeSeat(seat) {
  return Object.freeze({
    playerId: seat.playerId,
    name: seat.name ?? null,
    position: seat.position,
    holeCards: seat.holeCards ? [...seat.holeCards] : null,
    stack: seat.stack,
    betThisRound: seat.betThisRound,
    committed: seat.committed,
    folded: seat.folded,
    isWinner: seat.isWinner,
  });
}

/**
 * buildReplay(hand) → an immutable replay with a frame per step.
 *
 * hand: {
 *   handId, board:[], pot, origin, revision,
 *   participants: [{ playerId, name?, position, holeCards, stackStart, stackEnd, isWinner }],
 *   actions:      [{ seq, playerId, street, action, amount, reverted }],
 *   tags?, annotations?
 * }
 *
 * Frames are indexed 0..N (N = number of non-reverted actions):
 *   frame 0 = initial state (nothing applied)
 *   frame k = state after the first k actions
 */
export function buildReplay(hand) {
  const fullBoard = hand.board ?? [];
  // Reverted actions (M4 undo) are not part of the canonical timeline.
  const actions = (hand.actions ?? [])
    .filter((a) => !a.reverted)
    .slice()
    .sort((a, b) => a.seq - b.seq);

  const seats = hand.participants.map((p) => ({
    playerId: p.playerId,
    name: p.name ?? null,
    position: p.position,
    holeCards: p.holeCards ?? null,
    isWinner: Boolean(p.isWinner),
    stack: p.stackStart,
    betThisRound: 0,
    committed: 0,
    folded: false,
  }));
  const seatOf = new Map(seats.map((s) => [s.playerId, s]));

  const frames = [];
  let street = 'preflop';
  let currentBet = 0;
  let pot = 0;

  const snapshot = (cursor, lastAction) => Object.freeze({
    cursor,
    lastAction: lastAction ? Object.freeze({ ...lastAction }) : null,
    street,
    board: Object.freeze(boardThrough(fullBoard, street)),
    pot,
    currentBet,
    seats: Object.freeze(seats.map(freezeSeat)),
    // Who acts next: the player of the action at this cursor (0-indexed).
    toAct: cursor < actions.length ? actions[cursor].playerId : null,
  });

  frames.push(snapshot(0, null));

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
      switch (a.action) {
        case 'post_sb':
        case 'post_bb':
        case 'call':
          added = a.amount;
          break;
        case 'bet':
        case 'raise':
          added = a.amount - seat.betThisRound; // amount = total level
          currentBet = a.amount;
          break;
        case 'fold':
          seat.folded = true;
          break;
        case 'check':
        default:
          break;
      }
      seat.stack -= added;
      seat.betThisRound += added;
      seat.committed += added;
      pot += added;
      if (a.action === 'call' && seat.betThisRound > currentBet) {
        currentBet = seat.betThisRound;
      }
    }
    frames.push(snapshot(k + 1, a));
  }

  return Object.freeze({
    handId: hand.handId,
    board: Object.freeze([...fullBoard]),
    pot: hand.pot,
    origin: hand.origin,
    revision: hand.revision,
    participants: hand.participants,
    tags: hand.tags ?? [],
    annotations: hand.annotations ?? [],
    frames: Object.freeze(frames),
    frameCount: frames.length,

    /** Frame at a cursor, clamped to range (immutable). */
    frameAt(cursor) {
      const c = Math.max(0, Math.min(cursor | 0, frames.length - 1));
      return frames[c];
    },

    /** The frame index whose lastAction has the given seq, or null. */
    cursorForSeq(seq) {
      const idx = frames.findIndex((f) => f.lastAction && f.lastAction.seq === seq);
      return idx === -1 ? null : idx;
    },

    /** First frame of each street present in the timeline: { street: cursor }. */
    streetCursors() {
      const out = {};
      for (const f of frames) {
        if (f.lastAction && out[f.street] === undefined) out[f.street] = f.cursor;
      }
      // preflop's first "real" frame is the first action; frame 0 is initial.
      if (out.preflop === undefined && frames.length > 1) out.preflop = 1;
      return out;
    },

    /**
     * Reconstruction result for the property test / branch seeding:
     * committed + final stack-before-award per player, and the running pot.
     */
    reconstruct() {
      const last = frames[frames.length - 1];
      const committed = {};
      const stackBeforeAward = {};
      for (const s of last.seats) {
        committed[s.playerId] = s.committed;
        stackBeforeAward[s.playerId] = s.stack; // stackStart − committed
      }
      return { committed, stackBeforeAward, pot: last.pot };
    },
  });
}
