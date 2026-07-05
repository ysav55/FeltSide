# 0001 — FeltSide lives inside the poker-trainer repo for now

**Context:** M1 Step 0 asks for `git init` + a private GitHub repo named
`FeltSide`. This implementation session is hard-scoped to the
`ysav55/poker-trainer` repository (branch
`claude/feltside-bootstrap-setup-6ba75x`) — it cannot create or push to any
other repository.

**Decision:** Build FeltSide as the `FeltSide/` directory inside
poker-trainer on the designated branch, using M1's own fallback ("stay
local and tell Jo to create/push later"). Jo: create the private `FeltSide`
repo and lift this directory out (its history is contained in this branch).

**Justification:** The only path that preserves the work durably under the
session's push constraints; explicitly permitted by M1 Step 0's fallback.
