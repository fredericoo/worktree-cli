---
"worktree-cli": minor
---

Initial release of worktree-cli (`wt`).

- `wt create` — convert standard git repos to bare+worktree layout
- `wt checkout` / `wt co` — create or switch to branch worktrees
- `wt remove` / `wt rm` — remove worktrees with optional branch deletion
- `wt list` — list all worktrees
- `wt init` — shell integration for auto-cd on checkout
- Rollback on partial failure during conversion
- Bundled agent skill via skills-npm convention
