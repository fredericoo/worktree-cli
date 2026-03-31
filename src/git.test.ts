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
} from './git';

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
