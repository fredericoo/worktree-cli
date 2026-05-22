import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdir, rm, stat } from 'fs/promises';
import { delimiter } from 'path';
import { join } from 'path';
import { createTempDir, createBareRepo, runWt } from '../test-scaffold';

interface FakePullRequest {
  headRefOid: string;
  state: string;
  url: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function getHead(dir: string): Promise<string> {
  const proc = Bun.spawn(['git', '-C', dir, 'rev-parse', 'HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

async function createFakeGh(dir: string, pullRequests: Record<string, FakePullRequest>) {
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const ghPath = join(binDir, 'gh');
  await Bun.write(
    ghPath,
    `#!/usr/bin/env bun
const [, , command, subcommand, headFlag, branch] = process.argv;
const pullRequests = JSON.parse(process.env.WT_TEST_GH_PRS ?? '{}');
const pullRequest = pullRequests[branch];

if (command !== 'pr' || subcommand !== 'list' || headFlag !== '--head') {
  process.exit(1);
}

console.log(JSON.stringify(pullRequest === undefined ? [] : [pullRequest]));
`,
  );
  await chmod(ghPath, 0o755);

  return {
    PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
    WT_TEST_GH_PRS: JSON.stringify(pullRequests),
  };
}

async function createBranchWorktree(tempDir: string, branch: string): Promise<string> {
  const mainDir = join(tempDir, 'main');
  const result = await runWt(['co', '-b', branch], mainDir);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe('wt prune', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-prune-test-');
    await createBareRepo(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('removes a worktree whose PR is merged at the local HEAD', async () => {
    const branch = 'merged-feature';
    const worktreePath = await createBranchWorktree(tempDir, branch);
    const headRefOid = await getHead(worktreePath);
    const env = await createFakeGh(tempDir, {
      [branch]: { headRefOid, state: 'MERGED', url: 'https://github.test/pull/1' },
    });

    const result = await runWt(['prune'], join(tempDir, 'main'), env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Pruning 2 worktrees');
    expect(result.stderr).toContain(`Removed worktree: ${branch}`);
    expect(await exists(worktreePath)).toBe(false);
  });

  it('keeps a worktree whose PR is not merged', async () => {
    const branch = 'open-feature';
    const worktreePath = await createBranchWorktree(tempDir, branch);
    const headRefOid = await getHead(worktreePath);
    const env = await createFakeGh(tempDir, {
      [branch]: { headRefOid, state: 'OPEN', url: 'https://github.test/pull/2' },
    });

    const result = await runWt(['prune'], join(tempDir, 'main'), env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Kept ${branch}: PR is OPEN`);
    expect(await exists(worktreePath)).toBe(true);
  });

  it('keeps a merged PR worktree when local HEAD has diverged', async () => {
    const branch = 'advanced-feature';
    const worktreePath = await createBranchWorktree(tempDir, branch);
    const env = await createFakeGh(tempDir, {
      [branch]: {
        headRefOid: '0000000000000000000000000000000000000000',
        state: 'MERGED',
        url: 'https://github.test/pull/3',
      },
    });

    const result = await runWt(['prune'], join(tempDir, 'main'), env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`Kept ${branch}: PR HEAD does not match local HEAD`);
    expect(await exists(worktreePath)).toBe(true);
  });

  it('fails when a prunable worktree cannot be removed safely', async () => {
    const branch = 'dirty-feature';
    const worktreePath = await createBranchWorktree(tempDir, branch);
    await Bun.write(join(worktreePath, 'dirty.txt'), 'uncommitted change\n');

    const headRefOid = await getHead(worktreePath);
    const env = await createFakeGh(tempDir, {
      [branch]: { headRefOid, state: 'MERGED', url: 'https://github.test/pull/4' },
    });

    const result = await runWt(['prune'], join(tempDir, 'main'), env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Failed to remove ${branch}`);
    expect(await exists(worktreePath)).toBe(true);
  });
});
