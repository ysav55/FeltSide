# FeltSide

The poker game engine of a two-product system: live coached tables,
autonomous cash games, MTT tournaments, hand recording + auto-tagging,
replay/review. The companion product is **epoker-crm** (student registry
and analytics), integrated per `docs/specs/CONTRACT.md`.

## The rules of this repo

1. **`docs/` is the constitution.** `docs/PRD.md` is the master document;
   everything under `docs/specs/` is a binding part of it. When code and
   spec disagree, the spec wins. When the spec is silent, stop and ask —
   never guess.
2. **This is a clean rebuild.** Nothing from the old codebase entered
   except through the (now retired) `legacy/` customs zone, under the
   "proven good" bar defined in PRD §9. The reuse program closed in M8:
   every module either graduated with new tests or was deleted with a
   decision entry (docs/decisions/0012).
3. **Build order is PRD §11 (M1–M8).** One milestone at a time; each ends
   runnable and testable. Milestone prompts live in `prompts/`.
4. **Deviations are documented.** Any departure from a prompt or spec goes
   in `docs/decisions/` with a one-line justification, ADR-style.

## Layout

```
docs/            PRD + binding specs + decision log
prompts/         milestone prompts for implementation agents
server/          Node + socket.io engine
client/          React client
```
