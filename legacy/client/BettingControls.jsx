import React, { useState, useEffect, useCallback } from 'react';
import { fmtChips } from '../utils/chips';

const ACTIVE_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);

export default function BettingControls({
  gameState,
  myId,
  isCoach,
  emit,
  bbView = false,
  bigBlind = 10,
}) {
  const fmt = (v) => fmtChips(v ?? 0, bigBlind, bbView);
  const player = gameState?.players?.find(p => p.id === myId) ?? null;

  // In branched replay the coach acts for the current shadow player
  const isBranchedReplay = gameState?.is_replay_branch && isCoach;
  const shadowPlayer = isBranchedReplay
    ? (gameState?.players?.find(p => p.id === gameState?.current_turn && p.is_shadow) ?? null)
    : null;

  // Use shadow player stats when coach is acting for them, otherwise use own stats
  const activePlayer = shadowPlayer ?? player;

  // Guard: only render when it's our turn (or coach's shadow turn), active phase, not paused
  const isMyTurn =
    gameState &&
    ACTIVE_PHASES.has(gameState.phase) &&
    !gameState.paused &&
    (
      (player && gameState.current_turn === myId) ||
      (isBranchedReplay && shadowPlayer !== null)
    );

  const currentBet = gameState?.current_bet ?? 0;
  const minRaise = gameState?.min_raise ?? currentBet;
  const pot = gameState?.pot ?? 0;
  const playerStack = activePlayer?.stack ?? 0;
  const playerBetThisRound = activePlayer?.total_bet_this_round ?? 0;

  // How much more the player needs to put in to call
  const toCall = Math.max(0, currentBet - playerBetThisRound);

  // Raise range
  const raiseMin = currentBet + minRaise;
  const raiseMax = playerStack + playerBetThisRound; // all-in amount total
  const effectiveRaiseMin = Math.min(raiseMin, raiseMax);

  const [raiseAmount, setRaiseAmount] = useState(effectiveRaiseMin);
  const [showRaise, setShowRaise] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pendingBet, setPendingBet] = useState(false);

  // Reset pending state whenever server sends a new game state.
  // ISS-60: if the server sends a shallow-equal game_state object (same reference or
  // same content) React may bail out of the re-render and this effect won't fire,
  // leaving pendingBet stuck. In practice the server always sends a fresh object
  // with an updated phase/current_turn, so this is not observed in normal play.
  useEffect(() => { setPendingBet(false); }, [gameState]);

  // Belt-and-suspenders: also reset when isMyTurn becomes false (authoritative signal
  // that the server processed the action), in case the gameState ref didn't change.
  useEffect(() => {
    if (!isMyTurn) {
      setPendingBet(false);
      setShowRaise(false);
    }
  }, [isMyTurn]);

  // Slide-up animation on mount / when it becomes our turn
  useEffect(() => {
    if (isMyTurn) {
      setRaiseAmount(effectiveRaiseMin);
      setShowRaise(false);
      // Trigger animation next tick
      const t = setTimeout(() => setVisible(true), 20);
      return () => clearTimeout(t);
    } else {
      setVisible(false);
    }
  }, [isMyTurn, effectiveRaiseMin]);

  const handleRaiseAmountChange = useCallback((value) => {
    const clamped = Math.max(effectiveRaiseMin, Math.min(raiseMax, Number(value)));
    setRaiseAmount(clamped);
  }, [effectiveRaiseMin, raiseMax]);

  const handleQuickRaise = useCallback((amount) => {
    const clamped = Math.max(effectiveRaiseMin, Math.min(raiseMax, Math.floor(amount)));
    setRaiseAmount(clamped);
  }, [effectiveRaiseMin, raiseMax]);

  const handleFold = () => { setPendingBet(true); emit.placeBet('fold'); };
  const handleCheck = () => { setPendingBet(true); emit.placeBet('check'); };
  const handleCall = () => { setPendingBet(true); emit.placeBet('call'); };
  const handleRaise = () => {
    if (!showRaise) { setShowRaise(true); return; }
    setPendingBet(true);
    emit.placeBet('raise', raiseAmount);
  };

  if (!isMyTurn) return null;

  const canCheck = toCall === 0;
  const canRaise = raiseMax > effectiveRaiseMin;
  const isAllIn = raiseAmount >= raiseMax;
  const raiseValid = raiseAmount >= effectiveRaiseMin && raiseAmount <= raiseMax;

  const thirdPot = Math.round(pot / 3);
  const halfPot  = Math.round(pot / 2);
  const onePot   = pot;
  const twoPot   = pot * 2;

  return (
    <div
      className={`
        w-full flex justify-center
        transition-all duration-300 ease-out
        ${visible ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0'}
      `}
    >
    <div style={{ width: 'min(520px, 96vw)' }}>
      {/* Container panel */}
      <div
        className="mx-auto rounded-t-xl overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, rgba(6,10,15,0.97) 0%, rgba(13,17,23,0.99) 100%)',
          border: '1px solid rgba(212,175,55,0.2)',
          borderBottom: 'none',
          boxShadow: '0 -4px 32px rgba(0,0,0,0.7), 0 -1px 0 rgba(212,175,55,0.1)',
        }}
      >
        {/* Top info bar */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-white/5">
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <span className="label-sm">Stack</span>
              <span className="text-sm font-semibold text-white">{fmt(playerStack)}</span>
            </div>
            <div className="flex flex-col">
              <span className="label-sm">Pot</span>
              <span className="text-sm font-semibold text-gold-400">{fmt(pot)}</span>
            </div>
            {toCall > 0 && (
              <div className="flex flex-col">
                <span className="label-sm">To Call</span>
                <span className="text-sm font-semibold text-blue-400">{fmt(toCall)}</span>
              </div>
            )}
          </div>
          <div className="label-sm text-gold-500/60 tracking-widest">
            {shadowPlayer ? `ACT FOR ${shadowPlayer.name.toUpperCase()}` : 'YOUR TURN'}
          </div>
        </div>

        {/* Raise panel — shown when raise is toggled */}
        {showRaise && canRaise && (
          <div className="px-4 pt-3 pb-2 border-b border-white/5">
            {/* Quick raise buttons */}
            <div className="flex gap-1.5 mb-3">
              {thirdPot >= effectiveRaiseMin && thirdPot <= raiseMax && (
                <button
                  className="flex-1 px-2 py-1 text-xs rounded border border-gold-600/40 text-gold-400 hover:border-gold-500 hover:bg-gold-500/10 transition-all duration-100"
                  onClick={() => handleQuickRaise(thirdPot)}
                >
                  ⅓ Pot
                  <span className="block text-[10px] text-gray-500">{fmt(thirdPot)}</span>
                </button>
              )}
              {halfPot >= effectiveRaiseMin && halfPot <= raiseMax && (
                <button
                  className="flex-1 px-2 py-1 text-xs rounded border border-gold-600/40 text-gold-400 hover:border-gold-500 hover:bg-gold-500/10 transition-all duration-100"
                  onClick={() => handleQuickRaise(halfPot)}
                >
                  ½ Pot
                  <span className="block text-[10px] text-gray-500">{fmt(halfPot)}</span>
                </button>
              )}
              {onePot >= effectiveRaiseMin && onePot <= raiseMax && (
                <button
                  className="flex-1 px-2 py-1 text-xs rounded border border-gold-600/40 text-gold-400 hover:border-gold-500 hover:bg-gold-500/10 transition-all duration-100"
                  onClick={() => handleQuickRaise(onePot)}
                >
                  1x Pot
                  <span className="block text-[10px] text-gray-500">{fmt(onePot)}</span>
                </button>
              )}
              {twoPot >= effectiveRaiseMin && twoPot <= raiseMax && (
                <button
                  className="flex-1 px-2 py-1 text-xs rounded border border-gold-600/40 text-gold-400 hover:border-gold-500 hover:bg-gold-500/10 transition-all duration-100"
                  onClick={() => handleQuickRaise(twoPot)}
                >
                  2x Pot
                  <span className="block text-[10px] text-gray-500">{fmt(twoPot)}</span>
                </button>
              )}
              <button
                className="flex-1 px-2 py-1 text-xs rounded border border-red-700/50 text-red-400 hover:border-red-500 hover:bg-red-500/10 transition-all duration-100"
                onClick={() => handleQuickRaise(raiseMax)}
              >
                All-In
                <span className="block text-[10px] text-gray-500">{fmt(raiseMax)}</span>
              </button>
            </div>

            {/* Slider + input row */}
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={effectiveRaiseMin}
                max={raiseMax}
                step={1}
                value={raiseAmount}
                onChange={(e) => handleRaiseAmountChange(e.target.value)}
                className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, #d4af37 0%, #d4af37 ${
                    raiseMax > effectiveRaiseMin
                      ? ((raiseAmount - effectiveRaiseMin) / (raiseMax - effectiveRaiseMin)) * 100
                      : 100
                  }%, rgba(255,255,255,0.1) ${
                    raiseMax > effectiveRaiseMin
                      ? ((raiseAmount - effectiveRaiseMin) / (raiseMax - effectiveRaiseMin)) * 100
                      : 100
                  }%, rgba(255,255,255,0.1) 100%)`,
                  // Thumb styling is in global CSS or via inline; we'll handle with a style tag concept
                }}
              />
              <div className="flex items-center gap-1 bg-sidebar-800 border border-sidebar-border rounded px-2 py-1 min-w-[72px]">
                <span className="text-gray-500 text-xs">$</span>
                <input
                  type="number"
                  min={effectiveRaiseMin}
                  max={raiseMax}
                  value={raiseAmount}
                  onChange={(e) => handleRaiseAmountChange(e.target.value)}
                  className="w-full bg-transparent text-sm font-mono text-white outline-none text-right"
                  style={{ appearance: 'textfield' }}
                />
              </div>
            </div>

            {/* Raise label */}
            <div className="flex justify-between mt-1.5 text-[10px] text-gray-600">
              <span>Min: {fmt(effectiveRaiseMin)}</span>
              {isAllIn && <span className="text-red-400 font-medium">ALL-IN</span>}
              <span>Max: {fmt(raiseMax)}</span>
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 px-4 py-3">
          {/* FOLD */}
          <button
            className={`flex-1 py-2.5 rounded font-semibold text-sm tracking-wide transition-all duration-150${pendingBet ? ' opacity-50 cursor-not-allowed' : ' active:scale-95'}`}
            style={{
              background: 'rgba(127,29,29,0.4)',
              border: '1px solid rgba(185,28,28,0.4)',
              color: '#fca5a5',
            }}
            onMouseEnter={(e) => {
              if (!pendingBet) {
                e.currentTarget.style.background = 'rgba(153,27,27,0.6)';
                e.currentTarget.style.borderColor = 'rgba(220,38,38,0.5)';
              }
            }}
            onMouseLeave={(e) => {
              if (!pendingBet) {
                e.currentTarget.style.background = 'rgba(127,29,29,0.4)';
                e.currentTarget.style.borderColor = 'rgba(185,28,28,0.4)';
              }
            }}
            disabled={pendingBet}
            onClick={handleFold}
          >
            FOLD
          </button>

          {/* CHECK or CALL */}
          {canCheck ? (
            <button
              className={`flex-1 py-2.5 rounded font-semibold text-sm tracking-wide transition-all duration-150${pendingBet ? ' opacity-50 cursor-not-allowed' : ' active:scale-95'}`}
              style={{
                background: 'rgba(30,58,138,0.5)',
                border: '1px solid rgba(59,130,246,0.35)',
                color: '#93c5fd',
              }}
              onMouseEnter={(e) => {
                if (!pendingBet) {
                  e.currentTarget.style.background = 'rgba(37,99,235,0.55)';
                  e.currentTarget.style.borderColor = 'rgba(96,165,250,0.5)';
                }
              }}
              onMouseLeave={(e) => {
                if (!pendingBet) {
                  e.currentTarget.style.background = 'rgba(30,58,138,0.5)';
                  e.currentTarget.style.borderColor = 'rgba(59,130,246,0.35)';
                }
              }}
              disabled={pendingBet}
              onClick={handleCheck}
            >
              CHECK
            </button>
          ) : (
            <button
              className={`flex-1 py-2.5 rounded font-semibold text-sm tracking-wide transition-all duration-150${pendingBet ? ' opacity-50 cursor-not-allowed' : ' active:scale-95'}`}
              style={{
                background: 'rgba(30,58,138,0.5)',
                border: '1px solid rgba(59,130,246,0.35)',
                color: '#93c5fd',
              }}
              onMouseEnter={(e) => {
                if (!pendingBet) {
                  e.currentTarget.style.background = 'rgba(37,99,235,0.55)';
                  e.currentTarget.style.borderColor = 'rgba(96,165,250,0.5)';
                }
              }}
              onMouseLeave={(e) => {
                if (!pendingBet) {
                  e.currentTarget.style.background = 'rgba(30,58,138,0.5)';
                  e.currentTarget.style.borderColor = 'rgba(59,130,246,0.35)';
                }
              }}
              disabled={pendingBet}
              onClick={handleCall}
            >
              CALL {fmt(toCall)}
            </button>
          )}

          {/* RAISE */}
          {canRaise && (
            <button
              className={`flex-1 py-2.5 rounded font-semibold text-sm tracking-wide transition-all duration-150${(pendingBet || (showRaise && !raiseValid)) ? ' opacity-50 cursor-not-allowed' : ' active:scale-95'}`}
              style={{
                background: showRaise
                  ? 'rgba(161,120,20,0.6)'
                  : 'rgba(133,99,17,0.4)',
                border: showRaise
                  ? '1px solid rgba(212,175,55,0.7)'
                  : '1px solid rgba(212,175,55,0.35)',
                color: '#e8c847',
                boxShadow: showRaise ? '0 0 8px rgba(212,175,55,0.2)' : 'none',
              }}
              onMouseEnter={(e) => {
                if (!showRaise && !pendingBet) {
                  e.currentTarget.style.background = 'rgba(133,99,17,0.6)';
                  e.currentTarget.style.borderColor = 'rgba(212,175,55,0.55)';
                }
              }}
              onMouseLeave={(e) => {
                if (!showRaise && !pendingBet) {
                  e.currentTarget.style.background = 'rgba(133,99,17,0.4)';
                  e.currentTarget.style.borderColor = 'rgba(212,175,55,0.35)';
                }
              }}
              disabled={pendingBet || (showRaise && !raiseValid)}
              onClick={handleRaise}
            >
              {showRaise
                ? `RAISE ${fmt(raiseAmount)}${isAllIn ? ' (ALL-IN)' : ''}`
                : 'RAISE'}
            </button>
          )}
        </div>

        {/* Slider thumb gold styling */}
        <style>{`
          input[type='range']::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #d4af37;
            box-shadow: 0 0 6px rgba(212,175,55,0.5);
            cursor: pointer;
            border: 2px solid #b8962e;
            transition: transform 0.1s;
          }
          input[type='range']::-webkit-slider-thumb:hover {
            transform: scale(1.2);
          }
          input[type='range']::-moz-range-thumb {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #d4af37;
            box-shadow: 0 0 6px rgba(212,175,55,0.5);
            cursor: pointer;
            border: 2px solid #b8962e;
          }
        `}</style>
      </div>
    </div>
    </div>
  );
}
