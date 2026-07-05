'use strict';

/**
 * HandEvaluator.js
 *
 * evaluate(holeCards, boardCards) → HandResult
 *
 * HandResult: { rank, rankName, bestFive, kickers, description }
 *
 * Pure functions only — no side effects, no imports from GameManager.
 */

const { RANKS } = require('./Deck');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HAND_RANKS = {
  HIGH_CARD:       0,
  ONE_PAIR:        1,
  TWO_PAIR:        2,
  THREE_OF_A_KIND: 3,
  STRAIGHT:        4,
  FLUSH:           5,
  FULL_HOUSE:      6,
  FOUR_OF_A_KIND:  7,
  STRAIGHT_FLUSH:  8,
  ROYAL_FLUSH:     9,
};

// RANKS from Deck.js: ['2','3','4','5','6','7','8','9','T','J','Q','K','A']
// index 0 = 2, index 12 = A
const RANK_ORDER = RANKS; // alias for clarity

/** Return 0-12 numeric value for a rank character */
const rankVal = r => RANK_ORDER.indexOf(r);

/** Full rank name used in description strings */
const RANK_DISPLAY = {
  '2': 'Twos',   '3': 'Threes', '4': 'Fours',  '5': 'Fives',
  '6': 'Sixes',  '7': 'Sevens', '8': 'Eights', '9': 'Nines',
  'T': 'Tens',   'J': 'Jacks',  'Q': 'Queens', 'K': 'Kings', 'A': 'Aces',
};

const RANK_SINGULAR = {
  '2': 'Two',   '3': 'Three', '4': 'Four',  '5': 'Five',
  '6': 'Six',   '7': 'Seven', '8': 'Eight', '9': 'Nine',
  'T': 'Ten',   'J': 'Jack',  'Q': 'Queen', 'K': 'King', 'A': 'Ace',
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Extract rank char from a card string e.g. 'As' → 'A' */
const cardRank = c => c[0];

/** Extract suit char from a card string e.g. 'As' → 's' */
const cardSuit = c => c[1];

/**
 * Sort cards descending by rank value (highest first).
 * Returns a new array — does not mutate.
 */
function sortDesc(cards) {
  return [...cards].sort((a, b) => rankVal(cardRank(b)) - rankVal(cardRank(a)));
}

/**
 * Generate all combinations of size k from array arr.
 * Returns an array of arrays.
 */
function combinations(arr, k) {
  const result = [];
  function helper(start, current) {
    if (current.length === k) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      helper(i + 1, current);
      current.pop();
    }
  }
  helper(0, []);
  return result;
}

// ---------------------------------------------------------------------------
// 5-card evaluator
// ---------------------------------------------------------------------------

/**
 * evaluateFive(cards)
 *
 * cards: string[5] — exactly 5 card strings
 * Returns a HandResult object.
 */
function evaluateFive(cards) {
  if (cards.length !== 5) {
    throw new Error(`evaluateFive expects exactly 5 cards, got ${cards.length}`);
  }

  const sorted = sortDesc(cards); // highest rank first
  const ranks  = sorted.map(cardRank);
  const suits  = sorted.map(cardSuit);
  const vals   = ranks.map(rankVal); // numeric values, descending

  // --- flush check ---
  const isFlush = suits.every(s => s === suits[0]);

  // --- straight check ---
  // Normal straight: vals differ by exactly 1 at each step (already sorted desc)
  function isNormalStraight(vs) {
    for (let i = 0; i < vs.length - 1; i++) {
      if (vs[i] - vs[i + 1] !== 1) return false;
    }
    return true;
  }

  // A-low straight: A-2-3-4-5 (wheel)
  // Sorted desc values for wheel would be [12,3,2,1,0] → not a normal straight
  // Detect by checking ranks contain A,2,3,4,5
  function isWheelStraight(vs) {
    // vals sorted desc; wheel = [12, 3, 2, 1, 0]
    const wheel = [12, 3, 2, 1, 0];
    return wheel.every((v, i) => vs[i] === v);
  }

  const normalStraight = isNormalStraight(vals);
  const wheelStraight  = isWheelStraight(vals);
  const isStraight     = normalStraight || wheelStraight;

  // High card of straight (for description/kickers)
  // Wheel high card is 5 (index 3 in RANK_ORDER)
  let straightHighCard = null;
  if (normalStraight) straightHighCard = ranks[0]; // highest rank in sorted hand
  if (wheelStraight)  straightHighCard = '5';       // wheel high card

  // For wheel straights, reorder bestFive as A-2-3-4-5 → 5-4-3-2-A display
  // but we keep the standard sorted order for comparison purposes
  // The bestFive returned is the sorted-desc canonical form for comparison

  // --- count rank frequencies ---
  const freq = {}; // rank → count
  for (const r of ranks) freq[r] = (freq[r] || 0) + 1;

  // Groups by frequency
  const quads  = Object.keys(freq).filter(r => freq[r] === 4);
  const trips  = Object.keys(freq).filter(r => freq[r] === 3);
  const pairs  = Object.keys(freq).filter(r => freq[r] === 2);
  const singles = Object.keys(freq).filter(r => freq[r] === 1);

  // Sort groups by rank value descending (highest rank group first)
  const sortRanksDesc = arr => [...arr].sort((a, b) => rankVal(b) - rankVal(a));

  const sortedQuads   = sortRanksDesc(quads);
  const sortedTrips   = sortRanksDesc(trips);
  const sortedPairs   = sortRanksDesc(pairs);
  const sortedSingles = sortRanksDesc(singles);

  // Helper: pick cards matching given ranks in desc order
  function cardsOfRank(rankList) {
    const out = [];
    for (const r of rankList) {
      out.push(...sorted.filter(c => cardRank(c) === r));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Determine hand rank (check highest to lowest)
  // ---------------------------------------------------------------------------

  // 1. Royal Flush — straight flush, A-high
  if (isFlush && normalStraight && ranks[0] === 'A') {
    return makeResult(
      HAND_RANKS.ROYAL_FLUSH,
      'ROYAL_FLUSH',
      sorted,
      [], // no kickers — hand is fully determined, can never split on kicker
      'Royal Flush'
    );
  }

  // 2. Straight Flush
  if (isFlush && isStraight) {
    const bestFive = wheelStraight
      ? reorderWheel(sorted)
      : sorted;
    return makeResult(
      HAND_RANKS.STRAIGHT_FLUSH,
      'STRAIGHT_FLUSH',
      bestFive,
      [],
      `Straight Flush, ${RANK_SINGULAR[straightHighCard]}-high`
    );
  }

  // 3. Four of a Kind
  if (sortedQuads.length === 1) {
    const quadRank   = sortedQuads[0];
    const quadCards  = cardsOfRank([quadRank]);
    const kicker     = sorted.find(c => cardRank(c) !== quadRank);
    const bestFive   = [...quadCards, kicker];
    return makeResult(
      HAND_RANKS.FOUR_OF_A_KIND,
      'FOUR_OF_A_KIND',
      bestFive,
      [kicker],
      `Four of a Kind, ${RANK_DISPLAY[quadRank]}`
    );
  }

  // 4. Full House
  if (sortedTrips.length === 1 && sortedPairs.length === 1) {
    const tripRank  = sortedTrips[0];
    const pairRank  = sortedPairs[0];
    const tripCards = cardsOfRank([tripRank]);
    const pairCards = cardsOfRank([pairRank]);
    const bestFive  = [...tripCards, ...pairCards];
    // ISS-26: kickers holds the pair cards (2 cards) for Full House tiebreaking.
    // Two Full Houses with identical trip ranks are split by the pair rank.
    // Using pairCards (rather than []) lets compareHands() resolve that case correctly.
    return makeResult(
      HAND_RANKS.FULL_HOUSE,
      'FULL_HOUSE',
      bestFive,
      pairCards,
      `Full House, ${RANK_DISPLAY[tripRank]} full of ${RANK_DISPLAY[pairRank]}`
    );
  }

  // 5. Flush
  if (isFlush) {
    return makeResult(
      HAND_RANKS.FLUSH,
      'FLUSH',
      sorted,
      sorted, // all 5 are kickers
      `Flush, ${RANK_SINGULAR[ranks[0]]}-high`
    );
  }

  // 6. Straight
  if (isStraight) {
    const bestFive = wheelStraight ? reorderWheel(sorted) : sorted;
    const highCard = sorted.find(c => cardRank(c) === straightHighCard);
    return makeResult(
      HAND_RANKS.STRAIGHT,
      'STRAIGHT',
      bestFive,
      [highCard],
      `Straight, ${RANK_SINGULAR[straightHighCard]}-high`
    );
  }

  // 7. Three of a Kind
  if (sortedTrips.length === 1 && sortedPairs.length === 0) {
    const tripRank   = sortedTrips[0];
    const tripCards  = cardsOfRank([tripRank]);
    const kickCards  = cardsOfRank(sortedSingles); // 2 kickers
    const bestFive   = [...tripCards, ...kickCards];
    return makeResult(
      HAND_RANKS.THREE_OF_A_KIND,
      'THREE_OF_A_KIND',
      bestFive,
      kickCards,
      `Three of a Kind, ${RANK_DISPLAY[tripRank]}`
    );
  }

  // 8. Two Pair
  if (sortedPairs.length === 2) {
    const highPairRank = sortedPairs[0];
    const lowPairRank  = sortedPairs[1];
    const highPairCards = cardsOfRank([highPairRank]);
    const lowPairCards  = cardsOfRank([lowPairRank]);
    const kicker        = sorted.find(c => cardRank(c) !== highPairRank && cardRank(c) !== lowPairRank);
    const bestFive      = [...highPairCards, ...lowPairCards, kicker];
    return makeResult(
      HAND_RANKS.TWO_PAIR,
      'TWO_PAIR',
      bestFive,
      [kicker],
      `Two Pair, ${RANK_DISPLAY[highPairRank]} and ${RANK_DISPLAY[lowPairRank]}`
    );
  }

  // 9. One Pair
  if (sortedPairs.length === 1) {
    const pairRank   = sortedPairs[0];
    const pairCards  = cardsOfRank([pairRank]);
    const kickCards  = cardsOfRank(sortedSingles); // 3 kickers
    const bestFive   = [...pairCards, ...kickCards];
    return makeResult(
      HAND_RANKS.ONE_PAIR,
      'ONE_PAIR',
      bestFive,
      kickCards,
      `One Pair, ${RANK_DISPLAY[pairRank]}`
    );
  }

  // 10. High Card
  return makeResult(
    HAND_RANKS.HIGH_CARD,
    'HIGH_CARD',
    sorted,
    sorted, // all 5 sorted desc are kickers
    `High Card, ${RANK_SINGULAR[ranks[0]]}`
  );
}

// ---------------------------------------------------------------------------
// Helpers for evaluateFive
// ---------------------------------------------------------------------------

/** Build a HandResult object */
function makeResult(rank, rankName, bestFive, kickers, description) {
  return { rank, rankName, bestFive, kickers, description };
}

/**
 * Reorder wheel straight A-2-3-4-5 so it displays as 5-4-3-2-A.
 * Input sorted is descending, so: [A,5,4,3,2] → already correct for display
 * but we want [5,4,3,2,A] for canonical high-card-first ordering of the straight.
 */
function reorderWheel(sorted) {
  // sorted desc = [A, 5, 4, 3, 2]  (A is index 0)
  // wheel display: 5-4-3-2-A
  const ace  = sorted.find(c => cardRank(c) === 'A');
  const rest = sorted.filter(c => cardRank(c) !== 'A');
  return [...rest, ace]; // [5,4,3,2,A]
}

// ---------------------------------------------------------------------------
// Compare two HandResult objects
// ---------------------------------------------------------------------------

/**
 * compareHands(a, b)
 * Returns positive if a > b, negative if a < b, 0 if tie.
 */
function compareHands(a, b) {
  if (!a || !b) return 0; // treat missing as tie

  // Primary: hand rank
  if (a.rank !== b.rank) return a.rank - b.rank;

  // Tiebreak: compare bestFive card values, highest first
  // For wheel straights the reordering means bestFive[0] is 5 (value 3), not A (value 12)
  // This is correct: two wheel straights tie; a 6-high straight > wheel.
  const aVals = (a.bestFive ?? []).map(c => rankVal(cardRank(c)));
  const bVals = (b.bestFive ?? []).map(c => rankVal(cardRank(c)));

  for (let i = 0; i < Math.min(aVals.length, bVals.length); i++) {
    if (aVals[i] !== bVals[i]) return aVals[i] - bVals[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Main evaluate function
// ---------------------------------------------------------------------------

/**
 * evaluate(holeCards, boardCards) → HandResult
 *
 * holeCards:  string[2]      e.g. ['As', 'Kh']
 * boardCards: string[3|4|5]  e.g. ['Td','9c','8h']  (flop/turn/river)
 *
 * Combines all cards, generates C(n,5) 5-card combinations, picks the best.
 *
 * Edge case: if total cards < 5, evaluates the best available hand from
 * whatever combinations exist (falling through to evaluateFive with padding
 * is avoided — instead we handle it by evaluating whatever 5-card combos
 * are possible, or if < 5 total, evaluate the hand as-is with available cards).
 */
function evaluate(holeCards, boardCards) {
  const allCards = [...holeCards, ...boardCards];
  const n = allCards.length;

  if (n < 2) {
    throw new Error('evaluate requires at least 2 cards (holeCards)');
  }

  // If we have exactly 5 or fewer cards we still try to find the best hand
  // from all available C(n,5) combinations; if n < 5 we fall back to
  // evaluating all available cards padded — but per task spec this edge
  // case is noted and normal gameplay always has 5+ at showdown.
  // We handle it gracefully: if n >= 5, standard path; if n < 5, evaluate
  // using all cards as a shorter hand (best-effort).

  if (n >= 5) {
    const combos = combinations(allCards, 5);
    let best = null;
    for (const combo of combos) {
      const result = evaluateFive(combo);
      if (best === null || compareHands(result, best) > 0) {
        best = result;
      }
    }
    return best;
  }

  // Fewer than 5 total cards — edge case per task spec.
  // Normal gameplay always has 5+ cards by showdown (2 hole + 3 flop minimum).
  // Best-effort: evaluate the highest hand achievable from the available cards.
  // We evaluate all C(n, min(n,5)) subsets but since n < 5 we just evaluate
  // the n cards as a partial hand using evaluateShort.
  return evaluateShort(allCards);
}

/**
 * evaluateShort(cards) — evaluate a hand with fewer than 5 cards.
 * Used only as a fallback edge case; not called during normal gameplay.
 * Applies the same logic as evaluateFive but skips checks that need 5 cards.
 *
 * ISS-27: flush and straight detection are intentionally omitted — they require
 * exactly 5 cards (or a community board context) and are not meaningful for
 * partial hands. Only pair/trips/quads/high-card rankings are detected here.
 */
function evaluateShort(cards) {
  const sorted = sortDesc(cards);
  const ranks  = sorted.map(cardRank);

  const freq = {};
  for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
  const sortRanksDesc = arr => [...arr].sort((a, b) => rankVal(b) - rankVal(a));
  const quads   = sortRanksDesc(Object.keys(freq).filter(r => freq[r] === 4));
  const trips   = sortRanksDesc(Object.keys(freq).filter(r => freq[r] === 3));
  const pairs   = sortRanksDesc(Object.keys(freq).filter(r => freq[r] === 2));
  const singles = sortRanksDesc(Object.keys(freq).filter(r => freq[r] === 1));

  function cardsOfRank(rankList) {
    const out = [];
    for (const r of rankList) out.push(...sorted.filter(c => cardRank(c) === r));
    return out;
  }

  if (quads.length) {
    const qr = quads[0];
    const kickers = cardsOfRank(singles);
    return makeResult(HAND_RANKS.FOUR_OF_A_KIND, 'FOUR_OF_A_KIND', sorted,
      kickers, `Four of a Kind, ${RANK_DISPLAY[qr]}`);
  }
  if (trips.length && pairs.length) {
    return makeResult(HAND_RANKS.FULL_HOUSE, 'FULL_HOUSE', sorted,
      cardsOfRank([pairs[0]]), `Full House, ${RANK_DISPLAY[trips[0]]} full of ${RANK_DISPLAY[pairs[0]]}`);
  }
  if (trips.length) {
    const kickCards = cardsOfRank(singles);
    return makeResult(HAND_RANKS.THREE_OF_A_KIND, 'THREE_OF_A_KIND', sorted,
      kickCards, `Three of a Kind, ${RANK_DISPLAY[trips[0]]}`);
  }
  if (pairs.length >= 2) {
    const kicker = sorted.find(c => cardRank(c) !== pairs[0] && cardRank(c) !== pairs[1]);
    return makeResult(HAND_RANKS.TWO_PAIR, 'TWO_PAIR', sorted,
      kicker ? [kicker] : [], `Two Pair, ${RANK_DISPLAY[pairs[0]]} and ${RANK_DISPLAY[pairs[1]]}`);
  }
  if (pairs.length === 1) {
    return makeResult(HAND_RANKS.ONE_PAIR, 'ONE_PAIR', sorted,
      cardsOfRank(singles), `One Pair, ${RANK_DISPLAY[pairs[0]]}`);
  }
  return makeResult(HAND_RANKS.HIGH_CARD, 'HIGH_CARD', sorted,
    sorted, `High Card, ${RANK_SINGULAR[ranks[0]]}`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { evaluate, compareHands, HAND_RANKS, evaluateFive };
