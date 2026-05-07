import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { stat, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, createBareRepo, runWt } from '../test-scaffold';

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
});
