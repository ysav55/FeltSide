# 0006 — M2 mechanics the specs are silent on

Small judgment calls made during M2, recorded per the discipline rule.
Veto any and it becomes a one-line change.

1. **Button rotation:** simple rotation — the button advances to the next
   eligible seat each hand; no dead-button/missed-blind bookkeeping in
   cash games. (Tournaments get dead-button rules per TOURNAMENTS §4 in M7.)
2. **Action amounts recorded:** `bet`/`raise` store the total bet-to level
   on that street ("raise to 300"); `call` stores chips added; blind posts
   are recorded as `post_sb`/`post_bb` actions (replay/M6 needs them;
   analyzers skip them). CONTRACT §4.4's sizing-derivability holds.
3. **Mid-hand leaver:** folded immediately, seat held until the hand
   completes (their committed chips stay in the pot), remaining stack
   cashed out at leave time.
4. **Bust seat retention:** a busted player is sat out with the seat held
   until re-buy, leave, or the disconnect-retention cash-out (which
   releases the seat with a zero cash-out).
5. **Walk pot recording:** recorded `pot` is the contested amount after
   uncalled-bet refunds (a walk records pot = the blind money actually won).
