import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import TablePage from '../pages/TablePage.jsx';

vi.mock('../socket.js', () => ({
  getSocket: () => ({
    connected: false,
    on: vi.fn(), off: vi.fn(), emit: vi.fn(),
  }),
  resetSocket: vi.fn(),
}));

const me = { id: 'me', display_name: 'Hero', role: 'player' };

function tableState(overrides = {}) {
  return {
    tableId: 't1',
    name: 'Test table',
    status: 'active',
    phase: 'flop',
    handNo: 3,
    board: ['Ah', '7d', '2c'],
    pot: 600,
    currentBet: 0,
    button: 0,
    toAct: 1,
    actionDeadline: Date.now() + 30_000,
    config: { smallBlind: 50, bigBlind: 100, tableSize: 6 },
    connected: ['me'],
    seats: [
      { seatIndex: 0, playerId: 'v1', name: 'Villain', stack: 9700, betThisRound: 0,
        folded: false, allIn: false, sittingOut: false, inHand: true, holeCards: null },
      { seatIndex: 1, playerId: 'me', name: 'Hero', stack: 9700, betThisRound: 0,
        folded: false, allIn: false, sittingOut: false, inHand: true, holeCards: ['As', 'Kd'] },
      null, null, null, null,
    ],
    ...overrides,
  };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TablePage', () => {
  it('renders board, pot, seats, and my hole cards', () => {
    render(<TablePage player={me} table={tableState()} onLeft={() => {}} />);
    expect(screen.getByText('Pot: 600')).toBeTruthy();
    expect(screen.getByText('Hero (you)')).toBeTruthy();
    expect(screen.getByText('Villain')).toBeTruthy();
    // My hole cards visible (As Kd) — ace of spades rendered
    expect(screen.getAllByText('♠').length).toBeGreaterThan(0);
    expect(screen.getByText('Sit out')).toBeTruthy();
    expect(screen.getByText('Leave table')).toBeTruthy();
  });

  it('shows betting controls only on my turn', () => {
    const { rerender } = render(
      <TablePage player={me} table={tableState({ toAct: 0 })} onLeft={() => {}} />
    );
    expect(screen.queryByText('Fold')).toBeNull();
    cleanup();
    render(<TablePage player={me} table={tableState({ toAct: 1 })} onLeft={() => {}} />);
    expect(screen.getByText('Fold')).toBeTruthy();
    expect(screen.getByText('Check')).toBeTruthy(); // no bet to call
    expect(screen.getByText('Bet')).toBeTruthy();
    void rerender;
  });

  it('offers the re-buy flow when busted', () => {
    const busted = tableState({
      toAct: 0,
      seats: [
        { seatIndex: 0, playerId: 'v1', name: 'Villain', stack: 19400, betThisRound: 0,
          folded: false, allIn: false, sittingOut: false, inHand: true, holeCards: null },
        { seatIndex: 1, playerId: 'me', name: 'Hero', stack: 0, betThisRound: 0,
          folded: false, allIn: false, sittingOut: true, inHand: false, holeCards: null },
        null, null, null, null,
      ],
    });
    render(<TablePage player={me} table={busted} onLeft={() => {}} />);
    expect(screen.getByText(/You busted/)).toBeTruthy();
    expect(screen.getByText('Re-buy')).toBeTruthy();
  });
});
