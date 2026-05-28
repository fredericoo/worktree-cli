import { describe, expect, it } from 'bun:test';
import { Effect, Layer } from 'effect';
import type { WorktreeEntry } from '../git';
import { runWt } from '../test-scaffold';
import {
  Git,
  type GitService,
  Github,
  type GithubService,
  Reporter,
  type ReporterService,
} from '../services';
import { makePruneCommand } from './prune';

const bareRoot = '/repo';
const mainWorktree: WorktreeEntry = { path: '/repo/main', branch: 'main' };

function makeWorktree(branch: string): WorktreeEntry {
  return { path: `/repo/${branch}`, branch };
}

interface TestServices {
  command: ReturnType<typeof makePruneCommand>;
  logs: string[];
  removedWorktrees: string[];
}

interface TestServiceOptions {
  isBareRepo?: boolean;
  entries?: WorktreeEntry[];
  heads?: Record<string, string>;
  pullRequests?: Record<string, { headRefOid: string; state: string; url: string }>;
  failingRemovals?: Set<string>;
  stderrIsTty?: boolean;
}

function makeTestServices(options: TestServiceOptions = {}): TestServices {
  const logs: string[] = [];
  const removedWorktrees: string[] = [];
  const entries = options.entries ?? [mainWorktree];
  const heads = options.heads ?? {};
  const pullRequests = options.pullRequests ?? {};
  const failingRemovals = options.failingRemovals ?? new Set<string>();

  const git: GitService = {
    isStandardGitRepo: () => Effect.fail(new Error('not needed')),
    isBareRepo: Effect.succeed(options.isBareRepo ?? true),
    hasUncommittedChanges: () => Effect.fail(new Error('not needed')),
    getDefaultBranch: () => Effect.fail(new Error('not needed')),
    getUntrackedFiles: () => Effect.fail(new Error('not needed')),
    getBareRoot: Effect.succeed(bareRoot),
    listWorktrees: () => Effect.fail(new Error('not needed')),
    getWorktreeEntries: () => Effect.succeed(entries),
    findWorktreeByBranch: () => Effect.fail(new Error('not needed')),
    getHeadOid: (worktreePath) => Effect.succeed(heads[worktreePath] ?? 'local-head'),
    addWorktree: () => Effect.fail(new Error('not needed')),
    hasRemoteUrl: () => Effect.fail(new Error('not needed')),
    fetchRef: () => Effect.fail(new Error('not needed')),
    refExists: () => Effect.fail(new Error('not needed')),
    removeWorktree: (worktreePath) =>
      failingRemovals.has(worktreePath)
        ? Effect.fail(new Error('worktree contains uncommitted changes'))
        : Effect.sync(() => {
            removedWorktrees.push(worktreePath);
          }),
    deleteBranch: () => Effect.fail(new Error('not needed')),
    setConfig: () => Effect.fail(new Error('not needed')),
  };

  const github: GithubService = {
    getPullRequest: (entry) => Effect.succeed(pullRequests[entry.branch] ?? null),
  };

  const reporter: ReporterService = {
    stderrIsTty: options.stderrIsTty === true,
    log: (message) =>
      Effect.sync(() => {
        logs.push(message);
      }),
    writeStdout: () => Effect.sync(() => {}),
    writeStderr: (message) =>
      Effect.sync(() => {
        logs.push(message);
      }),
    writeStderrRaw: (message) =>
      Effect.sync(() => {
        logs.push(message);
      }),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(Git, git),
    Layer.succeed(Github, github),
    Layer.succeed(Reporter, reporter),
  );

  return { command: makePruneCommand(layer), logs, removedWorktrees };
}

describe('wt prune', () => {
  it('is available through the CLI command router', async () => {
    const result = await runWt(['prune']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('wt prune only works with bare repo worktree setups');
  });

  it('returns an error when not run in a bare repo', async () => {
    const { command, logs, removedWorktrees } = makeTestServices({ isBareRepo: false });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(1);
    expect(logs).toContain(
      'Error: Not in a bare repo. wt prune only works with bare repo worktree setups.',
    );
    expect(removedWorktrees).toEqual([]);
  });

  it('removes a worktree whose PR is merged at the local HEAD', async () => {
    const mergedWorktree = makeWorktree('merged-feature');
    const { command, logs, removedWorktrees } = makeTestServices({
      entries: [mainWorktree, mergedWorktree],
      heads: { [mergedWorktree.path]: 'merged-head' },
      pullRequests: {
        [mergedWorktree.branch]: {
          headRefOid: 'merged-head',
          state: 'MERGED',
          url: 'https://github.test/pull/1',
        },
      },
    });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(0);
    expect(removedWorktrees).toEqual([mergedWorktree.path]);
    expect(logs).toContain('Prune complete: removed 1, failed 0.');
    expect(logs).not.toContain('Prune complete: removed 1, kept 1, failed 0.');
  });

  it('keeps a worktree whose PR is not merged', async () => {
    const openWorktree = makeWorktree('open-feature');
    const { command, logs, removedWorktrees } = makeTestServices({
      entries: [openWorktree],
      pullRequests: {
        [openWorktree.branch]: {
          headRefOid: 'local-head',
          state: 'OPEN',
          url: 'https://github.test/pull/2',
        },
      },
    });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(0);
    expect(removedWorktrees).toEqual([]);
    expect(logs).toContain('Prune complete: removed 0, failed 0.');
    expect(logs.join('\n')).not.toContain(`Kept ${openWorktree.branch}`);
  });

  it('keeps a merged PR worktree when local HEAD has diverged', async () => {
    const advancedWorktree = makeWorktree('advanced-feature');
    const { command, logs, removedWorktrees } = makeTestServices({
      entries: [advancedWorktree],
      pullRequests: {
        [advancedWorktree.branch]: {
          headRefOid: 'merged-head',
          state: 'MERGED',
          url: 'https://github.test/pull/3',
        },
      },
    });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(0);
    expect(removedWorktrees).toEqual([]);
    expect(logs).toContain('Prune complete: removed 0, failed 0.');
  });

  it('fails when a prunable worktree cannot be removed safely', async () => {
    const dirtyWorktree = makeWorktree('dirty-feature');
    const { command, logs, removedWorktrees } = makeTestServices({
      entries: [dirtyWorktree],
      failingRemovals: new Set([dirtyWorktree.path]),
      pullRequests: {
        [dirtyWorktree.branch]: {
          headRefOid: 'local-head',
          state: 'MERGED',
          url: 'https://github.test/pull/4',
        },
      },
    });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(1);
    expect(removedWorktrees).toEqual([]);
    expect(logs).toContain('Prune complete: removed 0, failed 1.');
    const output = logs.join('\n');
    expect(output).toContain('Failures');
    expect(output).toContain('dirty-feature');
    expect(output).toContain('worktree contains uncommitted changes');
  });

  it('renders live worktree statuses when stderr is interactive', async () => {
    const mergedWorktree = makeWorktree('merged-feature');
    const openWorktree = makeWorktree('open-feature');
    const { command, logs } = makeTestServices({
      stderrIsTty: true,
      entries: [mergedWorktree, openWorktree],
      heads: { [mergedWorktree.path]: 'merged-head' },
      pullRequests: {
        [mergedWorktree.branch]: {
          headRefOid: 'merged-head',
          state: 'MERGED',
          url: 'https://github.test/pull/1',
        },
        [openWorktree.branch]: {
          headRefOid: 'local-head',
          state: 'OPEN',
          url: 'https://github.test/pull/2',
        },
      },
    });

    const exitCode = await command.execute([]);

    expect(exitCode).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('Pruning worktrees');
    expect(output).toContain('merged-feature');
    expect(output).toContain('pruned');
    expect(output).toContain('open-feature');
    expect(output).toContain('kept');
  });
});
