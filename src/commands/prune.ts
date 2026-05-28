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
  type TaskLog,
} from '../services';

const GITHUB_CHECKS_PER_BATCH = 20;
const GITHUB_CHECK_CONCURRENCY = 5;
const GITHUB_BATCH_DELAY_MS = 60_000;
const MAX_VISIBLE_WORKTREES = 50;
const FAILURE_REASON_MAX_WIDTH = 96;

type PruneStatus = 'checking' | 'pruning' | 'pruned' | 'failed' | 'kept';

type PruneCheck =
  | { kind: 'prune'; entry: WorktreeEntry; pullRequest: PullRequest }
  | { kind: 'keep'; entry: WorktreeEntry; reason: string };

interface RemovalResult {
  entry: WorktreeEntry;
  status: 'removed' | 'kept' | 'failed';
  reason?: string;
}

interface DashboardRow {
  entry: WorktreeEntry;
  status: PruneStatus;
  detail: string;
}

interface PruneDashboard {
  rows: DashboardRow[];
  checkedCount: number;
  log: TaskLog | null;
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

function color(text: string, code: number): string {
  if (isNoColorSet()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function statusLabel(status: PruneStatus): string {
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
}

function makeDashboard(entries: WorktreeEntry[]): PruneDashboard {
  return {
    rows: entries.map((entry) => ({ entry, status: 'checking', detail: '' })),
    checkedCount: 0,
    log: null,
  };
}

function updateDashboardRow(
  dashboard: PruneDashboard,
  entry: WorktreeEntry,
  status: PruneStatus,
  detail = '',
): void {
  const row = dashboard.rows.find((candidate) => candidate.entry.branch === entry.branch);
  if (row === undefined) return;
  row.status = status;
  row.detail = detail;
}

function visibleDashboardRows(rows: DashboardRow[]): DashboardRow[] {
  return rows.slice(0, MAX_VISIBLE_WORKTREES);
}

function formatDashboard(dashboard: PruneDashboard): string {
  const totalCount = dashboard.rows.length;
  const lines = [`${bold('Status')} ${dashboard.checkedCount}/${totalCount} checked`];

  for (const row of visibleDashboardRows(dashboard.rows)) {
    const detail = row.detail !== '' ? dim(` ${row.detail}`) : '';
    lines.push(`  ${statusLabel(row.status)}  ${row.entry.branch}${detail}`);
  }

  const remainingCount = dashboard.rows.length - MAX_VISIBLE_WORKTREES;
  if (remainingCount > 0) {
    lines.push(dim(`  …${remainingCount} more`));
  }

  return lines.join('\n');
}

function renderDashboard(dashboard: PruneDashboard): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    if (!reporter.stderrIsTty) return;

    dashboard.log ??= reporter.createTaskLog('Pruning worktrees', {
      limit: MAX_VISIBLE_WORKTREES + 2,
      retainLog: true,
    });
    dashboard.log.message(formatDashboard(dashboard), { raw: true });
  });
}

function finishDashboard(
  dashboard: PruneDashboard,
  summary: string,
  failed: boolean,
): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;

    if (!reporter.stderrIsTty) {
      yield* reporter.writeStderr(summary);
      return;
    }

    dashboard.log ??= reporter.createTaskLog('Pruning worktrees', {
      limit: MAX_VISIBLE_WORKTREES + 2,
      retainLog: true,
    });
    dashboard.log.message(formatDashboard(dashboard), { raw: true });

    if (failed) {
      dashboard.log.error(summary, { showLog: true });
    } else {
      dashboard.log.success(summary, { showLog: true });
    }
  });
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
  dashboard: PruneDashboard,
): Effect.Effect<PruneCheck[], Error, CliServices> {
  return Effect.forEach(batch, (entry) => checkWorktreeWithDashboard(entry, dashboard), {
    concurrency: GITHUB_CHECK_CONCURRENCY,
  });
}

function writeStderr(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStderr(message);
  });
}

function checkWorktreeWithDashboard(
  entry: WorktreeEntry,
  dashboard: PruneDashboard,
): Effect.Effect<PruneCheck, Error, CliServices> {
  return Effect.gen(function* () {
    updateDashboardRow(dashboard, entry, 'checking');
    yield* renderDashboard(dashboard);

    const result = yield* checkWorktree(entry);
    dashboard.checkedCount++;

    if (result.kind === 'keep') {
      updateDashboardRow(dashboard, entry, 'kept', result.reason);
    } else {
      updateDashboardRow(dashboard, entry, 'pruning', result.pullRequest.url);
    }

    yield* renderDashboard(dashboard);
    return result;
  });
}

function checkAllWorktrees(
  entries: WorktreeEntry[],
  dashboard: PruneDashboard,
): Effect.Effect<PruneCheck[], Error, CliServices> {
  return Effect.gen(function* () {
    const batches = chunkWorktrees(entries);
    const checks: PruneCheck[] = [];

    for (const [index, batch] of batches.entries()) {
      const batchNumber = index + 1;

      const batchChecks = yield* checkWorktreeBatch(batch, dashboard);
      checks.push(...batchChecks);

      if (batchNumber < batches.length) {
        yield* Effect.sleep(Duration.millis(GITHUB_BATCH_DELAY_MS));
      }
    }

    return checks;
  });
}

function removePrunedWorktrees(
  bareRoot: string,
  checks: PruneCheck[],
  dashboard: PruneDashboard,
): Effect.Effect<RemovalResult[], never, Git | Reporter> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const results: RemovalResult[] = [];

    for (const check of checks) {
      if (check.kind === 'keep') {
        results.push({ entry: check.entry, status: 'kept' });
        continue;
      }

      const result = yield* removeWorktreeForCheck(git, bareRoot, check, dashboard);
      results.push(result);
    }

    return results;
  });
}

function removeWorktreeForCheck(
  git: GitService,
  bareRoot: string,
  check: Extract<PruneCheck, { kind: 'prune' }>,
  dashboard: PruneDashboard,
): Effect.Effect<RemovalResult, never, Reporter> {
  return Effect.gen(function* () {
    updateDashboardRow(dashboard, check.entry, 'pruning', check.pullRequest.url);
    yield* renderDashboard(dashboard);

    const removed = yield* Effect.either(git.removeWorktree(check.entry.path, bareRoot));
    if (removed._tag === 'Right') {
      updateDashboardRow(dashboard, check.entry, 'pruned');
      yield* renderDashboard(dashboard);
      return { entry: check.entry, status: 'removed' };
    }

    updateDashboardRow(dashboard, check.entry, 'failed', removed.left.message);
    yield* renderDashboard(dashboard);
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

    const dashboard = makeDashboard(entries);
    yield* renderDashboard(dashboard);

    const checks = yield* checkAllWorktrees(entries, dashboard);
    const removals = yield* removePrunedWorktrees(bareRoot, checks, dashboard);
    const summary = summarize(removals);
    const failed = hasFailedRemoval(removals);
    yield* finishDashboard(dashboard, summary, failed);

    const failureTable = formatFailureTable(removals);
    if (failureTable !== null) {
      yield* writeStderr(failureTable);
    }

    return failed ? 1 : 0;
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
