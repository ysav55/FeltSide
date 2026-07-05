const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['h', 'd', 'c', 's'];

const SUIT_NAMES = { h: 'Hearts', d: 'Diamonds', c: 'Clubs', s: 'Spades' };
const RANK_NAMES = { T: '10', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };

function createDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function isValidCard(card) {
  if (typeof card !== 'string' || card.length !== 2) return false;
  return RANKS.includes(card[0]) && SUITS.includes(card[1]);
}

/**
 * Returns the Set of all cards currently committed to players or the board.
 */
function getUsedCards(state) {
  const used = new Set();
  for (const player of state.players) {
    for (const card of player.hole_cards) {
      if (card && card !== 'HIDDEN') used.add(card);
    }
  }
  for (const card of state.board) {
    if (card) used.add(card);
  }
  return used;
}

module.exports = { createDeck, shuffleDeck, isValidCard, getUsedCards, RANKS, SUITS };
