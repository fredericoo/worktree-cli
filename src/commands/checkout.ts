/**
 * wt checkout / wt co - Create or switch to a worktree for a branch.
 * Replicates tco from ~/.config/shell/git-worktree-tools.sh
 *
 * stdout: ONLY the worktree path (for shell integration cd).
 * stderr: all human-readable messages.
 */

import { Effect, Layer } from 'effect';
import { join, relative } from 'path';
import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { printCommandUsage } from '../help.js';
import { flattenBranchName, getBareRoot, getWorktreeEntries, isBareRepo } from '../git';
import { Git, liveGitReporterLayer, Reporter } from '../services';

type CheckoutServices = Git | Reporter;

const HELP: CommandHelp = {
  name: 'wt checkout',
  synopsis: 'wt checkout [-b] [--from <branch>] <branch>',
  description: `Create or switch to a worktree for a branch.

If a worktree for the branch already exists, prints its path.
If not, creates a new worktree and prints the path.

Use -b to create a new branch. New branches are based off origin/main by default
(fetched fresh). Use --from to base off a different branch. If no remote URL is
configured, branches from HEAD (or a local branch with --from).

Prints ONLY the worktree path to stdout for shell integration.
With shell integration (wt init zsh), checkout auto-cd's into the worktree.`,

  flags: [
    { flag: '-b', description: 'Create a new branch instead of checking out an existing one' },
    {
      flag: '--from <branch>',
      description: 'Base the new branch off a different branch (default: origin/main, requires -b)',
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

interface CheckoutArgs {
  createBranch: boolean;
  explicitFrom: string | undefined;
  branch: string | undefined;
}

type StartPointResult =
  | { resolved: true; startPoint: string; note?: string }
  | { resolved: false; fallback: true; reason: string }
  | { resolved: false; fallback: false; error: string };

function parseCheckoutArgs(args: string[]): CheckoutArgs | { error: string } {
  const createBranch = args.includes('-b');
  const fromIndex = args.indexOf('--from');
  const explicitFrom = fromIndex !== -1 ? args[fromIndex + 1] : undefined;

  if (fromIndex !== -1 && (explicitFrom === undefined || explicitFrom === '')) {
    return { error: '--from requires a branch name' };
  }

  const positionalArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-b') continue;
    if (args[index] === '--from') {
      index++;
      continue;
    }
    const arg = args[index];
    if (arg !== undefined) positionalArgs.push(arg);
  }

  return { createBranch, explicitFrom, branch: positionalArgs[0] };
}

function writeStdout(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStdout(message);
  });
}

function writeStderr(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStderr(message);
  });
}

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

function resolveStartPoint(
  explicitFrom: string | undefined,
  bareRoot: string,
): Effect.Effect<StartPointResult, Error, Git> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const baseBranch = explicitFrom ?? 'main';
    const remote = 'origin';
    const hasRemote = yield* git.hasRemoteUrl(remote, bareRoot);

    if (!hasRemote) {
      return yield* resolveWithoutRemote(explicitFrom, bareRoot);
    }

    return yield* resolveFromRemote(remote, baseBranch, explicitFrom, bareRoot);
  });
}

function resolveFromRemote(
  remote: string,
  baseBranch: string,
  explicitFrom: string | undefined,
  bareRoot: string,
): Effect.Effect<StartPointResult, Error, Git> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const remoteRef = `${remote}/${baseBranch}`;
    const fetched = yield* git.fetchRef(remote, baseBranch, bareRoot);

    if (fetched && (yield* git.refExists(remoteRef, bareRoot))) {
      return { resolved: true, startPoint: remoteRef };
    }

    if (explicitFrom !== undefined) {
      return {
        resolved: false,
        fallback: false,
        error: `Could not resolve '${baseBranch}' from ${remote}`,
      };
    }

    return {
      resolved: false,
      fallback: true,
      reason: 'Could not fetch origin/main, branching from HEAD',
    };
  });
}

function resolveWithoutRemote(
  explicitFrom: string | undefined,
  bareRoot: string,
): Effect.Effect<StartPointResult, Error, Git> {
  return Effect.gen(function* () {
    const git = yield* Git;

    if (explicitFrom !== undefined) {
      const localRef = `refs/heads/${explicitFrom}`;
      if (yield* git.refExists(localRef, bareRoot)) {
        return {
          resolved: true,
          startPoint: explicitFrom,
          note: `No remote URL configured, using local '${explicitFrom}' as start point`,
        };
      }
      return {
        resolved: false,
        fallback: false,
        error: `No remote URL configured and local branch '${explicitFrom}' does not exist`,
      };
    }

    return {
      resolved: false,
      fallback: true,
      reason: 'No remote URL configured, branching from HEAD',
    };
  });
}

function createWorktree(
  worktreePath: string,
  branch: string,
  options: { createBranch: boolean; startPoint: string | undefined; cwd: string },
): Effect.Effect<number, never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const worktreeOptions =
      options.startPoint !== undefined
        ? { createBranch: options.createBranch, cwd: options.cwd, startPoint: options.startPoint }
        : { createBranch: options.createBranch, cwd: options.cwd };

    const added = yield* Effect.either(git.addWorktree(worktreePath, branch, worktreeOptions));
    if (added._tag === 'Left') {
      yield* writeStderr(`Error: ${added.left.message}`);
      return 1;
    }

    yield* writeStdout(worktreePath);
    return 0;
  });
}

function ensureBareRepo(): Effect.Effect<boolean, never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const bareRepo = yield* Effect.either(git.isBareRepo);

    if (bareRepo._tag === 'Right' && bareRepo.right) return true;

    yield* writeStderr(
      'Error: Not in a bare repo. wt checkout only works with bare repo worktree setups.',
    );
    yield* writeStderr('Run "wt create" first to convert your repo.');
    return false;
  });
}

function getRequiredBareRoot(): Effect.Effect<string | null, never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const bareRoot = yield* Effect.either(git.getBareRoot);

    if (bareRoot._tag === 'Right') return bareRoot.right;

    yield* writeStderr(`Error: ${bareRoot.left.message}`);
    return null;
  });
}

function printExistingWorktree(
  branch: string,
  bareRoot: string,
): Effect.Effect<boolean, never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const existingPath = yield* Effect.either(git.findWorktreeByBranch(branch, bareRoot));

    if (existingPath._tag === 'Left') {
      yield* writeStderr(`Error: ${existingPath.left.message}`);
      return true;
    }

    if (existingPath.right === null) return false;

    yield* writeStdout(existingPath.right);
    return true;
  });
}

function resolveOptionalStartPoint(
  createBranch: boolean,
  explicitFrom: string | undefined,
  bareRoot: string,
): Effect.Effect<string | null | undefined, never, Git | Reporter> {
  return Effect.gen(function* () {
    if (!createBranch) return undefined;

    const startPointResult = yield* Effect.either(resolveStartPoint(explicitFrom, bareRoot));
    if (startPointResult._tag === 'Left') {
      yield* writeStderr(`Error: ${startPointResult.left.message}`);
      return null;
    }

    const result = startPointResult.right;
    if (result.resolved) {
      yield* writeStderr(result.note ?? `Creating branch from ${result.startPoint}`);
      return result.startPoint;
    }

    if (!result.fallback) {
      yield* writeStderr(`Error: ${result.error}`);
      return null;
    }

    yield* writeStderr(`Note: ${result.reason}`);
    return undefined;
  });
}

export function checkoutProgram(
  parsed: CheckoutArgs,
): Effect.Effect<number, never, CheckoutServices> {
  return Effect.gen(function* () {
    const { createBranch, explicitFrom, branch } = parsed;

    if (!(yield* ensureBareRepo())) return 1;

    const bareRoot = yield* getRequiredBareRoot();
    if (bareRoot === null) return 1;

    const branchName = branch ?? '';
    if (yield* printExistingWorktree(branchName, bareRoot)) return 0;

    const startPoint = yield* resolveOptionalStartPoint(createBranch, explicitFrom, bareRoot);
    if (startPoint === null) return 1;

    const worktreeDir = flattenBranchName(branchName);
    const worktreePath = join(bareRoot, worktreeDir);

    return yield* createWorktree(worktreePath, branchName, {
      createBranch,
      startPoint,
      cwd: bareRoot,
    });
  });
}

export function makeCheckoutCommand(layer: Layer.Layer<CheckoutServices>): CommandHandler {
  return {
    name: 'checkout',
    description: 'Create or switch to a worktree for a branch',
    getHelp: () => HELP,

    async execute(args: string[]): Promise<number> {
      const parsed = parseCheckoutArgs(args);
      if ('error' in parsed) {
        console.error(`Error: ${parsed.error}`);
        return 1;
      }

      if (parsed.branch === undefined || parsed.branch === '') {
        if (process.stdin.isTTY !== true) {
          printCommandUsage(HELP);
          return 1;
        }
        return promptForBranch(this);
      }

      return Effect.runPromise(Effect.provide(checkoutProgram(parsed), layer));
    },
  };
}

export const command: CommandHandler = makeCheckoutCommand(liveGitReporterLayer());
