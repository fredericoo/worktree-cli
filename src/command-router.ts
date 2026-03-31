/**
 * Routes CLI commands to their handlers.
 * Uses lazy loading to keep startup fast.
 */

import type { CommandHandler } from './types';
import { bold, underline, dim, displayWithPager } from './help.js';

interface CommandModule {
  command: CommandHandler;
}

const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  create: () => import('./commands/create'),
  checkout: () => import('./commands/checkout'),
  co: () => import('./commands/checkout'),
  remove: () => import('./commands/remove'),
  rm: () => import('./commands/remove'),
  list: () => import('./commands/list'),
  init: () => import('./commands/init'),
};

export function getAvailableCommands(): string[] {
  return Object.keys(COMMANDS);
}

export async function loadCommand(name: string): Promise<CommandHandler | null> {
  const loader = COMMANDS[name];
  if (loader === undefined) {
    return null;
  }

  const module = await loader();
  return module.command;
}

export async function printHelp(): Promise<void> {
  const helpText = `${bold('NAME')}
  wt - Git worktree manager

${bold('DESCRIPTION')}
  wt manages git worktrees for bare repository workflows. It converts standard
  repos into bare+worktree layouts and provides fast checkout/removal of branch
  worktrees.

  Bare repos keep a single shared .bare/ database with one directory per branch,
  enabling parallel work across branches without stashing or switching.

${bold('COMMANDS')}
  ${underline('Setup')}
    ${underline('create')} ${dim('[directory]')}      Convert a standard git repo to bare+worktree layout
    ${underline('init')} ${dim('<bash|zsh|fish>')}   Output shell wrapper for auto-cd on checkout

  ${underline('Worktree Management')}
    ${underline('checkout')} ${dim('<branch>')}       Create or switch to a worktree for a branch
      ${dim('Aliases: co')}
      -b                   Create a new branch

    ${underline('remove')} ${dim('<branch>')}         Remove a worktree
      ${dim('Aliases: rm')}
      --force              Force removal even with uncommitted changes
      --delete-branch      Also delete the git branch

    ${underline('list')}                   List all worktrees

${bold('SHELL INTEGRATION')}
  wt checkout prints the worktree path to stdout. With shell integration,
  checkout automatically cd's into the worktree:

    ${dim('# Add to ~/.zshrc')}
    eval "$(wt init zsh)"

    ${dim('# Or use without shell integration')}
    cd $(wt co feature-branch)

${bold('BARE REPO STRUCTURE')}
  After running wt create:

    my-repo/
    +-- .bare/     <- git database (shared)
    +-- .git       <- pointer to .bare
    +-- main/      <- worktree on default branch
    +-- feature-x/ <- additional worktrees

${bold('EXAMPLES')}
  ${dim('# One-time setup: convert repo to bare layout')}
  cd my-repo
  wt create

  ${dim('# Work on a branch (creates worktree if needed)')}
  wt co feature-branch

  ${dim('# Create worktree for a new branch')}
  wt co -b my-new-feature

  ${dim('# See all worktrees')}
  wt list

  ${dim('# Clean up when done')}
  wt rm feature-branch
  wt rm feature-branch --delete-branch

${bold('EXIT CODES')}
  0  Success
  1  Error (invalid arguments, not a bare repo, git failure, etc.)
`;

  await displayWithPager(helpText);
}

function extractVersion(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return 'unknown';
  if (!('version' in parsed)) return 'unknown';
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
  const version = record['version'];
  if (typeof version !== 'string') return 'unknown';
  return version;
}

export async function printVersion(): Promise<void> {
  const packageJsonPath = new URL('../package.json', import.meta.url).pathname;
  const raw = await Bun.file(packageJsonPath).text();
  const parsed: unknown = JSON.parse(raw);
  const version = extractVersion(parsed);
  console.log(`wt version ${version}`);
}
