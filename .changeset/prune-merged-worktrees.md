---
"worktree-cli": minor
---

Add `wt prune` to remove worktrees whose attached GitHub PR is merged at the local HEAD. GitHub PR checks are batched and concurrency-limited with Effect so pruning can give progress feedback without spamming the GitHub API.
