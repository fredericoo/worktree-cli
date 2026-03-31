import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, createBareRepo, runWt } from '../test-scaffold';

describe('wt list', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-list-test-');
    await createBareRepo(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists worktrees in a bare repo', async () => {
    const result = await runWt(['list'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('main');
  });

  it('shows additional worktrees after checkout', async () => {
    await runWt(['co', '-b', 'feature-x'], join(tempDir, 'main'));

    const result = await runWt(['list'], join(tempDir, 'main'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('main');
    expect(result.stdout).toContain('feature-x');
  });
});
