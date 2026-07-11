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
const coach = { id: 'coach1', display_name: 'Coach', role: 'coach' };

function tournamentState(t = {}, overrides = {}) {
  return {
    tableId: 't1',
    mode: 'tournament',
    name: 'Friday Turbo',
    status: 'active',
    phase: 'preflop',
    handNo: 4,
    board: [],
    pot: 900,
    currentBet: 400,
    button: 0,
    toAct: 1,
    paused: false,
    awaitingDeal: false,
    actionDeadline: Date.now() + 30_000,
    config: { smallBlind: 100, bigBlind: 200, tableSize: 6 },
    connected: ['me'],
    viewingTableNo: 1,
    seats: [
      { seatIndex: 0, playerId: 'v1', name: 'Villain', stack: 9700, betThisRound: 200,
        folded: false, allIn: false, sittingOut: false, inHand: true, holeCards: null },
      { seatIndex: 1, playerId: 'me', name: 'Hero', stack: 9800, betThisRound: 0,
        folded: false, allIn: false, sittingOut: false, inHand: true, holeCards: ['As', 'Kd'] },
      null, null, null, null,
    ],
    tournament: {
      status: 'running',
      paused: false,
      level: 3,
      smallBlind: 100,
      bigBlind: 200,
      ante: 200,
      msRemaining: 4 * 60_000,
      onBreak: false,
      playersLeft: 9,
      entrants: 12,
      fieldSize: 13,
      avgStack: 14_444,
      prizePool: 130_000,
      payouts: [65_000, 39_000, 26_000],
      handForHand: false,
      scheduledStart: null,
      registered: ['Hero', 'Villain'],
      standings: [
        { playerId: 'v1', name: 'Villain', stack: 9700, rank: 1, tableNo: 1, eliminated: false },
        { playerId: 'me', name: 'Hero', stack: 9800, rank: 2, tableNo: 1, eliminated: false },
      ],
      icm: null,
      deal: null,
      myEntry: {
        registered: true, entries: 1, addon: false,
        finishPosition: null, payout: 0, canReenter: false, canAddon: false,
      },
      ...t,
    },
    ...overrides,
  };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('tournament table (M7 §9)', () => {
  it('shows the top-bar: level, blinds+ante, field, pool — and hides cash-only controls', () => {
    render(<TablePage player={me} table={tournamentState()} onLeft={() => {}} />);
    expect(screen.getByText('Level 3')).toBeTruthy();
    expect(screen.getByText(/100\/200/)).toBeTruthy();
    expect(screen.getByText(/ante 200/)).toBeTruthy();
    expect(screen.getByText('9/12 left')).toBeTruthy();
    expect(screen.getByText('pool 130,000')).toBeTruthy();
    // §8: no sit-out, no leave — the seat is never vacated.
    expect(screen.queryByText('Sit out')).toBeNull();
    expect(screen.queryByText('Leave table')).toBeNull();
    expect(screen.getByText('Back to lobby')).toBeTruthy();
  });

  it('flags hand-for-hand at the bubble', () => {
    render(
      <TablePage player={me} table={tournamentState({ handForHand: true, playersLeft: 4 })}
        onLeft={() => {}} />
    );
    expect(screen.getByText('hand-for-hand')).toBeTruthy();
  });

  it('renders the registration lobby before start with a register button', () => {
    const state = tournamentState(
      {
        status: 'registering',
        myEntry: { registered: false, entries: 0, addon: false, finishPosition: null, payout: 0 },
        registered: ['Villain'],
        playersLeft: 0,
        standings: [],
      },
      { status: 'open', phase: 'waiting', seats: [null, null, null, null, null, null], toAct: null }
    );
    render(<TablePage player={me} table={state} onLeft={() => {}} />);
    expect(screen.getByText('Registration open')).toBeTruthy();
    expect(screen.getByText('Register')).toBeTruthy();
    expect(screen.queryByText('Pot: 0')).toBeNull(); // no board pre-start
  });

  it('offers re-entry to a busted player while the window is open', () => {
    const state = tournamentState(
      { myEntry: { registered: true, entries: 1, addon: false, finishPosition: null, payout: 0, canReenter: true } },
      { seats: [ // Hero no longer seated
        { seatIndex: 0, playerId: 'v1', name: 'Villain', stack: 19500, betThisRound: 0,
          folded: false, allIn: false, sittingOut: false, inHand: false, holeCards: null },
        null, null, null, null, null,
      ], toAct: null }
    );
    render(<TablePage player={me} table={state} onLeft={() => {}} />);
    expect(screen.getByText('You busted.')).toBeTruthy();
    expect(screen.getByText('Re-enter (fresh stack)')).toBeTruthy();
  });

  it('shows the ICM deal banner with my share and accept button', () => {
    const state = tournamentState({
      deal: { amounts: { me: 52_000, v1: 48_000 }, accepted: ['v1'] },
    });
    render(<TablePage player={me} table={state} onLeft={() => {}} />);
    expect(screen.getByText('ICM deal proposed')).toBeTruthy();
    expect(screen.getByText('1/2 accepted')).toBeTruthy();
    expect(screen.getByText('52,000')).toBeTruthy();
    expect(screen.getByText('Accept deal')).toBeTruthy();
  });

  it('coach sees the tournament panel with fast table switching (no grid — §9)', () => {
    const state = tournamentState();
    render(
      <TablePageWithCoachView player={coach} table={state} />
    );
    expect(screen.getByText('Tournament controls')).toBeTruthy();
    expect(screen.getByText('T1 · 5')).toBeTruthy();
    expect(screen.getByText(/T2 · 4/)).toBeTruthy();
    expect(screen.getByText('Pause')).toBeTruthy();
    expect(screen.getByText('Advance level')).toBeTruthy();
    expect(screen.getByText('End early')).toBeTruthy();
    expect(screen.getByText('Disable balance')).toBeTruthy();
  });
});

/**
 * The coach view arrives over the socket in production; render the panel
 * directly with a fixture to keep the test synchronous.
 */
import { TournamentCoachPanel } from '../components/TournamentPanel.jsx';

function TablePageWithCoachView({ player, table }) {
  const coachView = {
    tableId: table.tableId,
    viewTable: 1,
    autoBalance: true,
    paused: false,
    tables: [
      { no: 1, players: 5, handRunning: false,
        seats: [{ playerId: 'v1', name: 'Villain', seatIndex: 0, stack: 9700 }] },
      { no: 2, players: 4, handRunning: true,
        seats: [{ playerId: 'x', name: 'Xena', seatIndex: 2, stack: 12000 }] },
    ],
  };
  return (
    <TournamentCoachPanel
      table={table} coach={coachView} send={() => {}} onEnded={() => {}} onError={() => {}}
    />
  );
}
