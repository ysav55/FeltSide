import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import { resetSocket } from './socket.js';
import Login from './pages/Login.jsx';
import Lobby from './pages/Lobby.jsx';
import TablePage from './pages/TablePage.jsx';
import ReviewPage from './pages/ReviewPage.jsx';

/** /review/:handId — reserved in M3 (CONTRACT §4.4 review_url), filled in M6. */
function reviewHandId() {
  const m = /^\/review\/([A-Za-z0-9-]+)\/?$/.exec(window.location.pathname);
  return m ? m[1] : null;
}

export default function App() {
  const [player, setPlayer] = useState(null);
  const [table, setTable] = useState(null);
  const [booting, setBooting] = useState(Boolean(getToken()));

  // Boot: restore session, and if seated somewhere, return to that table
  // with live state (M2 reconnect rule).
  useEffect(() => {
    if (!getToken()) return;
    (async () => {
      try {
        const { player: me } = await api('/auth/me');
        setPlayer(me);
        if (!me.must_change_password) {
          const { table: seated } = await api('/tables/me');
          if (seated) setTable(seated);
        }
      } catch {
        setToken(null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const handleLogout = useCallback(() => {
    setToken(null);
    resetSocket();
    setPlayer(null);
    setTable(null);
  }, []);

  const handleAuthenticated = useCallback(async (me) => {
    setPlayer(me);
    if (!me.must_change_password) {
      try {
        const { table: seated } = await api('/tables/me');
        if (seated) setTable(seated);
      } catch { /* lobby is fine */ }
    }
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
      <Login player={player} onAuthenticated={handleAuthenticated} onLogout={handleLogout} />
    );
  }

  const handId = reviewHandId();
  if (handId) {
    return <ReviewPage player={player} handId={handId} onLogout={handleLogout} />;
  }

  if (table) {
    return (
      <TablePage
        player={player}
        table={table}
        onLeft={() => setTable(null)}
      />
    );
  }

  return <Lobby player={player} onLogout={handleLogout} onSeated={setTable} />;
}
