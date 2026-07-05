import React from 'react';
import PlayerSeat from './PlayerSeat';
import GhostSeat from './GhostSeat';
import WatcherIndicator from './WatcherIndicator';
import BoardCards from './BoardCards';
import { fmtChips } from '../utils/chips';

// Absolute seat positions as percentages of the OVAL (seats are now inside the oval div)
// Seat 0 = bottom-center (hero), increasing counter-clockwise
// These are centered via transform: translate(-50%, -50%) on each seat card
const SEAT_POSITIONS = [
  { left: '50%',  top: '94%'  }, // 0  bottom-center (hero)
  { left: '20%',  top: '86%'  }, // 1  bottom-left
  { left: '2%',   top: '55%'  }, // 2  left
  { left: '14%',  top: '16%'  }, // 3  top-left
  { left: '36%',  top: '4%'   }, // 4  top-center-l
  { left: '64%',  top: '4%'   }, // 5  top-center-r
  { left: '86%',  top: '16%'  }, // 6  top-right
  { left: '98%',  top: '55%'  }, // 7  right
  { left: '80%',  top: '86%'  }, // 8  bottom-right
];

// For N players, the SEAT_POSITIONS indices to use — evenly distributed around the table.
// Avoids clustering everyone on one side when seat numbers are consecutive.
const POSITIONS_BY_COUNT = {
  1: [0],
  2: [0, 4],
  3: [0, 3, 6],
  4: [0, 2, 5, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 1, 3, 5, 6, 8],
  7: [0, 1, 3, 4, 5, 6, 8],
  8: [0, 1, 2, 4, 5, 6, 7, 8],
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};

function formatPot(amount) {
  if (amount == null) return '0';
  return Number(amount).toLocaleString('en-US');
}

function Toast({ notification, onDismiss }) {
  return (
    <div
      className="toast-enter flex items-start gap-2 px-3 py-2 rounded-lg shadow-xl cursor-pointer"
      style={{
        background: 'rgba(15, 23, 42, 0.95)',
        border: '1px solid rgba(212,175,55,0.25)',
        backdropFilter: 'blur(8px)',
        maxWidth: 280,
      }}
      onClick={onDismiss}
    >
      <span className="text-xs text-gray-200 leading-snug flex-1">
        {notification.message ?? notification}
      </span>
      <span className="text-gray-500 text-xs shrink-0 mt-0.5">✕</span>
    </div>
  );
}

function ActionTimerBar({ timer }) {
  const [pct, setPct] = React.useState(100);
  React.useEffect(() => {
    if (!timer) return;
    const { startedAt, duration } = timer;
    const update = () => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, duration - elapsed);
      setPct(Math.round((remaining / duration) * 100));
    };
    update();
    const interval = setInterval(update, 200);
    return () => clearInterval(interval);
  }, [timer]);

  const color = pct > 50 ? '#22c55e' : pct > 25 ? '#f59e0b' : '#ef4444';
  return (
    <div style={{ width: 80, height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.2s linear' }} />
    </div>
  );
}

// Import BettingControls lazily — it may not exist yet, guard gracefully
let BettingControls = null;
try {
  // Dynamic require fallback — we attempt to import; in Vite this will be
  // resolved at build time. We wrap in a try/catch so the file compiles
  // even if BettingControls doesn't exist yet.
  BettingControls = React.lazy(() =>
    import('./BettingControls').catch(() => ({ default: () => null }))
  );
} catch (_) {
  BettingControls = () => null;
}

export default function PokerTable({
  gameState,
  myId,
  isCoach = false,
  coachDisconnected = false,
  actionTimer = null,
  emit = {},
  onOpenCardPicker,
  bbView = false,
  bigBlind = 10,
}) {
  // ── Derived state ──────────────────────────────────────────────────────────
  const players        = gameState?.players ?? [];
  const board          = gameState?.board ?? [];
  const phase          = gameState?.phase ?? 'waiting';
  const pot            = gameState?.pot ?? 0;
  const sidePots       = gameState?.side_pots ?? [];
  // centerPot = committed pot from completed streets only.
  // Current-street bets live near each player (via BetChip) until the street closes.
  const centerPot = Math.max(0, pot - players.reduce((s, p) => s + (p.total_bet_this_round ?? 0), 0));
  const isPaused       = gameState?.paused === true;
  const winner         = gameState?.winner ?? null;   // socket ID string or null
  const winnerPlayer   = players?.find(p => p.id === winner);
  const winnerName     = winnerPlayer?.name ?? gameState?.winner_name ?? null;
  const winnerPot      = winner?.amount ?? pot;
  const notifications  = gameState?.notifications ?? [];
  const showdownResult = gameState?.showdown_result ?? null;
  const isShowdown     = phase === 'showdown';
  const isScenario    = gameState?.is_scenario === true;
  const isConfigPhase = gameState?.config_phase === true;

  // Build a Set of winner player ids for quick lookup
  const winnerIds = new Set(
    (showdownResult?.winners ?? []).map((w) => w.playerId)
  );

  // All seated players are visible (coach now has a real seat)
  const visiblePlayers = players;

  // Current turn player id
  const currentTurnId = gameState?.current_player ?? gameState?.current_turn ?? null;

  // Sort players by seat for consistent play-order positioning
  const sortedBySeat = React.useMemo(
    () => [...visiblePlayers].sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0)),
    [visiblePlayers]
  );
  const myIdx = sortedBySeat.findIndex(p => p.id === myId);
  const n = sortedBySeat.length;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function getSeatStyle(player) {
    // Rotate sorted list so viewer is always at index 0 (bottom-center).
    // Then distribute evenly using POSITIONS_BY_COUNT so no side is crowded.
    const playerIdx = sortedBySeat.findIndex(p => p.id === player.id);
    const effectiveMyIdx = myIdx >= 0 ? myIdx : 0;
    const relativeIdx = (playerIdx - effectiveMyIdx + n) % n;
    const positions = POSITIONS_BY_COUNT[n] ?? POSITIONS_BY_COUNT[9];
    const pos = SEAT_POSITIONS[positions[relativeIdx]] ?? SEAT_POSITIONS[0];
    return {
      left: pos.left,
      top: pos.top,
      transform: 'translate(-50%, -50%)',
    };
  }

  // Ghost seat positioning — distributes recorded players around the table.
  // No hero rotation: seats are shown from an observer's perspective.
  function getGhostSeatStyle(seatIndex, totalGhosts) {
    const positions = POSITIONS_BY_COUNT[totalGhosts] ?? POSITIONS_BY_COUNT[9];
    const pos = SEAT_POSITIONS[positions[seatIndex] ?? 0] ?? SEAT_POSITIONS[0];
    return { left: pos.left, top: pos.top, transform: 'translate(-50%, -50%)' };
  }

  function handleHoleCardClick(player, position) {
    if (onOpenCardPicker) {
      onOpenCardPicker({
        type: 'player',
        playerId: player.id,
        position,
      });
    }
  }

  function handleBoardCardClick(position) {
    if (onOpenCardPicker) {
      onOpenCardPicker({ type: 'board', position });
    }
  }

  // ── Pot display ────────────────────────────────────────────────────────────
  const totalSidePots = sidePots.reduce((acc, sp) => acc + (sp.amount ?? 0), 0);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* ── Table container — fills available vertical space ─────────────── */}
      <div className="flex-1 relative flex items-center justify-center min-h-0">
        {/* Oval felt table — sized as % of parent so it adapts to sidebar open/closed */}
        <div
          className="table-felt relative"
          style={{
            width: 'min(75%, 900px)',
            height: 'min(48vh, 500px)',
            borderRadius: '50%',
          }}
        >
          {/* ── Logo watermark — centered on felt, behind everything ─────── */}
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            style={{ zIndex: 0 }}
          >
            <span
              style={{
                fontSize: 48,
                fontWeight: 900,
                letterSpacing: '0.3em',
                color: 'rgba(212,175,55,0.04)',
                userSelect: 'none',
                textTransform: 'uppercase',
              }}
            >
              POKER
            </span>
          </div>
          {/* ── Board cards — top center of oval ────────────────────────── */}
          <div className="absolute top-[18%] left-1/2 -translate-x-1/2">
            <BoardCards
              board={board}
              phase={phase}
              isCoach={isCoach && phase !== 'replay'}
              onCardClick={null}
            />
          </div>

          {/* ── Pot / Winner — sits between board and center of oval ─────── */}
          <div
            className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none"
            style={{ top: '28%', transform: 'translate(-50%, -50%)', zIndex: 2 }}
          >
            {isShowdown ? (
              /* Winner block replaces pot at showdown */
              <div className="flex flex-col items-center gap-1.5 pointer-events-auto">
                <span
                  className="text-[10px] font-black tracking-[0.35em] uppercase leading-none"
                  style={{ color: '#d4af37' }}
                >
                  {showdownResult?.splitPot ? 'SPLIT POT' : 'WINNER'}
                </span>
                {(showdownResult?.winners ?? [{ playerId: winner, playerName: winnerName }]).map((w) => (
                  <span
                    key={w.playerId}
                    className="text-base font-bold tracking-wide leading-tight text-center"
                    style={{ color: '#f0d060', textShadow: '0 0 12px rgba(212,175,55,0.6)' }}
                  >
                    {w.playerName}
                  </span>
                ))}
                {showdownResult?.winners[0]?.handResult?.description && (
                  <span
                    className="text-[10px] font-semibold text-center leading-snug"
                    style={{ color: 'rgba(212,175,55,0.8)' }}
                  >
                    {showdownResult.winners[0].handResult.description}
                  </span>
                )}
                {(showdownResult?.potAwarded ?? 0) > 0 && (
                  <span className="text-[11px] font-mono" style={{ color: 'rgba(212,175,55,0.65)' }}>
                    +{fmtChips(showdownResult.potAwarded, bigBlind, bbView)}
                  </span>
                )}
                {isCoach && (
                  <button
                    className="btn-gold mt-1 px-4 py-1 text-[10px] tracking-widest uppercase"
                    onClick={() => emit.resetHand?.()}
                    style={{ pointerEvents: 'auto' }}
                  >
                    Next Hand
                  </button>
                )}
              </div>
            ) : centerPot > 0 ? (
              <div className="flex flex-col items-center gap-0.5">
                <span
                  className="text-[10px] font-semibold tracking-[0.25em] uppercase"
                  style={{ color: 'rgba(212,175,55,0.55)' }}
                >
                  POT
                </span>
                <span
                  className="text-base font-bold font-mono leading-none"
                  style={{ color: '#d4af37', textShadow: '0 0 10px rgba(212,175,55,0.4)' }}
                >
                  {fmtChips(centerPot, bigBlind, bbView)}
                </span>
                {sidePots.length > 0 && (
                  <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                    {sidePots.map((sp, idx) => {
                      const eligibleNames = sp.eligiblePlayerIds
                        .map(id => gameState.players.find(p => p.id === id)?.name ?? id)
                        .join(', ');
                      return (
                        <div key={idx} style={{ fontSize: 10, color: '#888', background: 'rgba(0,0,0,0.35)', borderRadius: 6, padding: '2px 8px' }}>
                          Pot {idx + 1}: <strong style={{ color: '#d4af37' }}>{fmtChips(sp.amount, bigBlind, bbView)}</strong>
                          <span style={{ marginLeft: 4, opacity: 0.75 }}>({eligibleNames})</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </div>



          {/* ── Replay / Branched badges ─────────────────────────────── */}
          {gameState?.replay_mode?.active && !gameState?.replay_mode?.branched && (
            <div className="absolute bottom-[30%] left-1/2 -translate-x-1/2 pointer-events-none">
              <span className="px-2 py-0.5 text-xs rounded bg-blue-600 text-white font-bold uppercase">
                REPLAY
              </span>
            </div>
          )}
          {gameState?.replay_mode?.branched && (
            <div className="absolute bottom-[30%] left-1/2 -translate-x-1/2 pointer-events-none">
              <span className="px-2 py-0.5 text-xs rounded bg-amber-600 text-white font-bold uppercase">
                BRANCHED
              </span>
            </div>
          )}

          {/* ── Scenario / Drill badges ──────────────────────────────── */}
          {(isScenario || isConfigPhase) && (
            <div className="absolute bottom-[22%] left-1/2 -translate-x-1/2 flex gap-2 pointer-events-none">
              {isScenario && (
                <span
                  className="text-[9px] font-black tracking-[0.3em] uppercase px-2 py-0.5 rounded-full"
                  style={{
                    background: 'rgba(99,102,241,0.2)',
                    color: '#a5b4fc',
                    border: '1px solid rgba(99,102,241,0.4)',
                  }}
                >
                  SCENARIO
                </span>
              )}
              {isConfigPhase && !isScenario && (
                <span
                  className="text-[9px] font-black tracking-[0.3em] uppercase px-2 py-0.5 rounded-full"
                  style={{
                    background: 'rgba(245,158,11,0.2)',
                    color: '#fbbf24',
                    border: '1px solid rgba(245,158,11,0.4)',
                  }}
                >
                  DRILL SETUP
                </span>
              )}
            </div>
          )}

          {/* ── Paused overlay ──────────────────────────────────────────── */}
          {isPaused && (
            <div
              className="absolute inset-0 rounded-[50%] flex items-center justify-center z-20"
              style={{
                background: 'rgba(0,0,0,0.55)',
                backdropFilter: 'blur(3px)',
              }}
            >
              <span
                className="text-2xl font-black tracking-[0.4em] uppercase"
                style={{ color: '#d4af37', textShadow: '0 0 20px rgba(212,175,55,0.5)' }}
              >
                PAUSED
              </span>
            </div>
          )}

          {/* ── Coach Disconnected overlay ──────────────────────────────── */}
          {coachDisconnected && (
            <div
              className="absolute inset-0 rounded-[50%] flex flex-col items-center justify-center z-25"
              style={{
                background: 'rgba(0,0,0,0.7)',
                backdropFilter: 'blur(4px)',
              }}
            >
              <span
                className="text-xl font-black tracking-[0.3em] uppercase mb-1"
                style={{ color: '#ef4444', textShadow: '0 0 20px rgba(239,68,68,0.5)' }}
              >
                COACH OFFLINE
              </span>
              <span className="text-xs tracking-widest" style={{ color: 'rgba(239,68,68,0.7)' }}>
                Reconnecting…
              </span>
            </div>
          )}

          {/* ── Player seats — absolutely positioned relative to the oval ── */}
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 3 }}>
          {(() => {
            const replayMode = gameState?.replay_mode;
            const isNonBranchedReplay = replayMode?.active && !replayMode?.branched;

            if (isNonBranchedReplay) {
              // ── REPLAY MODE: show ghost seats from recorded hand ──────────
              const playerMeta = replayMode.player_meta ?? {};
              const originalHoleCards = replayMode.original_hole_cards ?? {};
              const currentAction = replayMode.current_action;

              // Sort ghost players by their original seat number
              const ghostPlayers = Object.entries(playerMeta)
                .map(([stableId, meta]) => ({ stableId, ...meta }))
                .sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));

              const totalGhosts = ghostPlayers.length;

              return (
                <>
                  {/* Ghost seats for each recorded player */}
                  {ghostPlayers.map((ghost, idx) => {
                    const isCurrentAction = currentAction?.player_id === ghost.stableId;
                    const isCoachSlot = ghost.is_coach === true || String(ghost.stableId).startsWith('coach_');
                    const holeCards = originalHoleCards[ghost.stableId] ?? [];
                    return (
                      <GhostSeat
                        key={ghost.stableId}
                        stableId={ghost.stableId}
                        name={ghost.name}
                        isCoachSlot={isCoachSlot}
                        isCurrentAction={isCurrentAction}
                        holeCards={holeCards}
                        action={isCurrentAction ? currentAction.action : null}
                        style={getGhostSeatStyle(idx, totalGhosts)}
                        bbView={bbView}
                        bigBlind={bigBlind}
                      />
                    );
                  })}

                  {/* Watcher indicators for real seated players */}
                  {visiblePlayers.map((player) => (
                    <WatcherIndicator
                      key={player.id}
                      player={player}
                      isMe={player.id === myId}
                      style={getSeatStyle(player)}
                    />
                  ))}
                </>
              );
            }

            // ── BRANCHED REPLAY: shadow players (is_shadow) play; real players (is_observer) watch ──
            if (replayMode?.active && replayMode?.branched) {
              const shadowPlayers = visiblePlayers.filter(p => p.is_shadow);
              const observerPlayers = visiblePlayers.filter(p => p.is_observer);

              return (
                <>
                  {shadowPlayers.map((player) => {
                    const isCurrentTurn = player.id === currentTurnId;
                    return (
                      <div key={player.id} className="pointer-events-none">
                        <PlayerSeat
                          player={player}
                          isCurrentTurn={isCurrentTurn}
                          isMe={false}
                          isCoach={false}
                          style={getSeatStyle(player)}
                          onHoleCardClick={() => {}}
                          showdownResult={isShowdown ? showdownResult : null}
                          isWinner={isShowdown && winnerIds.has(player.id)}
                          replayMode={replayMode}
                          bbView={bbView}
                          bigBlind={bigBlind}
                          sessionId={null}
                          actionTimer={actionTimer}
                        />
                      </div>
                    );
                  })}
                  {observerPlayers.map((player) => (
                    <WatcherIndicator
                      key={player.id}
                      player={player}
                      isMe={player.id === myId}
                      style={getSeatStyle(player)}
                    />
                  ))}
                </>
              );
            }

            // ── NORMAL: show real player seats ────────────────────────────
            return visiblePlayers.map((player) => {
              const seatStyle = getSeatStyle(player);
              const isCurrentTurn = player.id === currentTurnId;
              const isMe = player.id === myId;
              const isWinner = isShowdown && winnerIds.has(player.id);

              return (
                <div key={player.id} className="pointer-events-auto">
                  <PlayerSeat
                    player={player}
                    isCurrentTurn={isCurrentTurn}
                    isMe={isMe}
                    isCoach={isCoach}
                    style={seatStyle}
                    onHoleCardClick={() => {}}
                    showdownResult={isShowdown ? showdownResult : null}
                    isWinner={isWinner}
                    replayMode={replayMode}
                    bbView={bbView}
                    bigBlind={bigBlind}
                    sessionId={gameState?.session_id ?? null}
                    actionTimer={actionTimer}
                  />
                </div>
              );
            });
          })()}
          </div>{/* closes seats container */}
        </div>{/* closes oval */}
      </div>{/* closes table area */}

      {/* ── Betting / Replay controls — in-flow below the table ─────────── */}
      <div className="relative z-30 flex-shrink-0">
        {gameState?.replay_mode?.active && !gameState?.replay_mode?.branched ? (
          /* ── Replay controls (replaces betting panel during replay) ───── */
          <div style={{
            background: 'rgba(10,14,20,0.97)',
            borderTop: '1px solid rgba(212,175,55,0.18)',
            padding: '10px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}>
            {/* Progress label + scrubber */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '11px', color: '#8b949e', flexShrink: 0 }}>
                {gameState.replay_mode.cursor === -1
                  ? `Start — ${gameState.replay_mode.total_actions} actions`
                  : `${gameState.replay_mode.cursor + 1} / ${gameState.replay_mode.total_actions}`}
              </span>
              {gameState.replay_mode.current_action && (
                <span style={{ fontSize: '11px', color: '#a78bfa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {gameState.replay_mode.current_action.player_name} — {gameState.replay_mode.current_action.street}: {gameState.replay_mode.current_action.action}
                  {gameState.replay_mode.current_action.amount > 0 && ` $${gameState.replay_mode.current_action.amount}`}
                </span>
              )}
              <input
                type="range"
                min={-1}
                max={gameState.replay_mode.total_actions - 1}
                value={gameState.replay_mode.cursor}
                onChange={(e) => emit.replayJumpTo?.(parseInt(e.target.value))}
                style={{ flex: 1, accentColor: '#a78bfa', minWidth: 0 }}
              />
            </div>

            {/* Action row: Back · Fwd · Branch · Exit */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => emit.replayStepBack?.()}
                disabled={gameState.replay_mode.cursor <= -1}
                style={{
                  flex: 1, padding: '7px 0', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
                  background: '#161b22', border: '1px solid #30363d', color: '#a78bfa',
                  opacity: gameState.replay_mode.cursor <= -1 ? 0.4 : 1,
                }}
              >
                ◀ Back
              </button>
              <button
                onClick={() => emit.replayStepFwd?.()}
                disabled={gameState.replay_mode.cursor >= gameState.replay_mode.total_actions - 1}
                style={{
                  flex: 1, padding: '7px 0', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
                  background: '#161b22', border: '1px solid #30363d', color: '#a78bfa',
                  opacity: gameState.replay_mode.cursor >= gameState.replay_mode.total_actions - 1 ? 0.4 : 1,
                }}
              >
                Fwd ▶
              </button>
              {!gameState.replay_mode.branched ? (
                <button
                  onClick={() => emit.replayBranch?.()}
                  style={{
                    flex: 2, padding: '7px 0', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
                    background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b',
                  }}
                >
                  Branch to Live from Here
                </button>
              ) : (
                <button
                  onClick={() => emit.replayUnbranch?.()}
                  style={{
                    flex: 2, padding: '7px 0', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
                    background: 'rgba(245,158,11,0.25)', border: '1px solid rgba(245,158,11,0.6)', color: '#fbbf24',
                  }}
                >
                  Return to Replay
                </button>
              )}
              <button
                onClick={() => emit.replayExit?.()}
                style={{
                  flex: 1, padding: '7px 0', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
                  background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171',
                }}
              >
                Exit Replay
              </button>
            </div>
          </div>
        ) : (
          <React.Suspense fallback={null}>
            {BettingControls && (
              <BettingControls
                gameState={gameState}
                myId={myId}
                isCoach={isCoach}
                emit={emit}
                bbView={bbView}
                bigBlind={bigBlind}
              />
            )}
          </React.Suspense>
        )}
      </div>
    </div>
  );
}
