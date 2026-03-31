import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { readdir, readFile, stat, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, initGitRepo, runWt } from '../test-scaffold';

describe('wt create', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir('wt-create-test-');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('converts a standard git repo to bare layout', async () => {
    await initGitRepo(tempDir);

    const result = await runWt(['create', tempDir]);
    expect(result.exitCode).toBe(0);

    const bareInfo = await stat(join(tempDir, '.bare'));
    expect(bareInfo.isDirectory()).toBe(true);

    const gitInfo = await stat(join(tempDir, '.git'));
    expect(gitInfo.isFile()).toBe(true);

    const gitContent = await readFile(join(tempDir, '.git'), 'utf-8');
    expect(gitContent.trim()).toBe('gitdir: .bare');

    const mainInfo = await stat(join(tempDir, 'main'));
    expect(mainInfo.isDirectory()).toBe(true);

    const mainReadme = await readFile(join(tempDir, 'main', 'README.md'), 'utf-8');
    expect(mainReadme).toBe('# Test Repo\n');
  });

  it('preserves untracked files', async () => {
    await initGitRepo(tempDir);
    await Bun.write(join(tempDir, 'untracked.txt'), 'preserve me');

    const result = await runWt(['create', tempDir]);
    expect(result.exitCode).toBe(0);

    const content = await readFile(join(tempDir, 'main', 'untracked.txt'), 'utf-8');
    expect(content).toBe('preserve me');
  });

  it('fails on non-git directory', async () => {
    const result = await runWt(['create', tempDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No .git directory');
  });

  it('fails with uncommitted changes', async () => {
    await initGitRepo(tempDir);
    await Bun.write(join(tempDir, 'README.md'), 'modified');

    const result = await runWt(['create', tempDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('uncommitted changes');
  });

  it('preserves dotfiles during conversion', async () => {
    await initGitRepo(tempDir);
    await Bun.write(join(tempDir, '.gitignore'), 'node_modules/\n');
    await Bun.spawn(['git', '-C', tempDir, 'add', '.gitignore'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;
    await Bun.spawn(['git', '-C', tempDir, 'commit', '-m', 'add gitignore'], {
      stdout: 'pipe',
      stderr: 'pipe',
    }).exited;

    const result = await runWt(['create', tempDir]);
    expect(result.exitCode).toBe(0);

    const gitignoreContent = await readFile(join(tempDir, 'main', '.gitignore'), 'utf-8');
    expect(gitignoreContent).toBe('node_modules/\n');
  });

  it('cleans up working files from repo root', async () => {
    await initGitRepo(tempDir);

    const result = await runWt(['create', tempDir]);
    expect(result.exitCode).toBe(0);

    const entries = await readdir(tempDir);
    const sorted = entries.sort();
    expect(sorted).toEqual(['.bare', '.git', 'main']);
  });
});
