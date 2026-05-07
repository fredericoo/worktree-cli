/**
 * wt remove / wt rm - Remove a worktree and optionally its branch.
 */

import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { printCommandUsage } from '../help.js';
import {
  isBareRepo,
  getBareRoot,
  findWorktreeByBranch,
  removeWorktree,
  deleteBranch,
  getWorktreeEntries,
} from '../git';
import { relative } from 'path';

const HELP: CommandHelp = {
  name: 'wt remove',
  synopsis: 'wt remove [--force] [--delete-branch] <branch>',
  description: `Remove a worktree for a branch.

The worktree is found by querying git's worktree registry, so it works
regardless of where the worktree directory lives on disk.`,

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

const FLAG_NAMES = new Set(['--force', '-f', '--delete-branch']);

function extractFlags(args: string[]): string[] {
  return args.filter((arg) => FLAG_NAMES.has(arg));
}

async function promptForWorktree(self: CommandHandler, flags: string[]): Promise<number> {
  if (!(await isBareRepo())) {
    console.error(
      'Error: Not in a bare repo. wt remove only works with bare repo worktree setups.',
    );
    return 1;
  }

  const { stderrSelect, stderrCancel, stderrLog, isCancel } = await import(
    '../interactive.js'
  );

  const bareRoot = await getBareRoot();
  const entries = await getWorktreeEntries(bareRoot);

  if (entries.length === 0) {
    stderrLog.warn('No worktrees to remove.');
    return 1;
  }

  const selected = await stderrSelect({
    message: 'Which worktree to remove?',
    options: entries.map((entry) => {
      const relativePath = relative(bareRoot, entry.path);
      return {
        value: entry.branch,
        label: entry.branch,
        hint: relativePath !== '' ? relativePath : entry.path,
      };
    }),
  });

  if (isCancel(selected) || typeof selected !== 'string') {
    stderrCancel();
    return 0;
  }

  return self.execute([...flags, selected]);
}

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
      if (process.stdin.isTTY !== true) {
        printCommandUsage(HELP);
        return 1;
      }
      return promptForWorktree(this, extractFlags(args));
    }

    if (!(await isBareRepo())) {
      console.error(
        'Error: Not in a bare repo. wt remove only works with bare repo worktree setups.',
      );
      return 1;
    }

    const bareRoot = await getBareRoot();

    const worktreePath = await findWorktreeByBranch(branch, bareRoot);
    if (worktreePath === null) {
      console.error(`Error: No worktree found for branch '${branch}'`);
      return 1;
    }

    try {
      await removeWorktree(worktreePath, { force, cwd: bareRoot });
      console.error(`Removed worktree: ${branch}`);
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
