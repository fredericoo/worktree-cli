/**
 * wt prune - Remove worktrees whose attached PR is merged at the local HEAD.
 */

import { Duration, Effect, Layer } from 'effect';
import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import type { WorktreeEntry } from '../git';
import {
  Git,
  Github,
  liveCliLayer,
  Reporter,
  type CliServices,
  type GitService,
  type PullRequest,
} from '../services';

const GITHUB_CHECKS_PER_BATCH = 20;
const GITHUB_CHECK_CONCURRENCY = 5;
const GITHUB_BATCH_DELAY_MS = 60_000;

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

function chunkWorktrees(entries: WorktreeEntry[]): WorktreeEntry[][] {
  const chunks: WorktreeEntry[][] = [];
  for (let index = 0; index < entries.length; index += GITHUB_CHECKS_PER_BATCH) {
    chunks.push(entries.slice(index, index + GITHUB_CHECKS_PER_BATCH));
  }
  return chunks;
}

function checkWorktree(entry: WorktreeEntry): Effect.Effect<PruneCheck, Error, Git | Github> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const github = yield* Github;
    const localHeadOid = yield* git.getHeadOid(entry.path);
    const pullRequest = yield* github.getPullRequest(entry);

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

function checkWorktreeBatch(
  batch: WorktreeEntry[],
): Effect.Effect<PruneCheck[], Error, Git | Github> {
  return Effect.forEach(batch, checkWorktree, { concurrency: GITHUB_CHECK_CONCURRENCY });
}

function log(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.log(message);
  });
}

function checkAllWorktrees(
  entries: WorktreeEntry[],
): Effect.Effect<PruneCheck[], Error, CliServices> {
  return Effect.gen(function* () {
    const batches = chunkWorktrees(entries);
    const checks: PruneCheck[] = [];

    for (const [index, batch] of batches.entries()) {
      const batchNumber = index + 1;
      if (batches.length > 1) {
        yield* log(`Checking GitHub batch ${batchNumber}/${batches.length}...`);
      }

      const batchChecks = yield* checkWorktreeBatch(batch);
      checks.push(...batchChecks);

      if (batchNumber < batches.length) {
        yield* log('Waiting before the next GitHub batch to avoid API spam...');
        yield* Effect.sleep(Duration.millis(GITHUB_BATCH_DELAY_MS));
      }
    }

    return checks;
  });
}

function removePrunedWorktrees(
  bareRoot: string,
  checks: PruneCheck[],
): Effect.Effect<RemovalResult[], never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const results: RemovalResult[] = [];

    for (const check of checks) {
      if (check.kind === 'keep') {
        yield* log(`Kept ${check.entry.branch}: ${check.reason}`);
        results.push({ entry: check.entry, status: 'kept' });
        continue;
      }

      const result = yield* removeWorktreeForCheck(git, bareRoot, check);
      results.push(result);
    }

    return results;
  });
}

function removeWorktreeForCheck(
  git: GitService,
  bareRoot: string,
  check: Extract<PruneCheck, { kind: 'prune' }>,
): Effect.Effect<RemovalResult, never, Reporter> {
  return Effect.gen(function* () {
    yield* log(`Removing ${check.entry.branch}: merged PR ${check.pullRequest.url}`);

    const removed = yield* Effect.either(git.removeWorktree(check.entry.path, bareRoot));
    if (removed._tag === 'Right') {
      yield* log(`Removed worktree: ${check.entry.branch}`);
      return { entry: check.entry, status: 'removed' };
    }

    yield* log(`Failed to remove ${check.entry.branch}: ${removed.left.message}`);
    return { entry: check.entry, status: 'failed' };
  });
}

function summarize(results: RemovalResult[]): string {
  const removedCount = results.filter((result) => result.status === 'removed').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  const keptCount = results.length - removedCount - failedCount;
  return `Prune complete: removed ${removedCount}, kept ${keptCount}, failed ${failedCount}.`;
}

function hasFailedRemoval(results: RemovalResult[]): boolean {
  return results.some((result) => result.status === 'failed');
}

export function pruneProgram(): Effect.Effect<number, Error, CliServices> {
  return Effect.gen(function* () {
    const git = yield* Git;

    if (!(yield* git.isBareRepo)) {
      yield* log('Error: Not in a bare repo. wt prune only works with bare repo worktree setups.');
      return 1;
    }

    const bareRoot = yield* git.getBareRoot;
    const entries = yield* git.getWorktreeEntries(bareRoot);

    if (entries.length === 0) {
      yield* log('No worktrees to prune.');
      return 0;
    }

    yield* log(`Pruning ${entries.length} worktrees...`);
    yield* log(
      `Checking GitHub PRs in batches of ${GITHUB_CHECKS_PER_BATCH} ` +
        `with ${GITHUB_CHECK_CONCURRENCY} concurrent checks.`,
    );

    const checks = yield* checkAllWorktrees(entries);
    const removals = yield* removePrunedWorktrees(bareRoot, checks);
    yield* log(summarize(removals));

    return hasFailedRemoval(removals) ? 1 : 0;
  });
}

export function makePruneCommand(layer: Layer.Layer<CliServices>): CommandHandler {
  return {
    name: 'prune',
    description: 'Remove merged PR worktrees',
    getHelp: () => HELP,
    execute: () => Effect.runPromise(Effect.provide(pruneProgram(), layer)),
  };
}

export const command: CommandHandler = makePruneCommand(liveCliLayer());
