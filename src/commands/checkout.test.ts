import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { stat, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, createBareRepo, createBareRepoWithRemote, runWt } from '../test-scaffold';

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
