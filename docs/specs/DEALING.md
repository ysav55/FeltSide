# DEALING.md — Card Control & Dealing Panel Spec (v1)

> Resolves PRD_SKELETON §11.3. This is the make-or-break interaction: the
> coach invents spots on the fly, at a desktop keyboard, with no physical
> deck anywhere. Speed of input is the top design constraint.

---

## 1. Core principles

1. **Partial specification.** The coach specifies only what serves the
   lesson; every untouched slot is RNG-filled at deal time. Dealing 3
   specific hands to a 6-player table is three inputs, not six.
2. **Three input modes, one panel, per-slot.** Type-ahead (default,
   keyboard), deck-grid (click fallback), range-draw (strategic). Modes are
   not a global toggle — each seat/board slot accepts any of them.
3. **The engine owns card integrity.** A card can exist in exactly one
   place. The grid grays dealt cards; type-ahead rejects duplicates; RNG
   fills only from the remaining deck.
4. **Origin is computed, not declared:** all slots untouched → `rng`; all
   specified → `manual`; mixed → `hybrid`; loaded from a scenario →
   `scenario` (CONTRACT §4.4 enum).

## 2. The panel

Lives in the coach sidebar (per the locked visibility rule: chosen cards are
visible ONLY here, never in the shared table UI).

- **Layout:** one row per seat (player name + two card slots + range toggle)
  + a board row (5 slots) + position/button control + action buttons
  (Deal / Re-deal / Save as scenario).
- **Focus model:** `Tab`/`Shift-Tab` walk slots top-to-bottom; clicking a
  slot focuses it; `B` jumps to the board row.

### 2.1 Type-ahead grammar (default)
- Rank keys `A K Q J T 9…2`, suit keys `s h d c`. `Ah` = one card;
  `AhKd` fills both slots of a seat.
- **Rank-only shortcut:** `AK` + `Enter` → suit resolution prompt:
  `s` suited (random suit), `o` offsuit (random suits), `r` fully random,
  or type exact suits. `77` + `Enter` → random suits automatically.
- `Backspace` clears the slot back to RNG. Empty slot = RNG.
- Invalid/duplicate input: inline reject with the reason, focus stays.

### 2.2 Deck grid (click fallback)
Persistent 13×4 grid beside the panel. Click a focused slot, click a card.
Dealt/assigned cards gray out. Touch-friendly, zero memorization.

### 2.3 Range-draw (per-seat toggle)
Toggle a seat from "cards" to "range": opens the RangeMatrix (the carried
gold, same component as the chart editor). At deal time the engine draws
uniformly from the painted range, excluding used cards. The drawn hand is
what appears in the sidebar. Re-deal draws a FRESH sample — repeated drills
become non-memorizable.

## 3. Street-by-street dealing (mandatory v1)

The coach may choose board cards **after** seeing prior-street action.

- Per-hand street policy, set in the panel before or during the hand:
  each of flop/turn/river is `RNG` or `manual` (default: whatever the board
  slots say — a specified slot is manual, an empty one RNG).
- **State machine:** when a betting round closes and the next street is
  `manual` with unfilled slots, the hand enters `awaiting_deal`: players see
  a neutral "dealer is acting" state (no reveal that the coach is choosing);
  the coach's panel focuses the pending slot(s). Action timers are
  suspended during `awaiting_deal`.
- **Escape hatch:** a one-key "RNG the rest of this street / this hand"
  action from the awaiting state — the coach can always release control.
- Pre-staging allowed: turn/river cards may be filled before the flop is
  even dealt; the state machine simply finds them ready.

## 4. Repetition tools (in-panel, not separate features)

- **Re-deal:** repeats the last config immediately — exact cards repeat
  exactly; range-slots re-draw; RNG slots re-randomize. One key.
- **Save as scenario:** snapshots the current config (cards/ranges, board,
  positions, stacks, street policy) into the scenario library with a name —
  playlist-able immediately. The dealing panel and the scenario builder are
  the same data shape; the builder is this panel outside a live hand.

## 5. Coach's own hand

The coach seated as a player uses the same panel row for himself: type his
own cards (he knows them — that's the essence) or leave RNG. Per the locked
visibility rule, a coach's pure-RNG hand shows in the shared UI like anyone
else's and the sidebar reveals nothing about OTHER players' RNG cards.

## 6. Transparency (command decision — veto if wrong)

The shared table UI gives **no indication** whether a hand was dealt
manually or by RNG — a fabricated hand must feel identical to play in.
Origin is visible in review and in the export only. Rationale: students
knowing "this one was rigged" changes their play and kills the drill.

## 7. Explicitly out of v1

- Weighted ranges in range-draw (uniform only).
- Multi-hand queueing ("deal these 5 spots in sequence") — playlists cover
  it.
- Touch-first layout optimization (desktop keyboard is the design target).
