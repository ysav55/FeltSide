import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { buildReplay } from '../utils/replay.js';
import ReviewPage from '../pages/ReviewPage.jsx';

const HAND = {
  handId: 'hnd-abc-123',
  origin: 'manual', revision: 1, pot: 600,
  board: ['Ah', 'Kd', '2c', '7s', '9h'],
  participants: [
    { playerId: 'p1', name: 'Dana', position: 'BTN', holeCards: ['As', 'Ks'], stackStart: 1000, stackEnd: 1300, isWinner: true },
    { playerId: 'p2', name: 'Ben', position: 'BB', holeCards: ['Qs', 'Qd'], stackStart: 1000, stackEnd: 700, isWinner: false },
  ],
  actions: [
    { seq: 1, playerId: 'p1', street: 'preflop', action: 'post_sb', amount: 50, reverted: false },
    { seq: 2, playerId: 'p2', street: 'preflop', action: 'post_bb', amount: 100, reverted: false },
    { seq: 3, playerId: 'p1', street: 'preflop', action: 'raise', amount: 300, reverted: false },
    { seq: 4, playerId: 'p2', street: 'preflop', action: 'call', amount: 200, reverted: false },
    { seq: 5, playerId: 'p2', street: 'flop', action: 'check', amount: 0, reverted: false },
    { seq: 6, playerId: 'p1', street: 'flop', action: 'check', amount: 0, reverted: false },
  ],
  tags: [{ id: 1, tag: 'SINGLE_RAISED_POT', tagType: 'descriptor', playerId: null, actionSeq: null, dismissed: false }],
  annotations: [],
};

afterEach(cleanup);

describe('client replay util', () => {
  it('reconstructs pot/board/stacks per step, matching the server model', () => {
    const r = buildReplay(HAND);
    expect(r.frameCount).toBe(7);
    expect(r.frameAt(0).pot).toBe(0);
    expect(r.frameAt(4).pot).toBe(600);
    expect(r.frameAt(4).board).toEqual([]);
    expect(r.frameAt(5).board).toEqual(['Ah', 'Kd', '2c']);
    expect(r.frameAt(4).seats.find((s) => s.playerId === 'p1').stack).toBe(700);
    expect(r.cursorForSeq(3)).toBe(3);
    expect(r.streetCursors().flop).toBe(5);
  });
});

describe('ReviewPage', () => {
  const coach = { id: 'c1', display_name: 'Jo', role: 'coach' };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith(`/api/hands/${HAND.handId}`)) {
        return { ok: true, status: 200, json: async () => ({ hand: HAND }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the replay, shows all hole cards, and steps forward', async () => {
    render(<ReviewPage player={coach} handId={HAND.handId} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText(/origin manual/)).toBeTruthy());

    // Open-kimono: both players' hole cards render (find rank spans).
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
    expect(screen.getByText('SINGLE_RAISED_POT')).toBeTruthy();

    // Step to the end via the action log (click action seq 4 → pot 600).
    expect(screen.getByText('Pot: 0')).toBeTruthy();
    fireEvent.click(screen.getByText('Fwd ▶'));
    await waitFor(() => expect(screen.queryByText('Pot: 0')).toBeNull());
  });
});
