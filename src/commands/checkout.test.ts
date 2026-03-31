import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { stat, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, createBareRepo, runWt } from '../test-scaffold';

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
