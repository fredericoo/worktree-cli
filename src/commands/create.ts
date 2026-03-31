/**
 * wt create - Convert a standard git repo to bare+worktree layout.
 * Replicates git-to-bare from ~/.config/shell/git-worktree-tools.sh
 * with added rollback on partial failure.
 */

import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import {
  isStandardGitRepo,
  hasUncommittedChanges,
  getDefaultBranch,
  getUntrackedFiles,
  addWorktree,
  setConfig,
} from '../git';
import { resolve, join, dirname } from 'path';
import { readdir, rename, stat, mkdir, rm, mkdtemp } from 'fs/promises';

/**
 * Temp dir is created INSIDE the repo to avoid EXDEV (cross-device rename)
 * errors on Linux where /tmp may be a different filesystem.
 */
async function moveWorkingFiles(repoDir: string): Promise<string> {
  const tempDir = await mkdtemp(join(repoDir, '.wt-staging-'));
  const entries = await readdir(repoDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.bare' || entry.name === '.git') continue;
    if (entry.name.startsWith('.wt-staging-')) continue;
    await rename(join(repoDir, entry.name), join(tempDir, entry.name));
  }

  return tempDir;
}

async function restoreUntrackedFiles(
  tempDir: string,
  mainDir: string,
  untrackedFiles: string[],
): Promise<void> {
  for (const file of untrackedFiles) {
    const srcPath = join(tempDir, file);
    try {
      await stat(srcPath);
    } catch {
      continue;
    }
    const destDir = dirname(join(mainDir, file));
    await mkdir(destDir, { recursive: true });
    await rename(srcPath, join(mainDir, file));
  }
}

async function restoreFromTemp(repoDir: string, tempDir: string): Promise<void> {
  try {
    const entries = await readdir(tempDir);
    for (const entry of entries) {
      const destPath = join(repoDir, entry);
      const destExists = await stat(destPath)
        .then(() => true)
        .catch(() => false);
      if (!destExists) {
        await rename(join(tempDir, entry), destPath);
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    console.error(`  Temp files may remain at: ${tempDir}`);
  }
}

async function rollback(repoDir: string, tempDir: string | null): Promise<void> {
  const bareDir = join(repoDir, '.bare');
  const gitPath = join(repoDir, '.git');

  try {
    const gitInfo = await stat(gitPath);
    const bareExists = await stat(bareDir)
      .then(() => true)
      .catch(() => false);

    if (gitInfo.isFile() && bareExists) {
      await rm(gitPath);
      await rename(bareDir, gitPath);
      // Reverse the core.bare config change now that .git is restored
      await setConfig('core.bare', 'false', repoDir);
    }
  } catch {
    // .git doesn't exist or other issue — can't recover further
  }

  if (tempDir !== null) {
    await restoreFromTemp(repoDir, tempDir);
  }
}

async function doCreate(dir: string): Promise<number> {
  const repoDir = resolve(dir);

  if (!(await isStandardGitRepo(repoDir))) {
    console.error('Error: No .git directory. Is this a standard git repo?');
    return 1;
  }

  if (await hasUncommittedChanges(repoDir)) {
    console.error('Error: You have uncommitted changes.');
    console.error('Commit or stash them first.');
    return 1;
  }

  const { branch: targetBranch, isDefault } = await getDefaultBranch(repoDir);
  if (!isDefault) {
    console.error(`Note: No main/master branch. Using '${targetBranch}'.`);
  }

  const untrackedFiles = await getUntrackedFiles(repoDir);

  console.error('Converting to bare repo structure...');
  console.error(`  Target branch: ${targetBranch}`);
  console.error('');

  let tempDir: string | null = null;

  const onInterrupt = (): void => {
    console.error('\nInterrupted! Attempting rollback...');
    void rollback(repoDir, tempDir).finally(() => process.exit(1));
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    await rename(join(repoDir, '.git'), join(repoDir, '.bare'));
    await Bun.write(join(repoDir, '.git'), 'gitdir: .bare\n');
    await setConfig('core.bare', 'true', repoDir);
    await setConfig('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*', repoDir);

    tempDir = await moveWorkingFiles(repoDir);
    console.error(`  Staging files in: ${tempDir}`);

    await addWorktree(join(repoDir, 'main'), targetBranch, { cwd: repoDir });

    if (untrackedFiles.length > 0) {
      console.error('  Restoring untracked files...');
      await restoreUntrackedFiles(tempDir, join(repoDir, 'main'), untrackedFiles);
    }

    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`\nError during conversion: ${message}`);
    console.error('Attempting rollback...');
    await rollback(repoDir, tempDir);
    console.error('Rollback complete. Repository should be in its original state.');
    return 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }

  console.error('');
  console.error('Done! New structure:');
  console.error('');
  console.error(`  ${repoDir}/`);
  console.error('  +-- .bare/     <- git database (shared)');
  console.error('  +-- .git       <- pointer to .bare');
  console.error(`  +-- main/      <- worktree on '${targetBranch}'`);
  console.error('');
  console.error('Next steps:');
  console.error('  cd main        # start working');
  console.error('  wt co branch   # add more worktrees');
  return 0;
}

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

export const command: CommandHandler = {
  name: 'create',
  description: 'Convert a standard git repo to bare+worktree layout',
  getHelp: () => HELP,

  async execute(args: string[]): Promise<number> {
    if (args.includes('--help') || args.includes('-h')) {
      return 0;
    }

    const dir = args[0] ?? '.';
    return doCreate(dir);
  },
};
