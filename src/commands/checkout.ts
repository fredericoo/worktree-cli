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
  fetchRef,
  refExists,
} from '../git';
import { join, relative } from 'path';

const HELP: CommandHelp = {
  name: 'wt checkout',
  synopsis: 'wt checkout [-b] [--from <branch>] <branch>',
  description: `Create or switch to a worktree for a branch.

If a worktree for the branch already exists, prints its path.
If not, creates a new worktree and prints the path.

Use -b to create a new branch. New branches are based off origin/main by default
(fetched fresh). Use --from to base off a different remote branch.

Prints ONLY the worktree path to stdout for shell integration.
With shell integration (wt init zsh), checkout auto-cd's into the worktree.`,

  flags: [
    { flag: '-b', description: 'Create a new branch instead of checking out an existing one' },
    {
      flag: '--from <branch>',
      description: 'Base the new branch off origin/<branch> (default: main, requires -b)',
    },
  ],

  examples: [
    '# Checkout existing branch',
    'wt co feature-branch',
    '',
    '# Create new branch (from origin/main)',
    'wt co -b my-new-feature',
    '',
    '# Create new branch from origin/develop',
    'wt co -b my-feature --from develop',
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

  const { stderrSelect, stderrText, stderrCancel, isCancel } = await import('../interactive.js');

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

interface CheckoutArgs {
  createBranch: boolean;
  explicitFrom: string | undefined;
  branch: string | undefined;
}

function parseCheckoutArgs(args: string[]): CheckoutArgs | { error: string } {
  const createBranch = args.includes('-b');
  const fromIndex = args.indexOf('--from');
  const explicitFrom = fromIndex !== -1 ? args[fromIndex + 1] : undefined;

  if (fromIndex !== -1 && (explicitFrom === undefined || explicitFrom === '')) {
    return { error: '--from requires a branch name' };
  }

  const positionalArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-b') continue;
    if (args[i] === '--from') {
      i++;
      continue;
    }
    const arg = args[i];
    if (arg !== undefined) positionalArgs.push(arg);
  }

  return { createBranch, explicitFrom, branch: positionalArgs[0] };
}

type StartPointResult =
  | { resolved: true; startPoint: string }
  | { resolved: false; fallback: true }
  | { resolved: false; fallback: false; error: string };

async function resolveStartPoint(
  explicitFrom: string | undefined,
  bareRoot: string,
): Promise<StartPointResult> {
  const baseBranch = explicitFrom ?? 'main';
  const remote = 'origin';
  const remoteRef = `${remote}/${baseBranch}`;

  const fetched = await fetchRef(remote, baseBranch, { cwd: bareRoot });

  if (fetched && (await refExists(remoteRef, { cwd: bareRoot }))) {
    return { resolved: true, startPoint: remoteRef };
  }

  if (explicitFrom !== undefined) {
    return {
      resolved: false,
      fallback: false,
      error: `Could not resolve '${baseBranch}' from ${remote}`,
    };
  }

  return { resolved: false, fallback: true };
}

async function createWorktree(
  worktreePath: string,
  branch: string,
  options: { createBranch: boolean; startPoint: string | undefined; cwd: string },
): Promise<number> {
  try {
    const worktreeOptions = {
      createBranch: options.createBranch,
      cwd: options.cwd,
      ...(options.startPoint !== undefined && { startPoint: options.startPoint }),
    };
    await addWorktree(worktreePath, branch, worktreeOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error: ${message}`);
    return 1;
  }

  console.log(worktreePath);
  return 0;
}

export const command: CommandHandler = {
  name: 'checkout',
  description: 'Create or switch to a worktree for a branch',
  getHelp: () => HELP,

  async execute(args: string[]): Promise<number> {
    const parsed = parseCheckoutArgs(args);
    if ('error' in parsed) {
      console.error(`Error: ${parsed.error}`);
      return 1;
    }

    const { createBranch, explicitFrom, branch } = parsed;

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

    let startPoint: string | undefined;

    if (createBranch) {
      const result = await resolveStartPoint(explicitFrom, bareRoot);

      if (result.resolved) {
        startPoint = result.startPoint;
        console.error(`Creating branch from ${result.startPoint}`);
      } else if (!result.fallback) {
        console.error(`Error: ${result.error}`);
        return 1;
      } else {
        console.error('Note: Could not fetch origin/main, branching from HEAD');
      }
    }

    const worktreeDir = flattenBranchName(branch);
    const worktreePath = join(bareRoot, worktreeDir);

    return createWorktree(worktreePath, branch, { createBranch, startPoint, cwd: bareRoot });
  },
};
