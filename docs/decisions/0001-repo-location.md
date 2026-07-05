# 0001 — FeltSide is a local standalone repo pending GitHub creation

**Context:** M1 Step 0 asks for `git init` + a private GitHub repo named
`FeltSide`. `git init` is done (`/home/user/FeltSide`, branch `main`), but
this session's GitHub integration cannot create repositories (403) and
adding an external repo requires an interactive approval that was not
available.

**Decision:** Per M1 Step 0's fallback, the repo stays local. Jo: create a
private `FeltSide` repo on GitHub (or approve `add_repo` in a session) and
push this directory's `main` branch to it.

**Justification:** Explicitly the prescribed fallback in M1 Step 0; no
guessing involved.
