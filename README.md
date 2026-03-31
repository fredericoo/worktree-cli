# worktree-cli (`wt`)

Fast git worktree management. Convert repos to bare+worktree layouts and switch between branches instantly.

## Why

Git worktrees let you work on multiple branches simultaneously without stashing or switching. But the setup is manual and error-prone. `wt` automates the entire workflow:

```bash
# One-time: convert your repo
cd my-repo && wt create

# Daily: jump between branches
wt co feature-branch    # creates worktree if needed, cd's into it
wt co -b new-feature    # new branch + worktree
wt rm old-branch        # clean up
```

Each branch gets its own directory sharing a single `.bare/` git database.

## Install

Requires [Bun](https://bun.sh):

```bash
bun install -g worktree-cli
```

### Shell integration (recommended)

Add to your shell startup file for auto-cd on checkout:

```bash
# zsh (~/.zshrc)
eval "$(wt init zsh)"

# bash (~/.bashrc)
eval "$(wt init bash)"

# fish (~/.config/fish/config.fish)
wt init fish | source
```

Without shell integration, use `cd $(wt co branch)`.

## Commands

### `wt create [directory]`

Convert a standard git repo to bare+worktree layout:

```
my-repo/             my-repo/
├── .git/        →   ├── .bare/     ← shared git database
├── src/             ├── .git       ← pointer to .bare
└── README.md        └── main/      ← worktree on default branch
                         ├── src/
                         └── README.md
```

Preserves untracked files. Rolls back automatically on failure.

### `wt checkout <branch>` (alias: `wt co`)

Create or switch to a worktree. If the worktree already exists, switches to it. If not, creates it.

```bash
wt co feature-branch       # existing branch
wt co -b my-new-feature    # new branch
```

Branch names with `/` are flattened to `-` for directory names (`feature/foo` → `feature-foo`).

### `wt remove <branch>` (alias: `wt rm`)

Remove a worktree:

```bash
wt rm feature-branch                    # remove worktree, keep branch
wt rm feature-branch --delete-branch    # remove worktree + branch
wt rm feature-branch --force            # force removal
```

### `wt list`

List all worktrees in the bare repo.

### `wt init <bash|zsh|fish>`

Output a shell wrapper function for auto-cd on checkout.

## Agent skills

This package bundles a skill at `skills/wt-worktree-workflow/` for coding agents via the [skills-npm](https://github.com/antfu/skills-npm) convention.

## License

MIT
