import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { rm } from 'fs/promises';
import { join } from 'path';
import { createTempDir, createBareRepo, runWt } from '../test-scaffold';
import { Effect, Layer } from 'effect';
import { Git, type GitService, Reporter, type ReporterService } from '../services';
import { makeListCommand } from './list';

function makeTestCommand(options: { isBareRepo?: boolean; output?: string; failure?: Error } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const git: GitService = {
    isBareRepo: Effect.succeed(options.isBareRepo ?? true),
    getBareRoot: Effect.fail(new Error('not needed')),
    listWorktrees: () =>
      options.failure !== undefined
        ? Effect.fail(options.failure)
        : Effect.succeed(options.output ?? '/repo/main abc123 [main]'),
    getWorktreeEntries: () => Effect.fail(new Error('not needed')),
    getHeadOid: () => Effect.fail(new Error('not needed')),
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

  return { command: makeListCommand(layer), stdout, stderr };
}

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

  it('lists worktrees through injected services', async () => {
    const { command, stdout, stderr } = makeTestCommand({ output: '/repo/main abc123 [main]' });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(0);
    expect(stdout).toEqual(['/repo/main abc123 [main]']);
    expect(stderr).toEqual([]);
  });

  it('returns an error through injected services when not in a bare repo', async () => {
    const { command, stdout, stderr } = makeTestCommand({ isBareRepo: false });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      'Error: Not in a bare repo. wt list only works with bare repo worktree setups.',
    ]);
  });
});
