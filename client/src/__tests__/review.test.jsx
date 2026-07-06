import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import App from '../App.jsx';
import ReviewPage from '../pages/ReviewPage.jsx';

// M3: /review/:handId is reserved now because exported review_urls are
// permanent (CONTRACT §4.4). M6 replaces the placeholder with the replay UI.

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

describe('ReviewPage placeholder', () => {
  const player = { id: 'p1', display_name: 'Dana K', role: 'player' };

  it('shows the hand id and a way back to the lobby', () => {
    render(<ReviewPage player={player} handId="hnd-123" onLogout={() => {}} />);
    expect(screen.getByText('Hand review')).toBeTruthy();
    expect(screen.getByText('hnd-123')).toBeTruthy();
    expect(screen.getByText('Back to lobby')).toBeTruthy();
  });
});

describe('App routing', () => {
  it('renders the review placeholder for /review/:handId after auth', async () => {
    localStorage.setItem('feltside_token', 'tok');
    window.history.pushState({}, '', '/review/abc-def-123');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('/api/auth/me')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            player: { id: 'p1', display_name: 'Dana K', role: 'player', must_change_password: false },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ table: null }) };
    }));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Hand review')).toBeTruthy();
      expect(screen.getByText('abc-def-123')).toBeTruthy();
    });
  });
});
