import {
  liveActions, voluntary, street, tag, RANK_VALUE,
} from './helpers.js';

/** TAXONOMY §1 — hand-level descriptors (player_id: null). */
export function analyzeHandDescriptors(record, { settings }) {
  const tags = [];
  const actions = liveActions(record);
  const preflop = street(actions, 'preflop');
  const vol = voluntary(preflop);
  const raises = vol.filter((a) => a.action === 'raise');
  const calls = vol.filter((a) => a.action === 'call');
  const flopDealt = record.board.length >= 3;

  // Pot type.
  if (raises.length === 0 && calls.length > 0) tags.push(tag('LIMPED_POT', 'descriptor'));
  if (raises.length === 1) tags.push(tag('SINGLE_RAISED_POT', 'descriptor'));
  if (raises.length === 2) tags.push(tag('THREE_BET_POT', 'descriptor'));
  if (raises.length >= 3) tags.push(tag('FOUR_BET_POT', 'descriptor'));

  // SQUEEZE_POT: a 3-bet after an open plus ≥1 caller.
  if (raises.length >= 2) {
    const openSeq = raises[0].seq;
    const threeBetSeq = raises[1].seq;
    const callersBetween = calls.some((a) => a.seq > openSeq && a.seq < threeBetSeq);
    if (callersBetween) tags.push(tag('SQUEEZE_POT', 'descriptor'));
  }

  // ALLIN_PREFLOP: ≥2 players all-in before the flop.
  const allinPreflop = new Set(preflop.filter((a) => a.allIn).map((a) => a.playerId));
  if (allinPreflop.size >= 2) tags.push(tag('ALLIN_PREFLOP', 'descriptor'));

  // MULTIWAY: N+ players see the flop.
  if (flopDealt) {
    const foldedPre = new Set(preflop.filter((a) => a.action === 'fold').map((a) => a.playerId));
    const sawFlop = record.participants.filter((p) => !foldedPre.has(p.playerId)).length;
    if (sawFlop >= (settings.thresholds.multiwayMinPlayers ?? 3)) {
      tags.push(tag('MULTIWAY', 'descriptor'));
    }
  }

  // WALK: everyone folds to the big blind; no flop.
  if (!flopDealt && raises.length === 0 && calls.length === 0 &&
      vol.every((a) => a.action === 'fold') &&
      record.winners.length === 1) {
    const bb = record.participants.find((p) => p.position === 'BB');
    if (bb && record.winners[0] === bb.playerId) tags.push(tag('WALK', 'descriptor'));
  }

  // Board texture (flop only).
  if (flopDealt) {
    const flop = record.board.slice(0, 3);
    const suits = new Set(flop.map((c) => c[1]));
    const ranks = flop.map((c) => c[0]);
    const values = ranks.map((r) => RANK_VALUE[r]);
    const paired = new Set(ranks).size < 3;
    if (suits.size === 1) tags.push(tag('BOARD_MONOTONE', 'descriptor'));
    if (suits.size === 2) tags.push(tag('BOARD_TWO_TONE', 'descriptor'));
    if (suits.size === 3) tags.push(tag('BOARD_RAINBOW', 'descriptor'));
    if (paired) tags.push(tag('BOARD_PAIRED', 'descriptor'));
    const span = Math.max(...values) - Math.min(...values);
    if (!paired && span <= (settings.thresholds.boardConnectedSpan ?? 4)) {
      tags.push(tag('BOARD_CONNECTED', 'descriptor'));
    }
    if (ranks.includes('A')) tags.push(tag('BOARD_ACE_HIGH', 'descriptor'));
  }

  // UNDO_USED — coached-table artifact, moved OUT of the mistake class.
  if (record.undoUsed) tags.push(tag('UNDO_USED', 'descriptor'));

  return tags;
}
