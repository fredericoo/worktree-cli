/**
 * wt checkout / wt co - Create or switch to a worktree for a branch.
 * Replicates tco from ~/.config/shell/git-worktree-tools.sh
 *
 * stdout: ONLY the worktree path (for shell integration cd).
 * stderr: all human-readable messages.
 */

import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { printCommandUsage } from '../help.js';
import { isBareRepo, getBareRoot, flattenBranchName, addWorktree } from '../git';
import { join } from 'path';
import { stat } from 'fs/promises';

const HELP: CommandHelp = {
  name: 'wt checkout',
  synopsis: 'wt checkout [-b] <branch>',
  description: `Create or switch to a worktree for a branch.

If a worktree for the branch already exists, prints its path.
If not, creates a new worktree and prints the path.

Use -b to create a new branch (equivalent to git worktree add -b).

Prints ONLY the worktree path to stdout for shell integration.
With shell integration (wt init zsh), checkout auto-cd's into the worktree.`,

  flags: [
    { flag: '-b', description: 'Create a new branch instead of checking out an existing one' },
  ],

  examples: [
    '# Checkout existing branch',
    'wt co feature-branch',
    '',
    '# Create new branch',
    'wt co -b my-new-feature',
    '',
    '# Use without shell integration',
    'cd $(wt co feature-branch)',
  ],

  notes: [
    'Must be run from within a bare repo (created by wt create).',
    'Branch names with / are flattened to - for directory names.',
  ],
};

export const command: CommandHandler = {
  name: 'checkout',
  description: 'Create or switch to a worktree for a branch',
  getHelp: () => HELP,

  async execute(args: string[]): Promise<number> {
    const createBranch = args.includes('-b');
    const filteredArgs = args.filter((arg) => arg !== '-b');
    const branch = filteredArgs[0];

    if (branch === undefined || branch === '') {
      printCommandUsage(HELP);
      return 1;
    }

    if (!(await isBareRepo())) {
      console.error(
        'Error: Not in a bare repo. wt checkout only works with bare repo worktree setups.',
      );
      console.error('Run "wt create" first to convert your repo.');
      return 1;
    }

    const bareRoot = await getBareRoot();
    const worktreeDir = flattenBranchName(branch);
    const worktreePath = join(bareRoot, worktreeDir);

    try {
      const info = await stat(worktreePath);
      if (info.isDirectory()) {
        console.log(worktreePath);
        return 0;
      }
    } catch {
      // Directory doesn't exist — create it below
    }

    try {
      await addWorktree(worktreePath, branch, { createBranch, cwd: bareRoot });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error: ${message}`);
      return 1;
    }

    console.log(worktreePath);
    return 0;
  },
};
