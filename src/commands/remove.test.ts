import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { stat, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, createBareRepo, runWt } from '../test-scaffold';
import { Effect, Layer } from 'effect';
import type { WorktreeEntry } from '../git';
import {
  Git,
  type GitService,
  Interactive,
  type InteractiveService,
  Reporter,
  type ReporterService,
} from '../services';
import { makeRemoveCommand } from './remove';

const bareRoot = '/repo';
const featureWorktree: WorktreeEntry = { path: '/repo/feature', branch: 'feature' };

function makeTestCommand(
  options: {
    isBareRepo?: boolean;
    entries?: WorktreeEntry[];
    removeFailure?: Error;
    deleteFailure?: Error;
    selectResponse?: string | symbol;
  } = {},
) {
  const stderr: string[] = [];
  const removedWorktrees: Array<{ path: string; force: boolean }> = [];
  const deletedBranches: string[] = [];

  const git: GitService = {
    isStandardGitRepo: () => Effect.fail(new Error('not needed')),
    isBareRepo: Effect.succeed(options.isBareRepo ?? true),
    hasUncommittedChanges: () => Effect.fail(new Error('not needed')),
    getDefaultBranch: () => Effect.fail(new Error('not needed')),
    getUntrackedFiles: () => Effect.fail(new Error('not needed')),
    getBareRoot: Effect.succeed(bareRoot),
    listWorktrees: () => Effect.fail(new Error('not needed')),
    getWorktreeEntries: () => Effect.succeed(options.entries ?? [featureWorktree]),
    findWorktreeByBranch: () => Effect.fail(new Error('not needed')),
    getHeadOid: () => Effect.fail(new Error('not needed')),
    addWorktree: () => Effect.fail(new Error('not needed')),
    hasRemoteUrl: () => Effect.fail(new Error('not needed')),
    fetchRef: () => Effect.fail(new Error('not needed')),
    refExists: () => Effect.fail(new Error('not needed')),
    removeWorktree: (worktreePath, _bareRoot, removeOptions = {}) =>
      options.removeFailure !== undefined
        ? Effect.fail(options.removeFailure)
        : Effect.sync(() => {
            removedWorktrees.push({ path: worktreePath, force: removeOptions.force === true });
          }),
    deleteBranch: (branch) =>
      options.deleteFailure !== undefined
        ? Effect.fail(options.deleteFailure)
        : Effect.sync(() => {
            deletedBranches.push(branch);
          }),
    setConfig: () => Effect.fail(new Error('not needed')),
  };

  const reporter: ReporterService = {
    stderrIsTty: false,
    log: (message) =>
      Effect.sync(() => {
        stderr.push(message);
      }),
    writeStdout: () => Effect.sync(() => {}),
    writeStderr: (message) =>
      Effect.sync(() => {
        stderr.push(message);
      }),
    writeStderrRaw: (message) =>
      Effect.sync(() => {
        stderr.push(message);
      }),
  };

  const interactive: InteractiveService = {
    select: () => Effect.succeed(options.selectResponse ?? featureWorktree.branch),
    text: () => Effect.fail(new Error('not needed')),
    isCancel: () => false,
    cancel: () => Effect.sync(() => {}),
    warn: (message) =>
      Effect.sync(() => {
        stderr.push(message);
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(Git, git),
    Layer.succeed(Interactive, interactive),
    Layer.succeed(Reporter, reporter),
  );

  return {
    command: makeRemoveCommand(layer),
    deletedBranches,
    promptCommand: makeRemoveCommand(layer, { isTty: () => true }),
    removedWorktrees,
    stderr,
  };
}

describe('wt remove', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-remove-test-');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('removes an existing worktree', async () => {
    await createBareRepo(tempDir);

    // Create a branch and worktree
    await Bun.spawn(['git', '-C', join(tempDir, 'main'), 'branch', 'to-remove'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;
    const coResult = await runWt(['co', 'to-remove'], join(tempDir, 'main'));
    expect(coResult.exitCode).toBe(0);

    const worktreePath = coResult.stdout;
    const beforeInfo = await stat(worktreePath);
    expect(beforeInfo.isDirectory()).toBe(true);

    const result = await runWt(['rm', 'to-remove'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);

    let exists = true;
    try {
      await stat(worktreePath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('removes a worktree at a non-standard path', async () => {
    await createBareRepo(tempDir);

    await Bun.spawn(['git', '-C', join(tempDir, 'main'), 'branch', 'odd-path'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const nonStandardPath = join(tempDir, '.claude', 'worktrees', 'odd-path');
    await Bun.spawn(['git', 'worktree', 'add', nonStandardPath, 'odd-path'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: join(tempDir, 'main'),
    }).exited;

    const info = await stat(nonStandardPath);
    expect(info.isDirectory()).toBe(true);

    const result = await runWt(['rm', 'odd-path'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);

    let exists = true;
    try {
      await stat(nonStandardPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('fails when worktree does not exist', async () => {
    await createBareRepo(tempDir);

    const result = await runWt(['rm', 'nonexistent'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No worktree found');
  });

  it('fails without a branch argument', async () => {
    const result = await runWt(['rm']);
    expect(result.exitCode).toBe(1);
  });

  it('removes an existing worktree through injected services', async () => {
    const { command, removedWorktrees, stderr } = makeTestCommand();

    const exitCode = await command.execute(['feature']);

    expect(exitCode).toBe(0);
    expect(removedWorktrees).toEqual([{ path: featureWorktree.path, force: false }]);
    expect(stderr).toContain('Removed worktree: feature');
  });

  it('passes the force flag through injected services', async () => {
    const { command, removedWorktrees } = makeTestCommand();

    const exitCode = await command.execute(['--force', 'feature']);

    expect(exitCode).toBe(0);
    expect(removedWorktrees).toEqual([{ path: featureWorktree.path, force: true }]);
  });

  it('deletes the branch after removing the worktree when requested', async () => {
    const { command, deletedBranches } = makeTestCommand();

    const exitCode = await command.execute(['feature', '--delete-branch']);

    expect(exitCode).toBe(0);
    expect(deletedBranches).toEqual(['feature']);
  });

  it('returns an error when the branch has no worktree', async () => {
    const { command, stderr } = makeTestCommand({ entries: [] });

    const exitCode = await command.execute(['missing']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Error: No worktree found for branch 'missing'");
  });

  it('prompts for a worktree through injected services', async () => {
    const { promptCommand, removedWorktrees } = makeTestCommand({ selectResponse: 'feature' });

    const exitCode = await promptCommand.execute([]);

    expect(exitCode).toBe(0);
    expect(removedWorktrees).toEqual([{ path: featureWorktree.path, force: false }]);
  });

  it('warns when there are no worktrees to remove through injected services', async () => {
    const { promptCommand, stderr } = makeTestCommand({ entries: [] });

    const exitCode = await promptCommand.execute([]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('No worktrees to remove.');
  });
});
