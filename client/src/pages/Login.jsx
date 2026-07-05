import { useState } from 'react';
import { api, setToken } from '../api.js';

export default function Login({ player, onAuthenticated, onLogout }) {
  const forced = Boolean(player?.must_change_password);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submitLogin(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, player: me } = await api('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setToken(token);
      onAuthenticated(me);
    } catch (err) {
      setError(err.message === 'invalid_credentials'
        ? 'Wrong email or password.'
        : 'Login failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitChange(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { player: me } = await api('/auth/change-password', {
        method: 'POST',
        body: { current_password: password, new_password: newPassword },
      });
      onAuthenticated(me);
    } catch (err) {
      if (err.message === 'weak_password') {
        setError(`New password must be at least ${err.body?.min_length ?? 8} characters.`);
      } else if (err.message === 'invalid_credentials') {
        setError('Current password is wrong.');
      } else {
        setError('Could not change password. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
        <h1 className="text-2xl font-semibold text-emerald-400 mb-1">FeltSide</h1>

        {forced ? (
          <>
            <p className="text-slate-400 text-sm mb-4">
              You must set a new password before continuing.
            </p>
            <form onSubmit={submitChange} className="space-y-3">
              <input
                type="password"
                required
                placeholder="Current password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 placeholder-slate-500"
              />
              <input
                type="password"
                required
                placeholder="New password (min 8 characters)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 placeholder-slate-500"
              />
              {error && <p className="text-rose-400 text-sm">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-2 font-medium"
              >
                Set new password
              </button>
              <button
                type="button"
                onClick={onLogout}
                className="w-full text-slate-500 text-sm hover:text-slate-300"
              >
                Back to login
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-slate-400 text-sm mb-4">Sign in to the poker room.</p>
            <form onSubmit={submitLogin} className="space-y-3">
              <input
                type="email"
                required
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 placeholder-slate-500"
              />
              <input
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 placeholder-slate-500"
              />
              {error && <p className="text-rose-400 text-sm">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-2 font-medium"
              >
                Sign in
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
