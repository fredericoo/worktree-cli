/**
 * wt remove / wt rm - Remove a worktree and optionally its branch.
 */

import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { printCommandUsage } from '../help.js';
import { isBareRepo, getBareRoot, flattenBranchName, removeWorktree, deleteBranch } from '../git';
import { join } from 'path';
import { stat } from 'fs/promises';

const HELP: CommandHelp = {
  name: 'wt remove',
  synopsis: 'wt remove [--force] [--delete-branch] <branch>',
  description: `Remove a worktree for a branch.

The worktree directory is identified by flattening the branch name
(replacing / with -) and looking for it in the bare repo root.`,

  flags: [
    { flag: '--force, -f', description: 'Force removal even with uncommitted changes' },
    {
      flag: '--delete-branch',
      description: 'Also delete the git branch after removing the worktree',
    },
  ],

  examples: [
    '# Remove a worktree',
    'wt rm feature-branch',
    '',
    '# Force removal and delete the branch',
    'wt rm feature-branch --force --delete-branch',
  ],

  notes: [
    'Must be run from within a bare repo (created by wt create).',
    'Use --delete-branch to also delete the git branch (destructive).',
  ],
};

export const command: CommandHandler = {
  name: 'remove',
  description: 'Remove a worktree',
  getHelp: () => HELP,

  async execute(args: string[]): Promise<number> {
    const force = args.includes('--force') || args.includes('-f');
    const shouldDeleteBranch = args.includes('--delete-branch');
    const positionalArgs = args.filter(
      (arg) => arg !== '--force' && arg !== '-f' && arg !== '--delete-branch',
    );

    const branch = positionalArgs[0];

    if (branch === undefined || branch === '') {
      printCommandUsage(HELP);
      return 1;
    }

    if (!(await isBareRepo())) {
      console.error(
        'Error: Not in a bare repo. wt remove only works with bare repo worktree setups.',
      );
      return 1;
    }

    const bareRoot = await getBareRoot();
    const worktreeDir = flattenBranchName(branch);
    const worktreePath = join(bareRoot, worktreeDir);

    try {
      await stat(worktreePath);
    } catch {
      console.error(`Error: No worktree found at ${worktreePath}`);
      return 1;
    }

    try {
      await removeWorktree(worktreePath, { force, cwd: bareRoot });
      console.error(`Removed worktree: ${worktreeDir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error removing worktree: ${message}`);
      return 1;
    }

    if (shouldDeleteBranch) {
      try {
        await deleteBranch(branch, bareRoot);
        console.error(`Deleted branch: ${branch}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Warning: worktree removed but branch deletion failed: ${message}`);
        return 1;
      }
    }

    return 0;
  },
};
