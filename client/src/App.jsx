import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Lobby from './pages/Lobby.jsx';

export default function App() {
  const [player, setPlayer] = useState(null);
  const [booting, setBooting] = useState(Boolean(getToken()));

  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me')
      .then(({ player: me }) => setPlayer(me))
      .catch(() => setToken(null))
      .finally(() => setBooting(false));
  }, []);

  const handleLogout = useCallback(() => {
    setToken(null);
    setPlayer(null);
  }, []);

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  if (!player || player.must_change_password) {
    return (
      <Login
        player={player}
        onAuthenticated={setPlayer}
        onLogout={handleLogout}
      />
    );
  }

  return <Lobby player={player} onLogout={handleLogout} />;
}
