import { isBettingRoundOver, findNextActingPlayer } from './bettingRound.js';
import { buildSidePots } from './SidePotCalculator.js';
import { resolve as resolveShowdown } from './ShowdownResolver.js';
import { buildPositionMap } from './positions.js';

/**
 * TableEngine — the lean GameManager successor (M2 §2). One instance per
 * table; pure modules injected; no timers, no sockets, no persistence —
 * the runtime layer owns those. Emits events through `listener(event)`.
 *
 * Phases: waiting → preflop → flop → turn → river → showdown → hand_complete
 * (showdown is instantaneous; win-by-fold jumps straight to hand_complete).
 *
 * Action amount semantics (recorded to hand_actions and exported):
 *   bet / raise — the TOTAL bet-to level on that street ("raise to 300")
 *   call        — the chips ADDED to match
 *   post_sb / post_bb — the blind actually posted
 * Sizing ratios stay derivable per CONTRACT §4.4 (amount + pot context).
 */

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const BOARD_CARDS = { flop: 3, turn: 1, river: 1 };

export class TableEngine {
  constructor({ config, cardSourceFactory, listener = () => {} }) {
    this.config = config; // { smallBlind, bigBlind, tableSize }
    this.cardSourceFactory = cardSourceFactory;
    this.listener = listener;

    this.seats = new Array(config.tableSize).fill(null);
    this.button = null;
    this.phase = 'waiting';
    this.handNo = 0;

    this._resetHandState();
  }

  _resetHandState() {
    this.board = [];
    this.actions = [];
    this.seq = 0;
    this.currentBet = 0;
    this.minRaiseSize = this.config.bigBlind;
    this.toAct = null;
    this.sbSeat = null;
    this.bbSeat = null;
    this.positions = {};
    this.handStartStacks = {};
    this.source = null;
    // M4 coach controls: undo snapshots + marked-not-erased action log.
    this._snapshots = [];
    this._streetSnapshots = {};
    this.undoUsed = false;
  }

  // ── Seating ──────────────────────────────────────────────────────────

  seatPlayer({ playerId, name, stack, seatIndex = null }) {
    if (this.findSeat(playerId)) throw new EngineError('already_seated');
    let idx = seatIndex;
    if (idx === null) idx = this.seats.findIndex((s) => s === null);
    if (idx < 0 || idx >= this.seats.length) throw new EngineError('invalid_seat');
    if (this.seats[idx]) throw new EngineError('seat_taken');
    this.seats[idx] = {
      playerId, name, seatIndex: idx, stack,
      sittingOut: false,
      inHand: false, holeCards: null, folded: false, allIn: false,
      betThisRound: 0, contributed: 0, acted: false,
    };
    return this.seats[idx];
  }

  /**
   * A leaver mid-hand is folded but keeps the seat until the hand ends —
   * their contributed chips must stay in the pot. The seat releases at
   * hand completion (or immediately when no hand is running).
   */
  async unseat(playerId) {
    const seat = this.findSeat(playerId);
    if (!seat) return null;
    if (seat.inHand && !seat.folded && this.isHandRunning()) {
      seat.leaving = true;
      this._fold(seat);
      await this._afterAction(seat);
      if (this.isHandRunning()) return seat; // released in _completeHand
    }
    this.seats[seat.seatIndex] = null;
    return seat;
  }

  findSeat(playerId) {
    return this.seats.find((s) => s && s.playerId === playerId) || null;
  }

  occupiedSeats() {
    return this.seats.filter(Boolean);
  }

  eligibleSeats() {
    return this.occupiedSeats().filter((s) => !s.sittingOut && s.stack > 0);
  }

  setSitOut(playerId, sitOut) {
    const seat = this.findSeat(playerId);
    if (!seat) throw new EngineError('not_seated');
    seat.sittingOut = sitOut;
    // A sit-out during a live hand takes effect next hand; the current
    // hand keeps playing on its timer (RUNTIME §2).
  }

  addChips(playerId, amount) {
    const seat = this.findSeat(playerId);
    if (!seat) throw new EngineError('not_seated');
    if (seat.inHand && this.isHandRunning()) throw new EngineError('hand_in_progress');
    seat.stack += amount;
  }

  isHandRunning() {
    return STREETS.includes(this.phase) || this.phase === 'showdown';
  }

  canStartHand() {
    return !this.isHandRunning() && this.eligibleSeats().length >= 2;
  }

  // ── Hand lifecycle ───────────────────────────────────────────────────

  async startHand() {
    if (!this.canStartHand()) throw new EngineError('cannot_start');
    this._resetHandState();
    this.handNo += 1;

    const players = this.eligibleSeats();
    for (const s of this.occupiedSeats()) {
      s.inHand = false; s.holeCards = null; s.folded = false; s.allIn = false;
      s.betThisRound = 0; s.contributed = 0; s.acted = false;
    }
    for (const s of players) {
      s.inHand = true;
      this.handStartStacks[s.playerId] = s.stack;
    }

    let deadSb = false;
    if (this.config.tournamentBlinds) {
      // Tournament dead-button rules (TOURNAMENTS §4): the BB advances one
      // OCCUPIED seat every hand — nobody skips it, nobody double-posts,
      // regardless of eliminations or balancing moves. The SB is the seat
      // that just held the BB (dead — no post — if its player is gone);
      // the button is the seat that just held the SB (may be empty).
      deadSb = this._computeTournamentSeats(players);
      this.positions = this._tournamentPositions(players, deadSb);
    } else {
      // Button rotation: next eligible seat clockwise. First hand: lowest seat.
      this.button = this.button === null
        ? players[0].seatIndex
        : this._nextSeatIndex(this.button, players);

      // Blinds. Heads-up: the button IS the small blind (acts first preflop,
      // last postflop); 3+ handed: SB and BB are the next two seats clockwise.
      const headsUp = players.length === 2;
      this.sbSeat = headsUp ? this.button : this._nextSeatIndex(this.button, players);
      this.bbSeat = this._nextSeatIndex(this.sbSeat, players);

      this.positions = buildPositionMap(
        players
          .map((s) => ({ player_id: s.playerId, seat: s.seatIndex }))
          .sort((a, b) => a.seat - b.seat),
        this.button
      );
    }

    this.phase = 'preflop';
    // BB ante (TOURNAMENTS §1): dead money, posted by the BB before the
    // blinds; never counts toward the betting level.
    if ((this.config.bbAnte ?? 0) > 0) {
      this._postAnte(this._seatAt(this.bbSeat), this.config.bbAnte);
    }
    if (!deadSb) {
      this._postBlind(this._seatAt(this.sbSeat), this.config.smallBlind, 'post_sb');
    }
    this._postBlind(this._seatAt(this.bbSeat), this.config.bigBlind, 'post_bb');
    this.currentBet = this.config.bigBlind;
    this.minRaiseSize = this.config.bigBlind;

    this.source = this.cardSourceFactory();
    const dealt = await this.source.holeCards(players.map((s) => s.playerId));
    for (const s of players) s.holeCards = dealt[s.playerId];

    this.listener({ type: 'hand_started', handNo: this.handNo });

    // First to act preflop: left of BB (heads-up that is the button/SB).
    this.toAct = this._nextActorAfter(this.bbSeat);
    if (this.toAct === null) {
      // Everyone all-in from the blinds — run it out.
      await this._maybeFinishStreet(true);
    } else {
      this._emitAwaiting();
    }
    return this.handNo;
  }

  legalActions(playerId) {
    const seat = this.findSeat(playerId);
    if (!seat || !this.isHandRunning() || this.toAct !== seat.seatIndex) return null;
    const toCall = Math.min(this.currentBet - seat.betThisRound, seat.stack);
    const canRaise = seat.stack > toCall;
    const minRaiseTo = Math.min(
      this.currentBet + this.minRaiseSize,
      seat.betThisRound + seat.stack
    );
    return {
      fold: true,
      check: toCall === 0,
      call: toCall > 0 ? toCall : null,
      bet: this.currentBet === 0 && seat.stack > 0
        ? { min: Math.min(this.config.bigBlind, seat.stack), max: seat.stack }
        : null,
      // No-reopen rule: a player who already acted may raise again only if
      // a FULL raise happened since (which resets their acted flag). Facing
      // just a short all-in, they can only call or fold.
      raise: this.currentBet > 0 && canRaise && !seat.acted
        ? { minTo: minRaiseTo, maxTo: seat.betThisRound + seat.stack }
        : null,
    };
  }

  /** Auto action on timer expiry: check when legal, otherwise fold. */
  async autoAct(playerId) {
    const legal = this.legalActions(playerId);
    if (!legal) return;
    await this.act(playerId, legal.check ? { type: 'check' } : { type: 'fold' });
  }

  async act(playerId, { type, amount = 0 }) {
    const seat = this.findSeat(playerId);
    if (!seat) throw new EngineError('not_seated');
    if (!this.isHandRunning() || this.toAct !== seat.seatIndex) {
      throw new EngineError('not_your_turn');
    }

    this._snapshots.push(this._takeSnapshot());
    try {
      await this._applyAction(seat, { type, amount });
    } catch (err) {
      this._snapshots.pop();
      throw err;
    }
  }

  async _applyAction(seat, { type, amount = 0 }) {
    switch (type) {
      case 'fold':
        this._fold(seat);
        break;
      case 'check': {
        if (seat.betThisRound !== this.currentBet) throw new EngineError('cannot_check');
        seat.acted = true;
        this._log(seat, 'check', 0);
        break;
      }
      case 'call': {
        const toCall = Math.min(this.currentBet - seat.betThisRound, seat.stack);
        if (toCall <= 0) throw new EngineError('nothing_to_call');
        this._commit(seat, toCall);
        seat.acted = true;
        this._log(seat, 'call', toCall);
        break;
      }
      case 'bet': {
        if (this.currentBet !== 0) throw new EngineError('bet_facing_action');
        const max = seat.stack;
        if (amount < Math.min(this.config.bigBlind, max) || amount > max) {
          throw new EngineError('invalid_bet_size');
        }
        this._commit(seat, amount);
        this.currentBet = seat.betThisRound;
        this.minRaiseSize = seat.betThisRound;
        this._reopenAction(seat);
        seat.acted = true;
        this._log(seat, 'bet', seat.betThisRound);
        break;
      }
      case 'raise': {
        if (this.currentBet === 0) throw new EngineError('nothing_to_raise');
        if (seat.acted) throw new EngineError('action_not_reopened');
        const raiseTo = amount;
        const maxTo = seat.betThisRound + seat.stack;
        const minTo = this.currentBet + this.minRaiseSize;
        if (raiseTo > maxTo) throw new EngineError('invalid_raise_size');
        const isAllIn = raiseTo === maxTo;
        if (raiseTo < minTo && !isAllIn) throw new EngineError('invalid_raise_size');
        if (raiseTo <= this.currentBet) throw new EngineError('invalid_raise_size');
        const added = raiseTo - seat.betThisRound;
        this._commit(seat, added);
        const fullRaise = raiseTo >= minTo;
        if (fullRaise) {
          // A full raise reopens the action for everyone else.
          this.minRaiseSize = raiseTo - this.currentBet;
          this._reopenAction(seat);
        }
        // A short all-in raise does NOT reopen action (standard no-limit
        // rule): players who already acted may only call the new amount.
        this.currentBet = raiseTo;
        seat.acted = true;
        this._log(seat, 'raise', raiseTo);
        break;
      }
      default:
        throw new EngineError('unknown_action');
    }

    await this._afterAction(seat);
  }

  // ── Coach controls (M4) ──────────────────────────────────────────────

  /**
   * Full engine-state snapshot for undo/rollback. Hole cards are included
   * (a rollback across a street re-deal must not leak re-draws) and chips
   * are captured per seat so conservation holds by construction.
   */
  _takeSnapshot() {
    return {
      phase: this.phase,
      board: [...this.board],
      seq: this.seq,
      currentBet: this.currentBet,
      minRaiseSize: this.minRaiseSize,
      toAct: this.toAct,
      seats: this.seats.map((s) => s && {
        playerId: s.playerId,
        stack: s.stack, betThisRound: s.betThisRound, contributed: s.contributed,
        folded: s.folded, allIn: s.allIn, acted: s.acted, inHand: s.inHand,
        leaving: s.leaving ?? false,
        holeCards: s.holeCards ? [...s.holeCards] : null,
      }),
    };
  }

  _restoreSnapshot(snap) {
    // Actions after the snapshot are MARKED reverted, never erased.
    for (const a of this.actions) {
      if (a.seq > snap.seq) a.reverted = true;
    }
    // Cards dealt after the snapshot go back to the source's pool.
    const removed = this.board.slice(snap.board.length);
    if (removed.length && this.source?.release) this.source.release(removed);
    this.phase = snap.phase;
    this.board = [...snap.board];
    this.currentBet = snap.currentBet;
    this.minRaiseSize = snap.minRaiseSize;
    this.toAct = snap.toAct;
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      const ss = snap.seats[i];
      if (!s || !ss || s.playerId !== ss.playerId) continue;
      Object.assign(s, {
        stack: ss.stack, betThisRound: ss.betThisRound, contributed: ss.contributed,
        folded: ss.folded, allIn: ss.allIn, acted: ss.acted, inHand: ss.inHand,
        leaving: ss.leaving,
        holeCards: ss.holeCards ? [...ss.holeCards] : null,
      });
    }
    this.undoUsed = true;
  }

  /** Undo the last voluntary action (blinds are the floor). */
  undoLastAction() {
    if (!this.isHandRunning()) throw new EngineError('no_hand');
    const snap = this._snapshots.pop();
    if (!snap) throw new EngineError('nothing_to_undo');
    this._restoreSnapshot(snap);
    this.listener({ type: 'undo', seq: this.seq });
  }

  /**
   * Roll the current street back to just before its cards were dealt and
   * re-deal it (the source may present different cards / enter awaiting).
   * Betting on the rolled-back street is marked reverted.
   */
  async rollbackStreet() {
    if (!this.isHandRunning()) throw new EngineError('no_hand');
    const snap = this._streetSnapshots[this.phase];
    if (!snap) throw new EngineError('no_street_to_rollback'); // preflop
    // Drop per-action snapshots taken since the street started.
    this._snapshots = this._snapshots.filter((s) => s.seq <= snap.seq);
    const street = this.phase;
    this._restoreSnapshot(snap);
    delete this._streetSnapshots[street];
    this.listener({ type: 'street_rollback', street });
    // Re-deal the street through the source (may await the coach).
    return this._dealStreet(street);
  }

  /**
   * Force the current betting round to close. Chip-safe: every live player
   * still owing chips is auto-checked only when nothing is owed; if any bet
   * is unmatched the control is rejected (folding players by fiat would be
   * destructive).
   */
  async forceStreet() {
    if (!this.isHandRunning() || this.phase === 'showdown') throw new EngineError('no_hand');
    const owing = this._livePlayers().filter(
      (s) => !s.allIn && s.betThisRound < this.currentBet
    );
    if (owing.length > 0) throw new EngineError('bets_unmatched');
    for (const s of this._livePlayers()) s.acted = true;
    return this._maybeFinishStreet(
      this._livePlayers().filter((s) => !s.allIn).length <= 1
    );
  }

  /** Coach ends the hand, awarding the whole pot to one player. */
  awardPot(playerId) {
    if (!this.isHandRunning()) throw new EngineError('no_hand');
    const winner = this.findSeat(playerId);
    if (!winner || !winner.inHand || winner.folded) throw new EngineError('invalid_winner');
    const pot = this._playersInHand().reduce((sum, s) => sum + s.contributed, 0);
    winner.stack += pot;
    this._completeHand({
      pot, winners: [winner.playerId], showdownReached: false, showdown: null,
    });
  }

  /** Coach-set stack (coached tables); between hands only. */
  setStack(playerId, stack) {
    if (this.isHandRunning()) throw new EngineError('hand_in_progress');
    if (!Number.isInteger(stack) || stack < 0) throw new EngineError('invalid_stack');
    const seat = this.findSeat(playerId);
    if (!seat) throw new EngineError('not_seated');
    seat.stack = stack;
  }

  /** Blind change between hands. */
  setBlinds(smallBlind, bigBlind) {
    if (this.isHandRunning()) throw new EngineError('hand_in_progress');
    if (!Number.isInteger(smallBlind) || smallBlind < 1) throw new EngineError('invalid_blinds');
    if (!Number.isInteger(bigBlind) || bigBlind < smallBlind) throw new EngineError('invalid_blinds');
    this.config.smallBlind = smallBlind;
    this.config.bigBlind = bigBlind;
  }

  /** Total chips on the table — conservation assertions after coach controls. */
  totalChips() {
    return this.occupiedSeats().reduce(
      (sum, s) => sum + s.stack + s.contributed, 0
    );
  }

  // ── Internals ────────────────────────────────────────────────────────

  _seatAt(idx) { return this.seats[idx]; }

  _nextSeatIndex(fromIdx, pool) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const idx = (fromIdx + i) % n;
      if (pool.some((s) => s.seatIndex === idx)) return idx;
    }
    return fromIdx;
  }

  _postBlind(seat, amount, label) {
    const posted = Math.min(amount, seat.stack);
    this._commit(seat, posted);
    this._log(seat, label, posted);
  }

  /** BB ante: dead money into the pot — no effect on the betting level. */
  _postAnte(seat, amount) {
    const posted = Math.min(amount, seat.stack);
    seat.stack -= posted;
    seat.contributed += posted; // pot + side-pot math see it; betThisRound doesn't
    if (seat.stack === 0) seat.allIn = true;
    this._log(seat, 'post_ante', posted);
  }

  /** Blind/ante level change between hands (tournaments). */
  setLevelBlinds({ smallBlind, bigBlind, bbAnte = 0 }) {
    if (this.isHandRunning()) throw new EngineError('hand_in_progress');
    this.config.smallBlind = smallBlind;
    this.config.bigBlind = bigBlind;
    this.config.bbAnte = bbAnte;
  }

  /**
   * Dead-button seat computation (tournamentBlinds mode). Returns true when
   * the SB is dead (seat empty → no small blind posted this hand).
   */
  _computeTournamentSeats(players) {
    const n = this.seats.length;
    const nextOccupied = (from) => {
      for (let i = 1; i <= n; i++) {
        const idx = (from + i) % n;
        const s = this.seats[idx];
        if (s && s.inHand) return idx;
      }
      return from;
    };

    if (this._prevBb === undefined || this._prevBb === null) {
      // First hand of the table: standard draw from the lowest seat.
      this.button = players[0].seatIndex;
      if (players.length === 2) {
        this.sbSeat = this.button;
        this.bbSeat = nextOccupied(this.sbSeat);
      } else {
        this.sbSeat = nextOccupied(this.button);
        this.bbSeat = nextOccupied(this.sbSeat);
      }
      this._prevSb = this.sbSeat;
      this._prevBb = this.bbSeat;
      return false;
    }

    const bb = nextOccupied(this._prevBb);
    let deadSb = false;
    if (players.length === 2) {
      const other = players.find((p) => p.seatIndex !== bb);
      this.bbSeat = bb;
      this.sbSeat = other.seatIndex; // heads-up: button IS the small blind
      this.button = other.seatIndex;
    } else {
      this.bbSeat = bb;
      this.sbSeat = this._prevBb;                 // the seat that just had the BB
      const sbSeatObj = this.seats[this.sbSeat];
      deadSb = !(sbSeatObj && sbSeatObj.inHand);  // its player busted/moved → dead SB
      this.button = this._prevSb;                 // may be an empty seat: dead button
    }
    this._prevSb = this.sbSeat;
    this._prevBb = this.bbSeat;
    return deadSb;
  }

  /**
   * Position labels for tournament hands. Normal hands (all blinds live)
   * match the standard clockwise-from-button naming exactly; dead-blind
   * hands label BB/SB from the actual blind seats and fill the rest from
   * the button backwards (vocabulary stays within the standard set).
   */
  _tournamentPositions(players, deadSb) {
    const n = this.seats.length;
    const order = []; // clockwise starting after the BB, ending at the BB
    for (let i = 1; i <= n; i++) {
      const idx = (this.bbSeat + i) % n;
      const s = this.seats[idx];
      if (s && s.inHand) order.push(s.playerId);
    }
    const count = order.length;
    const out = {};
    const bbPlayer = order[count - 1];
    out[bbPlayer] = 'BB';
    let rest = order.slice(0, count - 1); // clockwise after BB … up to the seat before BB
    if (!deadSb && count >= 3) {
      out[rest[rest.length - 1]] = 'SB';
      rest = rest.slice(0, rest.length - 1);
    } else if (count === 2) {
      out[rest[0]] = 'BTN';
      return out;
    }
    // rest is clockwise [UTG-most … button-most]; assign from the button back.
    const NONBLIND = ['BTN', 'CO', 'HJ', 'MP', 'UTG+2', 'UTG+1', 'UTG'];
    for (let i = 0; i < rest.length; i++) {
      const fromButton = rest.length - 1 - i; // 0 = button-most
      out[rest[i]] = NONBLIND[Math.min(fromButton, NONBLIND.length - 1)];
    }
    return out;
  }

  _commit(seat, amount) {
    seat.stack -= amount;
    seat.betThisRound += amount;
    seat.contributed += amount;
    if (seat.stack === 0) seat.allIn = true;
  }

  _reopenAction(aggressor) {
    for (const s of this._playersInHand()) {
      if (s !== aggressor && !s.folded && !s.allIn) s.acted = false;
    }
  }

  _fold(seat) {
    seat.folded = true;
    seat.acted = true;
    this._log(seat, 'fold', 0);
  }

  _log(seat, action, amount) {
    this.seq += 1;
    this.actions.push({
      seq: this.seq, playerId: seat.playerId,
      street: this.phase, action, amount,
      allIn: seat.allIn, reverted: false,
    });
    this.listener({ type: 'action', seq: this.seq, playerId: seat.playerId, action, amount });
  }

  _playersInHand() {
    return this.occupiedSeats().filter((s) => s.inHand);
  }

  _livePlayers() {
    return this._playersInHand().filter((s) => !s.folded);
  }

  async _afterAction(actedSeat) {
    const live = this._livePlayers();
    if (live.length === 1) return this._winByFold(live[0]);

    const actors = live.filter((s) => !s.allIn);
    const roundOver = isBettingRoundOver(
      actors.map((s) => ({
        action: s.acted ? 'acted' : 'waiting',
        total_bet_this_round: s.betThisRound,
        is_active: true, is_all_in: false,
      })),
      this.currentBet
    );

    if (!roundOver) {
      // Only advance the turn if the actor WAS the player to act — an
      // out-of-turn fold (a leaver) must not skip the current actor.
      if (this.toAct === actedSeat.seatIndex) {
        const nextId = findNextActingPlayer(
          this._playersInHand().map((s) => ({
            id: s.playerId, is_active: !s.folded, is_all_in: s.allIn,
          })),
          actedSeat.playerId
        );
        this.toAct = nextId ? this.findSeat(nextId).seatIndex : null;
        if (this.toAct === null) return this._maybeFinishStreet(true);
        this._emitAwaiting();
      }
      return;
    }

    return this._maybeFinishStreet(actors.length <= 1);
  }

  async _maybeFinishStreet(runOut) {
    // Betting round closed: reset per-street state and move on.
    for (const s of this._playersInHand()) { s.betThisRound = 0; s.acted = false; }
    this.currentBet = 0;
    this.minRaiseSize = this.config.bigBlind;
    this.toAct = null;

    const idx = STREETS.indexOf(this.phase);
    if (this.phase === 'river') return this._showdown();

    const next = STREETS[idx + 1];
    return this._dealStreet(next, { runOut });
  }

  /**
   * Deal one street through the source (which may await the coach —
   * DEALING §3) and open its betting round. Also the re-entry point for
   * street rollback: the pre-deal snapshot lets the coach re-choose cards.
   */
  async _dealStreet(street, { runOut = false } = {}) {
    this.phase = street;
    this._streetSnapshots[street] = this._takeSnapshot();
    const cards = await this.source.street(street, BOARD_CARDS[street]);
    this.board.push(...cards);
    this.listener({ type: 'street', street, board: [...this.board] });

    const actors = this._livePlayers().filter((s) => !s.allIn);
    if (runOut || actors.length <= 1) {
      // Nobody left to bet — keep dealing to the river, then show down.
      return this._maybeFinishStreet(true);
    }

    // Postflop action starts left of the button.
    this.toAct = this._nextActorAfter(this.button);
    if (this.toAct === null) return this._maybeFinishStreet(true);
    this._emitAwaiting();
  }

  _nextActorAfter(fromIdx) {
    const n = this.seats.length;
    for (let i = 1; i <= n; i++) {
      const seat = this.seats[(fromIdx + i) % n];
      if (seat && seat.inHand && !seat.folded && !seat.allIn) return seat.seatIndex;
    }
    return null;
  }

  _winByFold(winner) {
    // Return the uncalled portion of the winner's last bet, award the rest.
    const others = this._playersInHand().filter((s) => s !== winner);
    const maxOther = Math.max(0, ...others.map((s) => s.contributed));
    const refund = Math.max(0, winner.contributed - maxOther);
    const pot = this._playersInHand().reduce((sum, s) => sum + s.contributed, 0) - refund;
    winner.stack += refund + pot;
    this._completeHand({
      pot,
      winners: [winner.playerId],
      showdownReached: false,
      showdown: null,
    });
  }

  _showdown() {
    this.phase = 'showdown';
    const inHand = this._playersInHand();
    const toResolver = (s) => ({
      id: s.playerId, name: s.name, seat: s.seatIndex,
      hole_cards: s.holeCards,
      total_contributed: s.contributed,
      is_active: !s.folded, is_all_in: s.allIn,
      is_small_blind: s.seatIndex === this.sbSeat,
    });
    const pot = inHand.reduce((sum, s) => sum + s.contributed, 0);
    const result = resolveShowdown(
      this._livePlayers().map(toResolver), inHand.map(toResolver), this.board, pot
    );
    for (const [playerId, delta] of result.stackDeltas) {
      this.findSeat(playerId).stack += delta;
    }
    this._completeHand({
      pot,
      winners: [...result.stackDeltas.keys()],
      showdownReached: true,
      showdown: result.showdown_result,
    });
  }

  _completeHand({ pot, winners, showdownReached, showdown }) {
    this.phase = 'hand_complete';
    this.toAct = null;
    const participants = this._playersInHand().map((s) => ({
      playerId: s.playerId,
      position: this.positions[s.playerId],
      holeCards: s.holeCards,
      stackStart: this.handStartStacks[s.playerId],
      stackEnd: s.stack,
      folded: s.folded,
      isWinner: winners.includes(s.playerId),
    }));
    const record = {
      handNo: this.handNo,
      // The source knows how its cards came to be (DEALING §1.4); the RNG
      // source has no origin() and defaults.
      origin: this.source?.origin?.() ?? 'rng',
      board: [...this.board],
      pot,
      actions: [...this.actions],
      participants,
      winners,
      showdownReached,
      showdown,
      undoUsed: this.undoUsed,
    };
    // Pot is fully awarded — clear per-hand chip commitments.
    for (const s of this._playersInHand()) {
      s.contributed = 0;
      s.betThisRound = 0;
    }
    // Release seats of players who left mid-hand (their chips stayed in
    // the pot; their remaining stack was cashed out at leave time).
    for (const s of this.occupiedSeats()) {
      if (s.leaving) this.seats[s.seatIndex] = null;
    }
    this.listener({ type: 'hand_complete', record });
    return record;
  }

  _emitAwaiting() {
    const seat = this._seatAt(this.toAct);
    this.listener({
      type: 'awaiting_action',
      seatIndex: seat.seatIndex,
      playerId: seat.playerId,
      legal: this.legalActions(seat.playerId),
    });
  }

  // ── Views & snapshots ────────────────────────────────────────────────

  getPublicState(viewerId = null) {
    const showdownLive = this.phase === 'hand_complete' || this.phase === 'showdown';
    return {
      phase: this.phase,
      handNo: this.handNo,
      board: [...this.board],
      pot: this._playersInHand().reduce((sum, s) => sum + s.contributed, 0),
      currentBet: this.currentBet,
      button: this.button,
      toAct: this.toAct,
      config: this.config,
      seats: this.seats.map((s) => s && {
        seatIndex: s.seatIndex,
        playerId: s.playerId,
        name: s.name,
        stack: s.stack,
        betThisRound: s.betThisRound,
        folded: s.folded,
        allIn: s.allIn,
        sittingOut: s.sittingOut,
        inHand: s.inHand,
        // Hole cards: own always; others only at a reached showdown.
        holeCards: s.playerId === viewerId
          ? s.holeCards
          : (showdownLive && !s.folded && this._livePlayers().length > 1 && s.holeCards
              ? s.holeCards : null),
      }),
    };
  }

  /** Seat snapshot persisted after every completed hand (RUNTIME §1). */
  snapshotSeats() {
    return this.occupiedSeats().map((s) => ({
      playerId: s.playerId, name: s.name, seatIndex: s.seatIndex,
      stack: s.stack, sittingOut: s.sittingOut,
    }));
  }

  /** Rebuild seating from a snapshot on boot — voids any in-flight hand. */
  restoreSeats(snapshot, { button = null, prevBb = null, prevSb = null } = {}) {
    this.seats = new Array(this.config.tableSize).fill(null);
    for (const s of snapshot) {
      this.seatPlayer({
        playerId: s.playerId, name: s.name, stack: s.stack, seatIndex: s.seatIndex,
      });
      if (s.sittingOut) this.setSitOut(s.playerId, true);
    }
    this.button = button;
    // Tournament dead-button progression survives a restart (RUNTIME §1).
    if (prevBb !== null) this._prevBb = prevBb;
    if (prevSb !== null) this._prevSb = prevSb;
    this.phase = 'waiting';
  }
}

export class EngineError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EngineError';
    this.code = code;
  }
}

// buildSidePots re-exported for chip-conservation assertions in tests.
export { buildSidePots };
