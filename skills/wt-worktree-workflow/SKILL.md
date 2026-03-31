---
name: wt-worktree-workflow
description: Git worktree management using the wt CLI. Covers converting repos to bare layout, checking out branch worktrees, removing worktrees, and shell integration. Use when user mentions "wt", "worktree", "bare repo", or when managing parallel branch work.
---

# wt Worktree Workflow

Guide for managing git worktrees with the `wt` CLI. Use this when working across multiple branches in parallel.

## One-Time Setup: Convert to Bare Repo

Before using worktrees, convert a standard git repo to the bare+worktree layout:

```bash
cd my-repo
wt create
```

This produces:

```
my-repo/
+-- .bare/     <- shared git database
+-- .git       <- pointer to .bare
+-- main/      <- worktree on default branch
```

Requirements: clean working tree (no uncommitted changes). Untracked files are preserved.

### Shell Integration

Add to your shell startup file for auto-cd on checkout:

```bash
# ~/.zshrc
eval "$(wt init zsh)"

# ~/.bashrc
eval "$(wt init bash)"

# ~/.config/fish/config.fish
wt init fish | source
```

## Daily Workflow

### Check Out a Branch

```bash
# Existing branch — creates worktree if needed, cd's into it
wt co feature-branch

# New branch
wt co -b my-new-feature

# Without shell integration
cd $(wt co feature-branch)
```

Branch names with `/` are flattened to `-` for directory names (e.g., `feature/foo` becomes the directory `feature-foo`).

### List Worktrees

```bash
wt list
```

### Remove a Worktree

```bash
# Remove worktree only (keeps branch)
wt rm feature-branch

# Remove worktree and delete the branch
wt rm feature-branch --delete-branch

# Force removal with uncommitted changes
wt rm feature-branch --force
```

## How It Works

- `wt checkout` prints ONLY the worktree path to stdout. All messages go to stderr.
- The shell wrapper (from `wt init`) captures stdout and `cd`s into it.
- Without shell integration, use `cd $(wt co branch)`.
- Must be inside a bare repo (created by `wt create`) for checkout/remove/list.

## Command Reference

| Command | Description |
|---------|-------------|
| `wt create [dir]` | Convert standard repo to bare+worktree layout |
| `wt checkout <branch>` / `wt co <branch>` | Create or switch to a branch worktree |
| `wt co -b <branch>` | Create worktree for a new branch |
| `wt remove <branch>` / `wt rm <branch>` | Remove a worktree |
| `wt rm <branch> --delete-branch` | Remove worktree and delete the branch |
| `wt rm <branch> --force` | Force removal with uncommitted changes |
| `wt list` | List all worktrees |
| `wt init <bash\|zsh\|fish>` | Output shell wrapper for auto-cd |
