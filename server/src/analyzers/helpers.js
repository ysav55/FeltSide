/**
 * Shared analyzer helpers over a completed hand record. All analyzers see
 * only NON-REVERTED actions (undone actions are marked, never counted).
 */

export const RANK_VALUE = Object.fromEntries(
  ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'].map((r, i) => [r, i + 2])
);

export function liveActions(record) {
  return record.actions.filter((a) => !a.reverted);
}

/** Voluntary actions: blind posts excluded. */
export function voluntary(actions) {
  return actions.filter((a) => !['post_sb', 'post_bb'].includes(a.action));
}

export function street(actions, name) {
  return actions.filter((a) => a.street === name);
}

export function positionOf(record, playerId) {
  return record.participants.find((p) => p.playerId === playerId)?.position ?? null;
}

export function holeCardsOf(record, playerId) {
  return record.participants.find((p) => p.playerId === playerId)?.holeCards ?? null;
}

/** The last preflop raiser (the preflop aggressor), or null (limped pot). */
export function preflopAggressor(actions) {
  const raises = street(actions, 'preflop').filter((a) => a.action === 'raise');
  return raises.length ? raises[raises.length - 1].playerId : null;
}

/** The last aggressor (bet or raise) of a given street, or null. */
export function streetAggressor(actions, name) {
  const aggr = street(actions, name).filter((a) => ['bet', 'raise'].includes(a.action));
  return aggr.length ? aggr[aggr.length - 1].playerId : null;
}

/** Players still unfolded after all non-reverted actions. */
export function unfoldedIds(record) {
  const folded = new Set(
    liveActions(record).filter((a) => a.action === 'fold').map((a) => a.playerId)
  );
  return record.participants.map((p) => p.playerId).filter((id) => !folded.has(id));
}

export function tag(tagName, tagType, playerId = null, actionSeq = null) {
  return { tag: tagName, tag_type: tagType, player_id: playerId, action_seq: actionSeq };
}
