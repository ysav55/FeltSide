import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import App from '../App.jsx';
import Lobby from '../pages/Lobby.jsx';

function mockFetch(routes) {
  return vi.fn(async (url) => {
    for (const [path, payload] of Object.entries(routes)) {
      if (url.endsWith(path)) {
        return { ok: true, status: 200, json: async () => payload };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('App', () => {
  it('shows the login screen when unauthenticated', () => {
    render(<App />);
    expect(screen.getByPlaceholderText('Email')).toBeTruthy();
    expect(screen.getByPlaceholderText('Password')).toBeTruthy();
    expect(screen.getByText('Sign in')).toBeTruthy();
  });
});

describe('Lobby', () => {
  const player = { id: 'p1', display_name: 'Dana K', role: 'player' };

  it('renders empty tables state and bankroll balance', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/tables': { data: [] },
      '/api/bankroll/me': { balance: 5000, transactions: [] },
    }));
    render(<Lobby player={player} onLogout={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/No tables yet/)).toBeTruthy();
      expect(screen.getByText('5,000')).toBeTruthy();
    });
    expect(screen.queryByText('Admin')).toBeNull(); // players get no drawer
  });

  it('shows the admin button for the coach', async () => {
    vi.stubGlobal('fetch', mockFetch({
      '/api/tables': { data: [] },
      '/api/bankroll/me': { balance: 0, transactions: [] },
    }));
    render(<Lobby player={{ ...player, role: 'coach' }} onLogout={() => {}} />);
    await waitFor(() => expect(screen.getByText('Admin')).toBeTruthy());
  });
});
