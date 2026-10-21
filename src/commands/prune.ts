/**
 * wt prune - Remove worktrees whose attached PR is merged at the local HEAD.
 */

import { Duration, Effect, Layer } from 'effect';
import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { bold, dim, isNoColorSet } from '../help.js';
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
const GITHUB_BATCH_DELAY_MS = 5_000;
const FAILURE_REASON_MAX_WIDTH = 96;

type PruneCheck =
  | { kind: 'prune'; entry: WorktreeEntry; pullRequest: PullRequest }
  | { kind: 'keep'; entry: WorktreeEntry; reason: string };

interface RemovalResult {
  entry: WorktreeEntry;
  status: 'removed' | 'kept' | 'failed';
  reason?: string;
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

function color(text: string, code: number): string {
  if (isNoColorSet()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function statusLine(
  status: 'checking' | 'pruning' | 'pruned' | 'failed' | 'kept',
  branch: string,
  detail = '',
): string {
  const label = (() => {
    switch (status) {
      case 'checking':
        return color('checking', 33);
      case 'pruning':
        return color('pruning ', 36);
      case 'pruned':
        return color('pruned  ', 32);
      case 'failed':
        return color('failed  ', 31);
      case 'kept':
        return dim('kept    ');
    }
  })();

  const suffix = detail === '' ? '' : dim(` ${detail}`);
  return `  ${label}  ${branch}${suffix}`;
}

function chunkWorktrees(entries: WorktreeEntry[]): WorktreeEntry[][] {
  const chunks: WorktreeEntry[][] = [];
  for (let index = 0; index < entries.length; index += GITHUB_CHECKS_PER_BATCH) {
    chunks.push(entries.slice(index, index + GITHUB_CHECKS_PER_BATCH));
  }
  return chunks;
}

function writeStderr(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStderr(message);
  });
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

function checkWorktreeWithStatus(
  entry: WorktreeEntry,
): Effect.Effect<PruneCheck, Error, CliServices> {
  return Effect.gen(function* () {
    const result = yield* checkWorktree(entry);

    if (result.kind === 'keep') {
      yield* writeStderr(statusLine('kept', entry.branch, result.reason));
    } else {
      yield* writeStderr(statusLine('pruning', entry.branch, result.pullRequest.url));
    }

    return result;
  });
}

function checkWorktreeBatch(
  batch: WorktreeEntry[],
): Effect.Effect<PruneCheck[], Error, CliServices> {
  return Effect.forEach(batch, checkWorktreeWithStatus, { concurrency: GITHUB_CHECK_CONCURRENCY });
}

function checkAllWorktrees(
  entries: WorktreeEntry[],
): Effect.Effect<PruneCheck[], Error, CliServices> {
  return Effect.gen(function* () {
    const batches = chunkWorktrees(entries);
    const checks: PruneCheck[] = [];

    for (const [index, batch] of batches.entries()) {
      yield* writeStderr(
        `${bold('Checking batch')} ${index + 1}/${batches.length} (${batch.length} worktrees)`,
      );
      checks.push(...(yield* checkWorktreeBatch(batch)));

      if (index + 1 < batches.length) {
        yield* writeStderr(
          dim(`Waiting ${GITHUB_BATCH_DELAY_MS / 1_000}s before next GitHub batch...`),
        );
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
        results.push({ entry: check.entry, status: 'kept' });
        continue;
      }

      results.push(yield* removeWorktreeForCheck(git, bareRoot, check));
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
    const removed = yield* Effect.either(git.removeWorktree(check.entry.path, bareRoot));
    if (removed._tag === 'Right') {
      yield* writeStderr(statusLine('pruned', check.entry.branch));
      return { entry: check.entry, status: 'removed' };
    }

    yield* writeStderr(statusLine('failed', check.entry.branch, removed.left.message));
    return { entry: check.entry, status: 'failed', reason: removed.left.message };
  });
}

function summarize(results: RemovalResult[]): string {
  const removedCount = results.filter((result) => result.status === 'removed').length;
  const failedCount = results.filter((result) => result.status === 'failed').length;
  return `Prune complete: removed ${removedCount}, failed ${failedCount}.`;
}

function hasFailedRemoval(results: RemovalResult[]): boolean {
  return results.some((result) => result.status === 'failed');
}

function truncate(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, maxWidth - 1)}…`;
}

function pad(text: string, width: number): string {
  return text.padEnd(width, ' ');
}

function formatFailureTable(results: RemovalResult[]): string | null {
  const failures = results.filter((result) => result.status === 'failed');
  if (failures.length === 0) return null;

  const rows = failures.map((failure) => ({
    worktree: failure.entry.branch,
    reason: truncate(failure.reason ?? 'Unknown error', FAILURE_REASON_MAX_WIDTH),
  }));
  const worktreeWidth = Math.max('Worktree'.length, ...rows.map((row) => row.worktree.length));
  const reasonWidth = Math.max('Reason'.length, ...rows.map((row) => row.reason.length));
  const top = `┌${'─'.repeat(worktreeWidth + 2)}┬${'─'.repeat(reasonWidth + 2)}┐`;
  const header = `│ ${pad('Worktree', worktreeWidth)} │ ${pad('Reason', reasonWidth)} │`;
  const separator = `├${'─'.repeat(worktreeWidth + 2)}┼${'─'.repeat(reasonWidth + 2)}┤`;
  const body = rows.map(
    (row) => `│ ${pad(row.worktree, worktreeWidth)} │ ${pad(row.reason, reasonWidth)} │`,
  );
  const bottom = `└${'─'.repeat(worktreeWidth + 2)}┴${'─'.repeat(reasonWidth + 2)}┘`;
  return [color('Failures', 31), top, header, separator, ...body, bottom].join('\n');
}

export function pruneProgram(): Effect.Effect<number, Error, CliServices> {
  return Effect.gen(function* () {
    const git = yield* Git;

    if (!(yield* git.isBareRepo)) {
      yield* writeStderr(
        'Error: Not in a bare repo. wt prune only works with bare repo worktree setups.',
      );
      return 1;
    }

    const bareRoot = yield* git.getBareRoot;
    const entries = yield* git.getWorktreeEntries(bareRoot);

    if (entries.length === 0) {
      yield* writeStderr('No worktrees to prune.');
      return 0;
    }

    yield* writeStderr(`${bold('Pruning')} ${entries.length} worktrees...`);
    const checks = yield* checkAllWorktrees(entries);
    const removals = yield* removePrunedWorktrees(bareRoot, checks);
    yield* writeStderr(summarize(removals));

    const failureTable = formatFailureTable(removals);
    if (failureTable !== null) {
      yield* writeStderr(failureTable);
    }

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
