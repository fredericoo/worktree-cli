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
import {
  isBareRepo,
  getBareRoot,
  flattenBranchName,
  addWorktree,
  findWorktreeByBranch,
  getWorktreeEntries,
} from '../git';
import { join, relative } from 'path';

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

const CREATE_NEW_BRANCH = '__create_new_branch__';

async function promptForBranch(self: CommandHandler): Promise<number> {
  if (!(await isBareRepo())) {
    console.error(
      'Error: Not in a bare repo. wt checkout only works with bare repo worktree setups.',
    );
    console.error('Run "wt create" first to convert your repo.');
    return 1;
  }

  const { stderrSelect, stderrText, stderrCancel, isCancel } = await import(
    '../interactive.js'
  );

  const bareRoot = await getBareRoot();
  const entries = await getWorktreeEntries(bareRoot);

  const selected = await stderrSelect({
    message: 'Which branch?',
    options: [
      ...entries.map((entry) => {
        const relativePath = relative(bareRoot, entry.path);
        return {
          value: entry.branch,
          label: entry.branch,
          hint: relativePath !== '' ? relativePath : entry.path,
        };
      }),
      {
        value: CREATE_NEW_BRANCH,
        label: 'Create new branch + worktree',
        hint: 'wt co -b <branch>',
      },
    ],
  });

  if (isCancel(selected)) {
    stderrCancel();
    return 0;
  }

  if (selected === CREATE_NEW_BRANCH) {
    const branchName = await stderrText({
      message: 'Branch name:',
      validate: (value) => {
        if (value === undefined || value.trim() === '') return 'Branch name is required';
        return undefined;
      },
    });

    if (isCancel(branchName)) {
      stderrCancel();
      return 0;
    }

    return self.execute(['-b', branchName]);
  }

  return self.execute([selected]);
}

export const command: CommandHandler = {
  name: 'checkout',
  description: 'Create or switch to a worktree for a branch',
  getHelp: () => HELP,

  async execute(args: string[]): Promise<number> {
    const createBranch = args.includes('-b');
    const filteredArgs = args.filter((arg) => arg !== '-b');
    const branch = filteredArgs[0];

    if (branch === undefined || branch === '') {
      if (process.stdin.isTTY !== true) {
        printCommandUsage(HELP);
        return 1;
      }
      return promptForBranch(this);
    }

    if (!(await isBareRepo())) {
      console.error(
        'Error: Not in a bare repo. wt checkout only works with bare repo worktree setups.',
      );
      console.error('Run "wt create" first to convert your repo.');
      return 1;
    }

    const bareRoot = await getBareRoot();

    const existingPath = await findWorktreeByBranch(branch, bareRoot);
    if (existingPath !== null) {
      console.log(existingPath);
      return 0;
    }

    const worktreeDir = flattenBranchName(branch);
    const worktreePath = join(bareRoot, worktreeDir);

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
