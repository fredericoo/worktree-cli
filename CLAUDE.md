# wt - Git Worktree Manager CLI

CLI tool for managing git worktrees with bare repository workflows. Converts standard repos to bare+worktree layouts and provides fast worktree checkout/removal.

## Installation

```bash
bun install
bun link
eval "$(wt init zsh)"  # Add to ~/.zshrc
```

## Commands

| Command | Description |
|---------|-------------|
| `wt create [dir]` | Convert standard repo to bare+worktree layout |
| `wt checkout <branch>` / `wt co` | Create or switch to a branch worktree |
| `wt co -b <branch>` | Create worktree for a new branch |
| `wt remove <branch>` / `wt rm` | Remove a worktree |
| `wt rm <branch> --delete-branch` | Remove worktree and delete the branch |
| `wt list` | List all worktrees |
| `wt init <bash\|zsh\|fish>` | Output shell wrapper for auto-cd |

## Architecture

### Bare Repo Layout

After `wt create`, a repo looks like:

```
my-repo/
+-- .bare/        <- shared git database
+-- .git          <- gitfile pointing to .bare
+-- main/         <- worktree on default branch
+-- feature-x/    <- additional worktrees
```

### stdout/stderr Contract

`wt checkout` outputs ONLY the worktree path to stdout. All human-readable messages go to stderr. This enables `cd $(wt co branch)` and the shell wrapper pattern in `wt init`.

### Module Structure

- **`src/git.ts`** — Deep module hiding all git operations behind a simple interface. Single `spawnGit` function owns all Bun.spawn + timeout + Promise.race logic.
- **`src/help.ts`** — CLI-generic help system with ANSI formatting, NO_COLOR support, pager via `less -R`.
- **`src/command-router.ts`** — Lazy command loading via dynamic imports for fast startup.
- **`src/commands/`** — One file per command, each exporting a `CommandHandler`.

### Rollback Safety

`wt create` performs destructive filesystem mutations. The conversion sequence is wrapped in try/catch with:
- SIGINT/SIGTERM handlers for interrupt safety
- Temp dir created inside the repo (avoids EXDEV cross-device rename on Linux)
- Temp dir path logged to stderr before moving files
- Rollback reverses `.bare` → `.git` rename and `core.bare` config

## Development

```bash
bun run test        # Run all tests
bun run lint        # oxlint with type-aware rules
bun run lint:fix    # Auto-fix lint issues
bun run fmt         # Format with oxfmt
bun run fmt:check   # Check formatting
bun run typecheck   # TypeScript type checking
```

## Testing

Tests are co-located: `src/foo.ts` → `src/foo.test.ts`. Shared test infrastructure lives in `src/test-scaffold.ts`.

Integration tests create real git repos in temp directories, run the CLI as a subprocess, and assert on filesystem state.

## Tooling

- **Linter**: oxlint with type-aware rules (strict: no-any, no type assertions, max-depth 3, complexity 12)
- **Formatter**: oxfmt (Prettier-compatible)
- **Type checker**: TypeScript with all strict flags
- **VS Code**: `.vscode/settings.json` configures format-on-save with the Oxc extension

## Skills

This package bundles a `skills/wt-worktree-workflow/` skill for coding agents via the skills-npm convention.
