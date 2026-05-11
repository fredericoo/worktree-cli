import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  flattenBranchName,
  isStandardGitRepo,
  isBareRepo,
  hasUncommittedChanges,
  getDefaultBranch,
  findWorktreeByBranch,
  parseWorktreeList,
  fetchRef,
  refExists,
} from './git';
import { createTempDir, createBareRepo, createBareRepoWithRemote } from './test-scaffold';

describe('flattenBranchName', () => {
  it('replaces forward slashes with hyphens', () => {
    expect(flattenBranchName('feature/foo')).toBe('feature-foo');
  });

  it('handles multiple slashes', () => {
    expect(flattenBranchName('feature/foo/bar')).toBe('feature-foo-bar');
  });

  it('returns branch name unchanged when no slashes', () => {
    expect(flattenBranchName('main')).toBe('main');
  });

  it('handles empty string', () => {
    expect(flattenBranchName('')).toBe('');
  });

  it('handles leading slash', () => {
    expect(flattenBranchName('/leading')).toBe('-leading');
  });

  it('handles trailing slash', () => {
    expect(flattenBranchName('trailing/')).toBe('trailing-');
  });
});

describe('git repo detection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wt-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('isStandardGitRepo', () => {
    it('returns true for a standard git repo', async () => {
      const proc = Bun.spawn(['git', 'init', tempDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      expect(await isStandardGitRepo(tempDir)).toBe(true);
    });

    it('returns false for a non-repo directory', async () => {
      expect(await isStandardGitRepo(tempDir)).toBe(false);
    });

    it('returns false for non-existent directory', async () => {
      expect(await isStandardGitRepo('/nonexistent/path')).toBe(false);
    });
  });

  describe('isBareRepo', () => {
    it('returns false for a standard git repo', async () => {
      const proc = Bun.spawn(['git', 'init', tempDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      expect(await isBareRepo(tempDir)).toBe(false);
    });

    it('returns true for a bare git repo', async () => {
      const proc = Bun.spawn(['git', 'init', '--bare', tempDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      expect(await isBareRepo(tempDir)).toBe(true);
    });
  });

  describe('hasUncommittedChanges', () => {
    it('returns false for a clean repo with at least one commit', async () => {
      await Bun.spawn(['git', 'init', tempDir], { stdout: 'pipe', stderr: 'pipe' }).exited;
      await Bun.spawn(['git', '-C', tempDir, 'config', 'user.email', 'test@test.com'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
      await Bun.spawn(['git', '-C', tempDir, 'config', 'user.name', 'Test'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

      await Bun.write(join(tempDir, 'file.txt'), 'content');
      await Bun.spawn(['git', '-C', tempDir, 'add', '.'], { stdout: 'pipe', stderr: 'pipe' })
        .exited;
      await Bun.spawn(['git', '-C', tempDir, 'commit', '-m', 'init'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

      expect(await hasUncommittedChanges(tempDir)).toBe(false);
    });

    it('returns true when there are unstaged changes', async () => {
      await Bun.spawn(['git', 'init', tempDir], { stdout: 'pipe', stderr: 'pipe' }).exited;
      await Bun.spawn(['git', '-C', tempDir, 'config', 'user.email', 'test@test.com'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
      await Bun.spawn(['git', '-C', tempDir, 'config', 'user.name', 'Test'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

      await Bun.write(join(tempDir, 'file.txt'), 'content');
      await Bun.spawn(['git', '-C', tempDir, 'add', '.'], { stdout: 'pipe', stderr: 'pipe' })
        .exited;
      await Bun.spawn(['git', '-C', tempDir, 'commit', '-m', 'init'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

      await Bun.write(join(tempDir, 'file.txt'), 'changed');
      expect(await hasUncommittedChanges(tempDir)).toBe(true);
    });
  });

  describe('getDefaultBranch', () => {
    it('detects main as the default branch', async () => {
      await Bun.spawn(['git', 'init', '-b', 'main', tempDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
      await Bun.spawn(['git', '-C', tempDir, 'config', 'user.email', 'test@test.com'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;
      await Bun.spawn(['git', '-C', tempDir, 'config', 'user.name', 'Test'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

      await Bun.write(join(tempDir, 'file.txt'), 'content');
      await Bun.spawn(['git', '-C', tempDir, 'add', '.'], { stdout: 'pipe', stderr: 'pipe' })
        .exited;
      await Bun.spawn(['git', '-C', tempDir, 'commit', '-m', 'init'], {
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

      const result = await getDefaultBranch(tempDir);
      expect(result.branch).toBe('main');
      expect(result.isDefault).toBe(true);
    });
  });
});

describe('parseWorktreeList', () => {
  it('parses standard git worktree list output', () => {
    const raw = [
      '/home/user/repo/.bare          abc1234 (bare)',
      '/home/user/repo/main           def5678 [main]',
      '/home/user/repo/feature-a      1111111 [feature-a]',
    ].join('\n');

    const entries = parseWorktreeList(raw);
    expect(entries).toEqual([
      { path: '/home/user/repo/main', branch: 'main' },
      { path: '/home/user/repo/feature-a', branch: 'feature-a' },
    ]);
  });

  it('excludes bare entry — regex matches [branch] not (bare)', () => {
    const raw = '/home/user/repo/.bare  abc1234 (bare)';
    expect(parseWorktreeList(raw)).toEqual([]);
  });

  it('handles branch names with slashes', () => {
    const raw = '/home/user/repo/feature-nested  abc1234 [feature/nested]';
    const entries = parseWorktreeList(raw);
    expect(entries).toEqual([{ path: '/home/user/repo/feature-nested', branch: 'feature/nested' }]);
  });

  it('handles empty string', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });

  it('handles single worktree output', () => {
    const raw = '/home/user/repo/main  abc1234 [main]';
    expect(parseWorktreeList(raw)).toEqual([{ path: '/home/user/repo/main', branch: 'main' }]);
  });

  it('handles paths with spaces', () => {
    const raw = '/home/user/my repo/main  abc1234 [main]';
    const entries = parseWorktreeList(raw);
    expect(entries).toEqual([{ path: '/home/user/my repo/main', branch: 'main' }]);
  });
});

describe('findWorktreeByBranch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-find-worktree-test-');
    await createBareRepo(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns path for a worktree at the conventional location', async () => {
    const mainDir = join(tempDir, 'main');
    await Bun.spawn(['git', '-C', mainDir, 'branch', 'feature-a'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const conventionalPath = join(tempDir, 'feature-a');
    await Bun.spawn(['git', 'worktree', 'add', conventionalPath, 'feature-a'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: mainDir,
    }).exited;

    const result = await findWorktreeByBranch('feature-a', mainDir);
    expect(result).toBe(conventionalPath);
  });

  it('returns path for a worktree at a non-standard location', async () => {
    const mainDir = join(tempDir, 'main');
    await Bun.spawn(['git', '-C', mainDir, 'branch', 'feature-b'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const nonStandardPath = join(tempDir, '.claude', 'worktrees', 'feature-b');
    await Bun.spawn(['git', 'worktree', 'add', nonStandardPath, 'feature-b'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: mainDir,
    }).exited;

    const result = await findWorktreeByBranch('feature-b', mainDir);
    expect(result).toBe(nonStandardPath);
  });

  it('returns null when no worktree exists for the branch', async () => {
    const mainDir = join(tempDir, 'main');
    await Bun.spawn(['git', '-C', mainDir, 'branch', 'orphan-branch'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await findWorktreeByBranch('orphan-branch', mainDir);
    expect(result).toBeNull();
  });

  it('handles branch names with slashes', async () => {
    const mainDir = join(tempDir, 'main');
    await Bun.spawn(['git', '-C', mainDir, 'branch', 'feature/nested'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const worktreePath = join(tempDir, 'feature-nested');
    await Bun.spawn(['git', 'worktree', 'add', worktreePath, 'feature/nested'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: mainDir,
    }).exited;

    const result = await findWorktreeByBranch('feature/nested', mainDir);
    expect(result).toBe(worktreePath);
  });
});

describe('fetchRef', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-fetch-test-');
    await createBareRepoWithRemote(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns true when fetching an existing remote branch', async () => {
    const result = await fetchRef('origin', 'main', { cwd: join(tempDir, 'main') });
    expect(result).toBe(true);
  });

  it('returns false when fetching a nonexistent remote branch', async () => {
    const result = await fetchRef('origin', 'nonexistent', { cwd: join(tempDir, 'main') });
    expect(result).toBe(false);
  });

  it('returns false when remote does not exist', async () => {
    const noRemoteDir = await createTempDir('wt-no-remote-');
    await createBareRepo(noRemoteDir);

    const result = await fetchRef('origin', 'main', { cwd: join(noRemoteDir, 'main') });
    expect(result).toBe(false);

    await rm(noRemoteDir, { recursive: true, force: true });
  });
});

describe('refExists', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-refexists-test-');
    await createBareRepoWithRemote(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns true for an existing ref', async () => {
    const mainDir = join(tempDir, 'main');
    await fetchRef('origin', 'main', { cwd: mainDir });
    const result = await refExists('origin/main', { cwd: mainDir });
    expect(result).toBe(true);
  });

  it('returns false for a nonexistent ref', async () => {
    const result = await refExists('origin/nonexistent', { cwd: join(tempDir, 'main') });
    expect(result).toBe(false);
  });
});
