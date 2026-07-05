/**
 * ReplayEngine — stateless replay helpers extracted from GameManager.
 *
 * Each function receives `state` by reference (the GameManager's this.state)
 * and mutates it in place. No class, no `this`.
 */

// ─────────────────────────────────────────────
//  Private helpers
// ─────────────────────────────────────────────

function _applyAction(state, action) {
  const player = state.players.find(p => p.stableId === action.player_id);
  if (!player) return; // silently skip unknown players

  if (/fold/i.test(action.action)) {
    player.is_active = false;
    player.action = 'folded';
  } else if (/call|raise|bet|all.?in/i.test(action.action)) {
    player.stack -= (action.amount || 0);
    state.pot += (action.amount || 0);
    player.action = action.action;
  } else if (/check/i.test(action.action)) {
    player.action = 'checked';
  }

  // Board reveal by street
  const rm = state.replay_mode;
  if (action.street === 'flop' && state.board.length < 3) {
    state.board = rm.original_board.slice(0, 3);
  } else if (action.street === 'turn' && state.board.length < 4) {
    state.board = rm.original_board.slice(0, 4);
  } else if (action.street === 'river' && state.board.length < 5) {
    state.board = rm.original_board.slice(0, 5);
  }

  state.current_turn = action.player_id;
}

function _buildStateAtCursor(state, cursor) {
  const rm = state.replay_mode;
  // Reset each player to original state
  state.players.forEach(p => {
    if (rm.original_stacks[p.stableId] !== undefined) {
      p.stack = rm.original_stacks[p.stableId];
    }
    p.is_active = true;
    p.hole_cards = rm.original_hole_cards[p.stableId] ? [...rm.original_hole_cards[p.stableId]] : [];
    p.action = 'waiting';
    p.current_bet = 0;
  });
  state.board = [];
  state.pot = 0;
  state.current_bet = 0;
  state.dealer_seat = rm.dealer_seat;
  state.current_turn = null;
  // Replay actions up to cursor
  for (let i = 0; i <= cursor; i++) {
    _applyAction(state, rm.actions[i]);
  }
}

// ─────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────

function load(state, handDetail) {
  if (state.phase !== 'waiting') {
    return { error: 'Can only load replay between hands' };
  }
  if (!handDetail) return { error: 'Hand not found' };

  // Validate completeness before touching state
  if (!Array.isArray(handDetail.actions)) return { error: 'Hand has no action data' };
  if (!Array.isArray(handDetail.players) || handDetail.players.length === 0) {
    return { error: 'Hand has no player data' };
  }
  const malformed = handDetail.actions.find(a => !a.player_id || !a.action || !a.street);
  if (malformed) return { error: 'Hand contains malformed action data' };

  const rm = state.replay_mode;
  rm.source_hand_id = handDetail.hand_id;
  rm.actions = (handDetail.actions || []).filter(a => !a.is_reverted);
  rm.cursor = -1;
  rm.branched = false;
  rm.pre_branch_snapshot = null;
  // Remember if a playlist was active so exitReplay can resume it
  rm.playlist_was_active = state.playlist_mode?.active ?? false;

  // Build lookup maps from handDetail.players
  rm.original_hole_cards = {};
  rm.original_stacks = {};
  rm.player_meta = {};
  (handDetail.players || []).forEach(p => {
    const key = p.player_id;
    rm.original_hole_cards[key] = p.hole_cards || [];
    rm.original_stacks[key] = p.stack_start;
    rm.player_meta[key] = { name: p.player_name, seat: p.seat };
  });

  rm.original_board = handDetail.board || [];
  rm.dealer_seat = handDetail.dealer_seat || 0;
  rm.active = true;

  state.phase = 'replay';
  _buildStateAtCursor(state, -1);
  return { success: true };
}

function stepForward(state) {
  if (state.phase !== 'replay') return { error: 'Not in replay mode' };
  const rm = state.replay_mode;
  if (rm.cursor >= rm.actions.length - 1) return { error: 'already_at_end' };
  rm.cursor++;
  _applyAction(state, rm.actions[rm.cursor]);
  return { success: true };
}

function stepBack(state) {
  if (state.phase !== 'replay') return { error: 'Not in replay mode' };
  const rm = state.replay_mode;
  if (rm.cursor <= -1) return { error: 'already_at_start' };
  rm.cursor--;
  _buildStateAtCursor(state, rm.cursor);
  return { success: true };
}

function jumpTo(state, target) {
  if (state.phase !== 'replay') return { error: 'Not in replay mode' };
  const rm = state.replay_mode;
  if (target < -1 || target >= rm.actions.length) return { error: 'Cursor out of range' };
  rm.cursor = target;
  _buildStateAtCursor(state, rm.cursor);
  return { success: true };
}

function branch(state) {
  if (state.phase !== 'replay') return { error: 'Not in replay mode' };
  const rm = state.replay_mode;
  if (rm.branched) return { error: 'Already branched' };

  rm.pre_branch_snapshot = JSON.parse(JSON.stringify(state));
  // In dev: warn if snapshot is suspiciously large (indicates long-session memory growth).
  // Call unbranch() or exit() to release snapshot memory.
  if (process.env.NODE_ENV !== 'production' &&
      JSON.stringify(rm.pre_branch_snapshot).length > 500_000) {
    console.warn('[ReplayEngine] branch snapshot >500KB — consider long-session cleanup');
  }
  rm.branched = true;

  // Mark all real seated players as observers — coach acts for shadow players
  state.players.forEach(p => {
    p.is_observer = true;
    p.in_hand = false;
  });

  // Inject a shadow player for every recorded player in this hand.
  // Shadow players use the recorded player_id as their `id` so current_turn
  // (which carries player_id values during replay) resolves correctly.
  Object.entries(rm.player_meta).forEach(([playerId, meta]) => {
    const originalCards = rm.original_hole_cards[playerId] ?? [];
    const stack = rm.original_stacks[playerId] ?? (state.big_blind * 100);
    state.players.push({
      id: playerId,
      stableId: playerId,
      name: meta.name,
      seat: meta.seat ?? 0,
      stack,
      hole_cards: [],
      // Stash for startGame — cleared by reset loop but preserved here for later
      _original_hole_cards: originalCards,
      current_bet: 0,
      total_bet_this_round: 0,
      total_contributed: 0,
      action: 'waiting',
      is_active: true,
      is_dealer: false,
      is_small_blind: false,
      is_big_blind: false,
      is_all_in: false,
      is_coach: false,
      is_shadow: true,
      acted_this_street: false,
      in_hand: true,
      disconnected: false,
    });
  });

  state.phase = 'waiting';
  state.history = [];
  state.street_snapshots = [];
  state.current_turn = null;
  return { success: true };
}

function unbranch(state) {
  const rm = state.replay_mode;
  if (!rm.branched) return { error: 'Not branched' };
  const snap = rm.pre_branch_snapshot;
  const playlistHands = state.replay_mode.pre_branch_snapshot?.playlist_mode?.hands ?? [];
  // NOTE: unbranch replaces the entire state object's contents — but since JS
  // passes objects by reference, we mutate the properties in place so the
  // caller's reference remains valid.
  const restored = JSON.parse(JSON.stringify(snap));
  // Restore hands array (stripped during snapshot to save space)
  if (restored.playlist_mode && playlistHands.length) {
    restored.playlist_mode.hands = playlistHands;
  }
  Object.keys(state).forEach(k => delete state[k]);
  Object.assign(state, restored);
  return { success: true };
}

function exit(state) {
  let rm = state.replay_mode;
  if (state.phase !== 'replay' && !rm.branched) {
    return { error: 'Not in replay mode' };
  }
  // Capture playlist flag — may be on either current rm or the pre-branch snapshot
  const playlistWasActive = rm.playlist_was_active
    ?? rm.pre_branch_snapshot?.replay_mode?.playlist_was_active
    ?? false;

  // If currently branched, restore the pre-branch snapshot first.
  // This removes shadow players and un-marks real players as observers.
  if (rm.branched && rm.pre_branch_snapshot) {
    const playlistHands = rm.pre_branch_snapshot.playlist_mode?.hands ?? [];
    const restored = JSON.parse(JSON.stringify(rm.pre_branch_snapshot));
    if (restored.playlist_mode && playlistHands.length) {
      restored.playlist_mode.hands = playlistHands;
    }
    Object.keys(state).forEach(k => delete state[k]);
    Object.assign(state, restored);
    rm = state.replay_mode; // now points to pre-branch replay_mode
  }

  // Restore stacks to pre-replay values and clear hand state
  state.players.forEach(p => {
    if (rm.original_stacks[p.stableId] !== undefined) {
      p.stack = rm.original_stacks[p.stableId];
    }
    p.hole_cards = [];
    p.action = 'waiting';
    p.is_active = true;
    p.current_bet = 0;
    p.is_observer = false;
  });
  state.board = [];
  state.pot = 0;
  state.current_bet = 0;
  state.current_turn = null;
  state.phase = 'waiting';
  // Reset replay_mode
  state.replay_mode = {
    active: false,
    source_hand_id: null,
    actions: [],
    cursor: -1,
    original_hole_cards: {},
    original_board: [],
    original_stacks: {},
    player_meta: {},
    dealer_seat: 0,
    branched: false,
    pre_branch_snapshot: null,
    playlist_was_active: false,
  };
  return { success: true, playlistWasActive };
}

module.exports = { load, stepForward, stepBack, jumpTo, branch, unbranch, exit, _applyAction, _buildStateAtCursor };
