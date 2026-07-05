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
2. **This is a clean rebuild.** Nothing from the old codebase enters
   except through `legacy/` per `legacy/LEGACY_MANIFEST.md`, under the
   "proven good" bar defined in PRD §9. `legacy/` is a customs zone, not a
   warehouse: modules graduate out of it with new tests, and the folder is
   deleted empty by the end of M7.
3. **Build order is PRD §11 (M1–M7).** One milestone at a time; each ends
   runnable and testable. Milestone prompts live in `prompts/`.
4. **Deviations are documented.** Any departure from a prompt or spec goes
   in `docs/decisions/` with a one-line justification, ADR-style.

## Layout

```
docs/            PRD + binding specs + decision log
legacy/          adopted old modules in transit (see LEGACY_MANIFEST.md)
prompts/         milestone prompts for implementation agents
server/          Node + socket.io engine
client/          React client
```
