# worktree-cli

## 0.3.0

### Minor Changes

- Base new branches off `origin/main` (fetched fresh) by default instead of the stale local HEAD. Add `--from <branch>` flag to `wt co -b` to specify a different remote branch as the base.

- Add interactive branch selection when running `wt co` without arguments. Uses @clack/prompts for a TUI picker with branch list and "create new branch" option.

## 0.2.0

### Minor Changes

- [`65f6896`](https://github.com/fredericoo/worktree-cli/commit/65f689657e7cfd95209d5dbc54eccfaae7591a7a) Thanks [@fredericoo](https://github.com/fredericoo)! - Initial release of worktree-cli (`wt`).

  - `wt create` — convert standard git repos to bare+worktree layout
  - `wt checkout` / `wt co` — create or switch to branch worktrees
  - `wt remove` / `wt rm` — remove worktrees with optional branch deletion
  - `wt list` — list all worktrees
  - `wt init` — shell integration for auto-cd on checkout
  - Rollback on partial failure during conversion
  - Bundled agent skill via skills-npm convention
