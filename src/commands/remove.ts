/**
 * wt remove / wt rm - Remove a worktree and optionally its branch.
 */

import { Effect, Layer } from 'effect';
import { relative } from 'path';
import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { printCommandUsage } from '../help.js';
import { getBareRoot, getWorktreeEntries, isBareRepo } from '../git';
import { Git, liveGitReporterLayer, Reporter } from '../services';

type RemoveServices = Git | Reporter;

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

interface RemoveOptions {
  force: boolean;
  shouldDeleteBranch: boolean;
  branch: string | undefined;
}

function parseArgs(args: string[]): RemoveOptions {
  const positionalArgs = args.filter((arg) => !FLAG_NAMES.has(arg));
  return {
    force: args.includes('--force') || args.includes('-f'),
    shouldDeleteBranch: args.includes('--delete-branch'),
    branch: positionalArgs[0],
  };
}

function extractFlags(args: string[]): string[] {
  return args.filter((arg) => FLAG_NAMES.has(arg));
}

function writeStderr(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStderr(message);
  });
}

async function promptForWorktree(self: CommandHandler, flags: string[]): Promise<number> {
  if (!(await isBareRepo())) {
    console.error(
      'Error: Not in a bare repo. wt remove only works with bare repo worktree setups.',
    );
    return 1;
  }

  const { stderrSelect, stderrCancel, stderrLog, isCancel } = await import('../interactive.js');

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

function validateBareRepo(git: import('../services').GitService): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const bareRepo = yield* Effect.either(git.isBareRepo);
    return bareRepo._tag === 'Right' && bareRepo.right;
  });
}

function findWorktreePath(
  bareRoot: string,
  branch: string,
): Effect.Effect<string | null, Error, Git> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const entries = yield* git.getWorktreeEntries(bareRoot);
    const match = entries.find((entry) => entry.branch === branch);
    return match?.path ?? null;
  });
}

function removeBranchWorktree(
  bareRoot: string,
  branch: string,
  force: boolean,
): Effect.Effect<boolean, never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const worktreePath = yield* Effect.either(findWorktreePath(bareRoot, branch));

    if (worktreePath._tag === 'Left') {
      yield* writeStderr(`Error: ${worktreePath.left.message}`);
      return false;
    }

    if (worktreePath.right === null) {
      yield* writeStderr(`Error: No worktree found for branch '${branch}'`);
      return false;
    }

    const removed = yield* Effect.either(
      git.removeWorktree(worktreePath.right, bareRoot, { force }),
    );
    if (removed._tag === 'Left') {
      yield* writeStderr(`Error removing worktree: ${removed.left.message}`);
      return false;
    }

    yield* writeStderr(`Removed worktree: ${branch}`);
    return true;
  });
}

function deleteRemovedBranch(
  bareRoot: string,
  branch: string,
): Effect.Effect<boolean, never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const deleted = yield* Effect.either(git.deleteBranch(branch, bareRoot));

    if (deleted._tag === 'Right') {
      yield* writeStderr(`Deleted branch: ${branch}`);
      return true;
    }

    yield* writeStderr(
      `Warning: worktree removed but branch deletion failed: ${deleted.left.message}`,
    );
    return false;
  });
}

export function removeProgram(
  options: RemoveOptions,
): Effect.Effect<number, never, RemoveServices> {
  return Effect.gen(function* () {
    const git = yield* Git;

    if (!(yield* validateBareRepo(git))) {
      yield* writeStderr(
        'Error: Not in a bare repo. wt remove only works with bare repo worktree setups.',
      );
      return 1;
    }

    const bareRoot = yield* Effect.either(git.getBareRoot);
    if (bareRoot._tag === 'Left') {
      yield* writeStderr(`Error: ${bareRoot.left.message}`);
      return 1;
    }

    const removed = yield* removeBranchWorktree(
      bareRoot.right,
      options.branch ?? '',
      options.force,
    );
    if (!removed) return 1;

    if (!options.shouldDeleteBranch) return 0;

    const deleted = yield* deleteRemovedBranch(bareRoot.right, options.branch ?? '');
    return deleted ? 0 : 1;
  });
}

export function makeRemoveCommand(layer: Layer.Layer<RemoveServices>): CommandHandler {
  return {
    name: 'remove',
    description: 'Remove a worktree',
    getHelp: () => HELP,

    async execute(args: string[]): Promise<number> {
      const options = parseArgs(args);

      if (options.branch === undefined || options.branch === '') {
        if (process.stdin.isTTY !== true) {
          printCommandUsage(HELP);
          return 1;
        }
        return promptForWorktree(this, extractFlags(args));
      }

      return Effect.runPromise(Effect.provide(removeProgram(options), layer));
    },
  };
}

export const command: CommandHandler = makeRemoveCommand(liveGitReporterLayer());
