import { createDeck, shuffleDeck } from './Deck.js';

/**
 * The deal seam (M2 §2, "design for M4 without building it").
 *
 * A card source is created per hand and answers two async questions:
 *   holeCards(seatKeys)      → { [seatKey]: [c1, c2] }
 *   street(name, count)      → [cards]   // 'flop' 3, 'turn' 1, 'river' 1
 *
 * Methods are async on purpose: DEALING.md §3's awaiting_deal state plugs
 * in here in M4 — a manual source may resolve only after the coach picks
 * cards. M2 wires only the RNG source below.
 */

export function rngCardSourceFactory(rng = Math.random) {
  return function createHandSource() {
    const deck = shuffleDeck(createDeck(), rng);
    let cursor = 0;
    const draw = (n) => {
      const cards = deck.slice(cursor, cursor + n);
      cursor += n;
      return cards;
    };
    return {
      async holeCards(seatKeys) {
        const out = {};
        for (const key of seatKeys) out[key] = draw(2);
        return out;
      },
      async street(name, count) {
        return draw(count);
      },
    };
  };
}

/**
 * Deterministic source for tests: hands are described as
 *   { holeCards: { [seatKey]: [c1, c2] }, board: [f1, f2, f3, t, r] }
 * Any seat/board slot left unspecified draws from a fixed remaining deck,
 * so scripted tests never collide with unscripted cards.
 */
export function scriptedCardSourceFactory(script) {
  let handNo = 0;
  return function createHandSource() {
    const hand = script[Math.min(handNo, script.length - 1)] || {};
    handNo += 1;
    const used = new Set([
      ...Object.values(hand.holeCards || {}).flat(),
      ...(hand.board || []),
    ]);
    const filler = createDeck().filter((c) => !used.has(c));
    let fillCursor = 0;
    let boardCursor = 0;
    const fill = () => filler[fillCursor++];
    return {
      async holeCards(seatKeys) {
        const out = {};
        for (const key of seatKeys) {
          out[key] = hand.holeCards?.[key] ?? [fill(), fill()];
        }
        return out;
      },
      async street(name, count) {
        const cards = [];
        for (let i = 0; i < count; i++) {
          cards.push(hand.board?.[boardCursor] ?? fill());
          boardCursor += 1;
        }
        return cards;
      },
    };
  };
}
