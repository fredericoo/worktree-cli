---
"worktree-cli": minor
---

Detect missing remote URL before fetching when creating new branches. When no remote URL is configured, `wt co -b` now falls back to HEAD with a clear message instead of leaking confusing git errors. `--from` falls back to local branches when no remote is available.
