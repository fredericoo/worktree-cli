---
"worktree-cli": patch
---

`wt rm` and `wt prune` no longer time out while removing large worktrees. Removal used the 10 second timeout every git command shares, so deleting a worktree with a big `node_modules` was killed partway, leaving a half-deleted directory that git still registered and that needed `git worktree remove --force` to clean up.
