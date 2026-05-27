import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { stat, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, createBareRepo, createBareRepoWithRemote, runWt } from '../test-scaffold';
import { Effect, Layer } from 'effect';
import { Git, type GitService, Reporter, type ReporterService } from '../services';
import { makeCheckoutCommand } from './checkout';

const bareRoot = '/repo';

function makeTestCommand(
  options: {
    isBareRepo?: boolean;
    existingPath?: string | null;
    hasRemote?: boolean;
    fetched?: boolean;
    refs?: Set<string>;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const addedWorktrees: Array<{
    path: string;
    branch: string;
    createBranch: boolean;
    startPoint: string | undefined;
  }> = [];

  const git: GitService = {
    isBareRepo: Effect.succeed(options.isBareRepo ?? true),
    getBareRoot: Effect.succeed(bareRoot),
    listWorktrees: () => Effect.fail(new Error('not needed')),
    getWorktreeEntries: () => Effect.fail(new Error('not needed')),
    findWorktreeByBranch: () => Effect.succeed(options.existingPath ?? null),
    getHeadOid: () => Effect.fail(new Error('not needed')),
    addWorktree: (worktreePath, branch, addOptions) =>
      Effect.sync(() => {
        addedWorktrees.push({
          path: worktreePath,
          branch,
          createBranch: addOptions.createBranch === true,
          startPoint: addOptions.startPoint,
        });
      }),
    hasRemoteUrl: () => Effect.succeed(options.hasRemote ?? false),
    fetchRef: () => Effect.succeed(options.fetched ?? false),
    refExists: (ref) => Effect.succeed(options.refs?.has(ref) ?? false),
    removeWorktree: () => Effect.fail(new Error('not needed')),
    deleteBranch: () => Effect.fail(new Error('not needed')),
  };

  const reporter: ReporterService = {
    log: (message) =>
      Effect.sync(() => {
        stderr.push(message);
      }),
    writeStdout: (message) =>
      Effect.sync(() => {
        stdout.push(message);
      }),
    writeStderr: (message) =>
      Effect.sync(() => {
        stderr.push(message);
      }),
  };

  const layer = Layer.mergeAll(Layer.succeed(Git, git), Layer.succeed(Reporter, reporter));

  return { addedWorktrees, command: makeCheckoutCommand(layer), stderr, stdout };
}

describe('wt checkout', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-checkout-test-');
    await createBareRepo(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a worktree for an existing branch', async () => {
    await Bun.spawn(['git', '-C', join(tempDir, 'main'), 'branch', 'feature-a'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await runWt(['co', 'feature-a'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);

    const expectedPath = join(tempDir, 'feature-a');
    expect(result.stdout).toBe(expectedPath);

    const worktreeInfo = await stat(expectedPath);
    expect(worktreeInfo.isDirectory()).toBe(true);
  });

  it('returns existing worktree path if already checked out', async () => {
    await Bun.spawn(['git', '-C', join(tempDir, 'main'), 'branch', 'feature-b'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const first = await runWt(['co', 'feature-b'], join(tempDir, 'main'));
    expect(first.exitCode).toBe(0);

    const second = await runWt(['co', 'feature-b'], join(tempDir, 'main'));
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it('flattens branch names with slashes', async () => {
    await Bun.spawn(['git', '-C', join(tempDir, 'main'), 'branch', 'feature/nested'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await runWt(['co', 'feature/nested'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);

    const expectedPath = join(tempDir, 'feature-nested');
    expect(result.stdout).toBe(expectedPath);
  });

  it('creates new branch with -b flag', async () => {
    const result = await runWt(['co', '-b', 'brand-new'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);

    const expectedPath = join(tempDir, 'brand-new');
    expect(result.stdout).toBe(expectedPath);

    const worktreeInfo = await stat(expectedPath);
    expect(worktreeInfo.isDirectory()).toBe(true);
  });

  it('fails without a branch argument', async () => {
    const result = await runWt(['co'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(1);
  });

  it('detects worktree at non-standard path and returns it', async () => {
    await Bun.spawn(['git', '-C', join(tempDir, 'main'), 'branch', 'odd-path-branch'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const nonStandardPath = join(tempDir, '.claude', 'worktrees', 'odd-path-branch');
    await Bun.spawn(['git', 'worktree', 'add', nonStandardPath, 'odd-path-branch'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: join(tempDir, 'main'),
    }).exited;

    const result = await runWt(['co', 'odd-path-branch'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(nonStandardPath);
  });

  it('stdout contains only the path (no messages)', async () => {
    await Bun.spawn(['git', '-C', join(tempDir, 'main'), 'branch', 'clean-output'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await runWt(['co', 'clean-output'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);

    const lines = result.stdout.split('\n');
    expect(lines.length).toBe(1);
    expect(result.stdout).toMatch(/^\//);
  });

  it('returns an existing worktree path through injected services', async () => {
    const { command, stdout, stderr, addedWorktrees } = makeTestCommand({
      existingPath: '/repo/existing-feature',
    });

    const exitCode = await command.execute(['existing-feature']);

    expect(exitCode).toBe(0);
    expect(stdout).toEqual(['/repo/existing-feature']);
    expect(stderr).toEqual([]);
    expect(addedWorktrees).toEqual([]);
  });

  it('creates a branch from origin main through injected services', async () => {
    const { command, stdout, stderr, addedWorktrees } = makeTestCommand({
      hasRemote: true,
      fetched: true,
      refs: new Set(['origin/main']),
    });

    const exitCode = await command.execute(['-b', 'new-feature']);

    expect(exitCode).toBe(0);
    expect(stdout).toEqual(['/repo/new-feature']);
    expect(stderr).toContain('Creating branch from origin/main');
    expect(addedWorktrees).toEqual([
      {
        path: '/repo/new-feature',
        branch: 'new-feature',
        createBranch: true,
        startPoint: 'origin/main',
      },
    ]);
  });

  it('falls back to HEAD when no remote is configured through injected services', async () => {
    const { command, stderr, addedWorktrees } = makeTestCommand();

    const exitCode = await command.execute(['-b', 'fallback-feature']);

    expect(exitCode).toBe(0);
    expect(stderr).toContain('Note: No remote URL configured, branching from HEAD');
    expect(addedWorktrees[0]?.startPoint).toBeUndefined();
  });
});

describe('wt checkout --from', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-checkout-from-test-');
    await createBareRepoWithRemote(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('bases new branch on origin/main by default', async () => {
    const mainDir = join(tempDir, 'main');

    await Bun.write(join(mainDir, 'remote-file.txt'), 'from remote');
    await Bun.spawn(['git', '-C', mainDir, 'add', '.'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;
    await Bun.spawn(['git', '-C', mainDir, 'commit', '-m', 'remote commit'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;
    await Bun.spawn(['git', '-C', mainDir, 'push', 'origin', 'main'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    await Bun.spawn(['git', '-C', mainDir, 'reset', '--hard', 'HEAD~1'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await runWt(['co', '-b', 'from-origin'], mainDir);
    expect(result.exitCode).toBe(0);

    const newWorktree = result.stdout;
    const file = Bun.file(join(newWorktree, 'remote-file.txt'));
    expect(await file.exists()).toBe(true);
  });

  it('uses explicit --from branch', async () => {
    const mainDir = join(tempDir, 'main');

    await Bun.spawn(['git', '-C', mainDir, 'branch', 'develop'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;
    await Bun.spawn(['git', '-C', mainDir, 'push', 'origin', 'develop'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await runWt(['co', '-b', 'feat', '--from', 'develop'], mainDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('origin/develop');
  });

  it('fails when explicit --from branch does not exist on remote', async () => {
    const result = await runWt(
      ['co', '-b', 'feat', '--from', 'nonexistent'],
      join(tempDir, 'main'),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Could not resolve');
  });

  it('falls back to HEAD when origin has no URL', async () => {
    const noRemoteDir = await createTempDir('wt-no-remote-');
    await createBareRepo(noRemoteDir);

    const result = await runWt(['co', '-b', 'fallback-branch'], join(noRemoteDir, 'main'));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('No remote URL configured');
    expect(result.stderr).toContain('branching from HEAD');
  });

  it('uses local branch when --from is specified and no remote URL exists', async () => {
    const noRemoteDir = await createTempDir('wt-no-remote-from-');
    await createBareRepo(noRemoteDir);

    const mainDir = join(noRemoteDir, 'main');
    await Bun.spawn(['git', '-C', mainDir, 'branch', 'develop'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await runWt(['co', '-b', 'feat', '--from', 'develop'], mainDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('No remote URL configured');
    expect(result.stderr).toContain('develop');

    await rm(noRemoteDir, { recursive: true, force: true });
  });

  it('fails when --from targets nonexistent local branch and no remote URL exists', async () => {
    const noRemoteDir = await createTempDir('wt-no-remote-from-fail-');
    await createBareRepo(noRemoteDir);

    const result = await runWt(
      ['co', '-b', 'feat', '--from', 'nonexistent'],
      join(noRemoteDir, 'main'),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No remote URL configured');
    expect(result.stderr).toContain('nonexistent');

    await rm(noRemoteDir, { recursive: true, force: true });
  });

  it('does not leak git fatal errors when no remote URL is configured', async () => {
    const noRemoteDir = await createTempDir('wt-no-remote-clean-');
    await createBareRepo(noRemoteDir);

    const result = await runWt(['co', '-b', 'clean-branch'], join(noRemoteDir, 'main'));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('fatal:');

    await rm(noRemoteDir, { recursive: true, force: true });
  });

  it('fails when --from is provided without a value', async () => {
    const result = await runWt(['co', '-b', 'feat', '--from'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--from requires a branch name');
  });
});
