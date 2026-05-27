/**
 * wt create - Convert a standard git repo to bare+worktree layout.
 * Replicates git-to-bare from ~/.config/shell/git-worktree-tools.sh
 * with added rollback on partial failure.
 */

import { Effect, Layer } from 'effect';
import { dirname, join, resolve } from 'path';
import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { FileSystem, Git, liveCreateLayer, Reporter, type CreateServices } from '../services';

const HELP: CommandHelp = {
  name: 'wt create',
  synopsis: 'wt create [directory]',
  description: `Convert a standard git repo into a bare repository with worktrees.

Creates a shared .bare/ database and a main/ worktree checked out to the
default branch (main, master, or current HEAD). Preserves untracked files.

The directory argument defaults to the current directory.`,

  flags: [],

  examples: [
    '# Convert current directory',
    'wt create',
    '',
    '# Convert a specific repo',
    'wt create ~/projects/my-repo',
  ],

  notes: [
    'Requires a clean working tree (no uncommitted changes).',
    'If the conversion fails partway through, rollback is attempted automatically.',
    'After conversion, cd into main/ to start working.',
  ],
};

function writeStderr(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStderr(message);
  });
}

function shouldMoveEntry(name: string): boolean {
  if (name === '.bare' || name === '.git') return false;
  return !name.startsWith('.wt-staging-');
}

function moveWorkingFiles(repoDir: string): Effect.Effect<string, Error, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const tempDir = yield* fs.makeTempDir(repoDir, '.wt-staging-');
    const entries = yield* fs.readDir(repoDir);

    for (const entry of entries) {
      if (!shouldMoveEntry(entry.name)) continue;
      yield* fs.rename(join(repoDir, entry.name), join(tempDir, entry.name));
    }

    return tempDir;
  });
}

function restoreUntrackedFiles(
  tempDir: string,
  mainDir: string,
  untrackedFiles: string[],
): Effect.Effect<void, Error, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;

    for (const file of untrackedFiles) {
      const srcPath = join(tempDir, file);
      if (!(yield* fs.exists(srcPath))) continue;

      const destPath = join(mainDir, file);
      yield* fs.makeDir(dirname(destPath));
      yield* fs.rename(srcPath, destPath);
    }
  });
}

function restoreFromTemp(
  repoDir: string,
  tempDir: string,
): Effect.Effect<void, never, FileSystem | Reporter> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const restored = yield* Effect.either(
      Effect.gen(function* () {
        const entries = yield* fs.readDir(tempDir);
        for (const entry of entries) {
          const destPath = join(repoDir, entry.name);
          if (yield* fs.exists(destPath)) continue;
          yield* fs.rename(join(tempDir, entry.name), destPath);
        }
        yield* fs.remove(tempDir);
      }),
    );

    if (restored._tag === 'Left') {
      yield* writeStderr(`  Temp files may remain at: ${tempDir}`);
    }
  });
}

function rollback(
  repoDir: string,
  tempDir: string | null,
): Effect.Effect<void, never, CreateServices> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const git = yield* Git;
    const bareDir = join(repoDir, '.bare');
    const gitPath = join(repoDir, '.git');

    const restoredGit = yield* Effect.either(
      Effect.gen(function* () {
        const gitPathIsFile = yield* fs.isFile(gitPath);
        const bareExists = yield* fs.exists(bareDir);
        if (!gitPathIsFile || !bareExists) return;

        yield* fs.remove(gitPath);
        yield* fs.rename(bareDir, gitPath);
        yield* git.setConfig('core.bare', 'false', repoDir);
      }),
    );

    if (restoredGit._tag === 'Left') {
      // Rollback is best effort; restoring moved files below is still useful.
    }

    if (tempDir !== null) {
      yield* restoreFromTemp(repoDir, tempDir);
    }
  });
}

function validateRepo(repoDir: string): Effect.Effect<boolean, never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;

    const standardRepo = yield* Effect.either(git.isStandardGitRepo(repoDir));
    if (standardRepo._tag === 'Left' || !standardRepo.right) {
      yield* writeStderr('Error: No .git directory. Is this a standard git repo?');
      return false;
    }

    const uncommittedChanges = yield* Effect.either(git.hasUncommittedChanges(repoDir));
    if (uncommittedChanges._tag === 'Left' || uncommittedChanges.right) {
      yield* writeStderr('Error: You have uncommitted changes.');
      yield* writeStderr('Commit or stash them first.');
      return false;
    }

    return true;
  });
}

function printHeader(targetBranch: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    yield* writeStderr('Converting to bare repo structure...');
    yield* writeStderr(`  Target branch: ${targetBranch}`);
    yield* writeStderr('');
  });
}

function printFooter(repoDir: string, targetBranch: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    yield* writeStderr('');
    yield* writeStderr('Done! New structure:');
    yield* writeStderr('');
    yield* writeStderr(`  ${repoDir}/`);
    yield* writeStderr('  +-- .bare/     <- git database (shared)');
    yield* writeStderr('  +-- .git       <- pointer to .bare');
    yield* writeStderr(`  +-- main/      <- worktree on '${targetBranch}'`);
    yield* writeStderr('');
    yield* writeStderr('Next steps:');
    yield* writeStderr('  cd main        # start working');
    yield* writeStderr('  wt co branch   # add more worktrees');
  });
}

function convertRepo(
  repoDir: string,
  targetBranch: string,
  untrackedFiles: string[],
  tempDirRef: { current: string | null },
): Effect.Effect<void, Error, CreateServices> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const git = yield* Git;

    yield* fs.rename(join(repoDir, '.git'), join(repoDir, '.bare'));
    yield* fs.writeFile(join(repoDir, '.git'), 'gitdir: .bare\n');
    yield* git.setConfig('core.bare', 'true', repoDir);
    yield* git.setConfig('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*', repoDir);

    const tempDir = yield* moveWorkingFiles(repoDir);
    tempDirRef.current = tempDir;
    yield* writeStderr(`  Staging files in: ${tempDir}`);

    yield* git.addWorktree(join(repoDir, 'main'), targetBranch, { cwd: repoDir });

    if (untrackedFiles.length > 0) {
      yield* writeStderr('  Restoring untracked files...');
      yield* restoreUntrackedFiles(tempDir, join(repoDir, 'main'), untrackedFiles);
    }

    yield* fs.remove(tempDir);
    tempDirRef.current = null;
  });
}

function runConversion(
  repoDir: string,
  tempDirRef: { current: string | null },
): Effect.Effect<number, never, CreateServices> {
  return Effect.gen(function* () {
    const git = yield* Git;
    if (!(yield* validateRepo(repoDir))) return 1;

    const defaultBranchResult = yield* Effect.either(git.getDefaultBranch(repoDir));
    if (defaultBranchResult._tag === 'Left') {
      yield* writeStderr(`Error: ${defaultBranchResult.left.message}`);
      return 1;
    }

    const defaultBranch = defaultBranchResult.right;
    if (!defaultBranch.isDefault) {
      yield* writeStderr(`Note: No main/master branch. Using '${defaultBranch.branch}'.`);
    }

    const untrackedFilesResult = yield* Effect.either(git.getUntrackedFiles(repoDir));
    if (untrackedFilesResult._tag === 'Left') {
      yield* writeStderr(`Error: ${untrackedFilesResult.left.message}`);
      return 1;
    }

    const untrackedFiles = untrackedFilesResult.right;
    yield* printHeader(defaultBranch.branch);

    const converted = yield* Effect.either(
      convertRepo(repoDir, defaultBranch.branch, untrackedFiles, tempDirRef),
    );

    if (converted._tag === 'Left') {
      yield* writeStderr(`\nError during conversion: ${converted.left.message}`);
      yield* writeStderr('Attempting rollback...');
      yield* rollback(repoDir, tempDirRef.current);
      yield* writeStderr('Rollback complete. Repository should be in its original state.');
      return 1;
    }

    yield* printFooter(repoDir, defaultBranch.branch);
    return 0;
  });
}

export function createProgram(dir: string): Effect.Effect<number, never, CreateServices> {
  return runConversion(resolve(dir), { current: null });
}

async function runCreateWithInterruptRollback(
  dir: string,
  layer: Layer.Layer<CreateServices>,
): Promise<number> {
  const repoDir = resolve(dir);
  const tempDirRef: { current: string | null } = { current: null };

  const onInterrupt = (): void => {
    console.error('\nInterrupted! Attempting rollback...');
    void Effect.runPromise(Effect.provide(rollback(repoDir, tempDirRef.current), layer)).finally(
      () => {
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    return await Effect.runPromise(Effect.provide(runConversion(repoDir, tempDirRef), layer));
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}

export function makeCreateCommand(layer: Layer.Layer<CreateServices>): CommandHandler {
  return {
    name: 'create',
    description: 'Convert a standard git repo to bare+worktree layout',
    getHelp: () => HELP,

    execute(args: string[]): Promise<number> {
      if (args.includes('--help') || args.includes('-h')) {
        return Promise.resolve(0);
      }

      const dir = args[0] ?? '.';
      return runCreateWithInterruptRollback(dir, layer);
    },
  };
}

export const command: CommandHandler = makeCreateCommand(liveCreateLayer());
