import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { readdir, readFile, stat, rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, initGitRepo, runWt } from '../test-scaffold';
import { Effect, Layer } from 'effect';
import {
  FileSystem,
  type FileSystemService,
  Git,
  type GitService,
  Reporter,
  type ReporterService,
} from '../services';
import { makeCreateCommand } from './create';

const repoDir = '/repo';
const tempStagingDir = '/repo/.wt-staging-abc';

function makeTestCommand(options: { addWorktreeFailure?: Error } = {}) {
  const gitOps: string[] = [];
  const fsOps: string[] = [];
  const stderr: string[] = [];

  const git: GitService = {
    isStandardGitRepo: () => Effect.succeed(true),
    isBareRepo: Effect.fail(new Error('not needed')),
    hasUncommittedChanges: () => Effect.succeed(false),
    getDefaultBranch: () => Effect.succeed({ branch: 'main', isDefault: true }),
    getUntrackedFiles: () => Effect.succeed([]),
    getBareRoot: Effect.fail(new Error('not needed')),
    listWorktrees: () => Effect.fail(new Error('not needed')),
    getWorktreeEntries: () => Effect.fail(new Error('not needed')),
    findWorktreeByBranch: () => Effect.fail(new Error('not needed')),
    getHeadOid: () => Effect.fail(new Error('not needed')),
    addWorktree: (worktreePath, branch) =>
      options.addWorktreeFailure !== undefined
        ? Effect.fail(options.addWorktreeFailure)
        : Effect.sync(() => {
            gitOps.push(`addWorktree ${worktreePath} ${branch}`);
          }),
    hasRemoteUrl: () => Effect.fail(new Error('not needed')),
    fetchRef: () => Effect.fail(new Error('not needed')),
    refExists: () => Effect.fail(new Error('not needed')),
    removeWorktree: () => Effect.fail(new Error('not needed')),
    deleteBranch: () => Effect.fail(new Error('not needed')),
    setConfig: (key, value) =>
      Effect.sync(() => {
        gitOps.push(`setConfig ${key} ${value}`);
      }),
  };

  const fs: FileSystemService = {
    makeTempDir: () => Effect.succeed(tempStagingDir),
    readDir: (dir) =>
      Effect.succeed(
        dir === repoDir
          ? [{ name: '.git' }, { name: 'README.md' }, { name: '.wt-staging-old' }]
          : [{ name: 'README.md' }],
      ),
    rename: (from, to) =>
      Effect.sync(() => {
        fsOps.push(`rename ${from} ${to}`);
      }),
    exists: (path) => Effect.succeed(path === `${repoDir}/.bare` ? true : false),
    isFile: (path) => Effect.succeed(path === `${repoDir}/.git`),
    makeDir: (path) =>
      Effect.sync(() => {
        fsOps.push(`mkdir ${path}`);
      }),
    remove: (path) =>
      Effect.sync(() => {
        fsOps.push(`remove ${path}`);
      }),
    writeFile: (path, contents) =>
      Effect.sync(() => {
        fsOps.push(`write ${path} ${contents.trim()}`);
      }),
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
    createTaskLog: (title) => ({
      message: (message) => stderr.push(`${title}\n${message}`),
      success: (message) => stderr.push(message),
      error: (message) => stderr.push(message),
    }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(Git, git),
    Layer.succeed(FileSystem, fs),
    Layer.succeed(Reporter, reporter),
  );

  return { command: makeCreateCommand(layer), fsOps, gitOps, stderr };
}

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

  it('converts a repo through injected services', async () => {
    const { command, fsOps, gitOps, stderr } = makeTestCommand();

    const exitCode = await command.execute([repoDir]);

    expect(exitCode).toBe(0);
    expect(fsOps).toContain('rename /repo/.git /repo/.bare');
    expect(fsOps).toContain('write /repo/.git gitdir: .bare');
    expect(fsOps).toContain('rename /repo/README.md /repo/.wt-staging-abc/README.md');
    expect(fsOps).toContain('remove /repo/.wt-staging-abc');
    expect(gitOps).toContain('setConfig core.bare true');
    expect(gitOps).toContain('addWorktree /repo/main main');
    expect(stderr).toContain('Done! New structure:');
  });

  it('rolls back when worktree creation fails through injected services', async () => {
    const { command, fsOps, gitOps, stderr } = makeTestCommand({
      addWorktreeFailure: new Error('add worktree failed'),
    });

    const exitCode = await command.execute([repoDir]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Attempting rollback...');
    expect(stderr).toContain('Rollback complete. Repository should be in its original state.');
    expect(fsOps).toContain('remove /repo/.git');
    expect(fsOps).toContain('rename /repo/.bare /repo/.git');
    expect(fsOps).toContain('rename /repo/.wt-staging-abc/README.md /repo/README.md');
    expect(gitOps).toContain('setConfig core.bare false');
  });
});
