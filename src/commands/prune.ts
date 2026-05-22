/**
 * wt prune - Remove worktrees whose attached PR is merged at the local HEAD.
 */

import { Duration, Effect, Schema } from 'effect';
import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import {
  getBareRoot,
  getHeadOid,
  getWorktreeEntries,
  isBareRepo,
  removeWorktree,
  type WorktreeEntry,
} from '../git';

const GITHUB_CHECKS_PER_BATCH = 20;
const GITHUB_CHECK_CONCURRENCY = 5;
const GITHUB_BATCH_DELAY_MS = 60_000;

const PullRequestSchema = Schema.Struct({
  headRefOid: Schema.String,
  state: Schema.String,
  url: Schema.String,
});
const PullRequestsSchema = Schema.Array(PullRequestSchema);

type PullRequest = Schema.Schema.Type<typeof PullRequestSchema>;

interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type PruneCheck =
  | { kind: 'prune'; entry: WorktreeEntry; pullRequest: PullRequest }
  | { kind: 'keep'; entry: WorktreeEntry; reason: string };

interface RemovalResult {
  entry: WorktreeEntry;
  status: 'removed' | 'kept' | 'failed';
}

const HELP: CommandHelp = {
  name: 'wt prune',
  synopsis: 'wt prune',
  description: `Remove worktrees whose GitHub PR is merged and still points at the local HEAD.

Each worktree branch is checked with GitHub. wt prune only removes a worktree when
the branch has an attached PR, that PR is merged, and the PR head SHA matches the
worktree's current HEAD. This avoids deleting worktrees that have local follow-up
commits after the PR was merged.`,

  examples: ['wt prune'],

  notes: [
    'Requires the GitHub CLI (`gh`) to be installed and authenticated.',
    `GitHub checks are batched at ${GITHUB_CHECKS_PER_BATCH} worktrees per minute.`,
    'Must be run from within a bare repo (created by wt create).',
  ],
};

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function chunkWorktrees(entries: WorktreeEntry[]): WorktreeEntry[][] {
  const chunks: WorktreeEntry[][] = [];
  for (let index = 0; index < entries.length; index += GITHUB_CHECKS_PER_BATCH) {
    chunks.push(entries.slice(index, index + GITHUB_CHECKS_PER_BATCH));
  }
  return chunks;
}

function runGh(args: string[], cwd: string): Effect.Effect<GhResult, Error> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', cwd });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    },
    catch: toError,
  });
}

function parsePullRequests(raw: string): Effect.Effect<ReadonlyArray<PullRequest>, Error> {
  return Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(raw);
      if (Schema.is(PullRequestsSchema)(parsed)) return parsed;
      throw new Error('GitHub returned an unexpected PR payload');
    },
    catch: toError,
  });
}

function getPullRequest(entry: WorktreeEntry): Effect.Effect<PullRequest | null, Error> {
  return Effect.gen(function* () {
    const result = yield* runGh(
      [
        'pr',
        'list',
        '--head',
        entry.branch,
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'headRefOid,state,url',
      ],
      entry.path,
    );

    if (result.exitCode !== 0) {
      throw new Error(`gh pr list failed for ${entry.branch}: ${result.stderr}`);
    }

    const pullRequests = yield* parsePullRequests(result.stdout);
    return pullRequests[0] ?? null;
  });
}

function checkWorktree(entry: WorktreeEntry): Effect.Effect<PruneCheck, Error> {
  return Effect.gen(function* () {
    const localHeadOid = yield* Effect.tryPromise({
      try: () => getHeadOid(entry.path),
      catch: toError,
    });
    const pullRequest = yield* getPullRequest(entry);

    if (pullRequest === null) {
      return { kind: 'keep', entry, reason: 'no PR found' };
    }

    if (pullRequest.state !== 'MERGED') {
      return { kind: 'keep', entry, reason: `PR is ${pullRequest.state}` };
    }

    if (pullRequest.headRefOid !== localHeadOid) {
      return { kind: 'keep', entry, reason: 'PR HEAD does not match local HEAD' };
    }

    return { kind: 'prune', entry, pullRequest };
  });
}

function checkWorktreeBatch(batch: WorktreeEntry[]): Effect.Effect<PruneCheck[], Error> {
  return Effect.forEach(batch, checkWorktree, { concurrency: GITHUB_CHECK_CONCURRENCY });
}

function checkAllWorktrees(entries: WorktreeEntry[]): Effect.Effect<PruneCheck[], Error> {
  return Effect.gen(function* () {
    const batches = chunkWorktrees(entries);
    const checks: PruneCheck[] = [];

    for (const [index, batch] of batches.entries()) {
      const batchNumber = index + 1;
      if (batches.length > 1) {
        yield* Effect.sync(() => {
          console.error(`Checking GitHub batch ${batchNumber}/${batches.length}...`);
        });
      }

      const batchChecks = yield* checkWorktreeBatch(batch);
      checks.push(...batchChecks);

      if (batchNumber < batches.length) {
        yield* Effect.sync(() => {
          console.error('Waiting before the next GitHub batch to avoid API spam...');
        });
        yield* Effect.sleep(Duration.millis(GITHUB_BATCH_DELAY_MS));
      }
    }

    return checks;
  });
}

async function removePrunedWorktrees(
  bareRoot: string,
  checks: PruneCheck[],
): Promise<RemovalResult[]> {
  const results: RemovalResult[] = [];

  for (const check of checks) {
    if (check.kind === 'keep') {
      console.error(`Kept ${check.entry.branch}: ${check.reason}`);
      results.push({ entry: check.entry, status: 'kept' });
      continue;
    }

    try {
      console.error(`Removing ${check.entry.branch}: merged PR ${check.pullRequest.url}`);
      await removeWorktree(check.entry.path, { cwd: bareRoot });
      console.error(`Removed worktree: ${check.entry.branch}`);
      results.push({ entry: check.entry, status: 'removed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to remove ${check.entry.branch}: ${message}`);
      results.push({ entry: check.entry, status: 'failed' });
    }
  }

  return results;
}

function printSummary(results: RemovalResult[]): void {
  const removedCount = results.filter((result) => result.status === 'removed').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  const keptCount = results.length - removedCount - failedCount;
  console.error(
    `Prune complete: removed ${removedCount}, kept ${keptCount}, failed ${failedCount}.`,
  );
}

function hasFailedRemoval(results: RemovalResult[]): boolean {
  return results.some((result) => result.status === 'failed');
}

export const command: CommandHandler = {
  name: 'prune',
  description: 'Remove merged PR worktrees',
  getHelp: () => HELP,

  async execute(_args: string[]): Promise<number> {
    if (!(await isBareRepo())) {
      console.error(
        'Error: Not in a bare repo. wt prune only works with bare repo worktree setups.',
      );
      return 1;
    }

    const bareRoot = await getBareRoot();
    const entries = await getWorktreeEntries(bareRoot);

    if (entries.length === 0) {
      console.error('No worktrees to prune.');
      return 0;
    }

    console.error(`Pruning ${entries.length} worktrees...`);
    console.error(
      `Checking GitHub PRs in batches of ${GITHUB_CHECKS_PER_BATCH} ` +
        `with ${GITHUB_CHECK_CONCURRENCY} concurrent checks.`,
    );

    const checks = await Effect.runPromise(checkAllWorktrees(entries));
    const removals = await removePrunedWorktrees(bareRoot, checks);
    printSummary(removals);

    return hasFailedRemoval(removals) ? 1 : 0;
  },
};
