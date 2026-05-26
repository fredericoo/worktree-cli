import { Context, Effect, Layer, Schema } from 'effect';
import {
  getBareRoot,
  getHeadOid,
  getWorktreeEntries,
  isBareRepo,
  listWorktrees,
  removeWorktree,
  deleteBranch,
  type WorktreeEntry,
} from './git';

const PullRequestSchema = Schema.Struct({
  headRefOid: Schema.String,
  state: Schema.String,
  url: Schema.String,
});
const PullRequestsSchema = Schema.Array(PullRequestSchema);

export type PullRequest = Schema.Schema.Type<typeof PullRequestSchema>;

interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitService {
  readonly isBareRepo: Effect.Effect<boolean, Error>;
  readonly getBareRoot: Effect.Effect<string, Error>;
  readonly listWorktrees: () => Effect.Effect<string, Error>;
  readonly getWorktreeEntries: (bareRoot: string) => Effect.Effect<WorktreeEntry[], Error>;
  readonly getHeadOid: (worktreePath: string) => Effect.Effect<string, Error>;
  readonly removeWorktree: (
    worktreePath: string,
    bareRoot: string,
    options?: { force?: boolean },
  ) => Effect.Effect<void, Error>;
  readonly deleteBranch: (branch: string, bareRoot: string) => Effect.Effect<void, Error>;
}

export class Git extends Context.Tag('Git')<Git, GitService>() {}

export interface GithubService {
  readonly getPullRequest: (entry: WorktreeEntry) => Effect.Effect<PullRequest | null, Error>;
}

export class Github extends Context.Tag('Github')<Github, GithubService>() {}

export interface ReporterService {
  readonly log: (message: string) => Effect.Effect<void>;
  readonly writeStdout: (message: string) => Effect.Effect<void>;
  readonly writeStderr: (message: string) => Effect.Effect<void>;
}

export class Reporter extends Context.Tag('Reporter')<Reporter, ReporterService>() {}

export type CliServices = Git | Github | Reporter;

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function fromPromise<T>(operation: () => Promise<T>): Effect.Effect<T, Error> {
  return Effect.tryPromise({ try: operation, catch: toError });
}

function runGh(args: string[], cwd: string): Effect.Effect<GhResult, Error> {
  return fromPromise(async () => {
    const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', cwd });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
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

function makeGitService(): GitService {
  return {
    isBareRepo: fromPromise(() => isBareRepo()),
    getBareRoot: fromPromise(() => getBareRoot()),
    listWorktrees: () => fromPromise(() => listWorktrees()),
    getWorktreeEntries: (bareRoot) => fromPromise(() => getWorktreeEntries(bareRoot)),
    getHeadOid: (worktreePath) => fromPromise(() => getHeadOid(worktreePath)),
    removeWorktree: (worktreePath, bareRoot, options = {}) =>
      fromPromise(() => {
        const removeOptions =
          options.force === true ? { cwd: bareRoot, force: true } : { cwd: bareRoot };
        return removeWorktree(worktreePath, removeOptions);
      }),
    deleteBranch: (branch, bareRoot) => fromPromise(() => deleteBranch(branch, bareRoot)),
  };
}

function makeGithubService(): GithubService {
  return {
    getPullRequest: (entry) =>
      Effect.gen(function* () {
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
      }),
  };
}

function makeReporterService(): ReporterService {
  return {
    log: (message) => Effect.sync(() => console.error(message)),
    writeStdout: (message) => Effect.sync(() => console.log(message)),
    writeStderr: (message) => Effect.sync(() => console.error(message)),
  };
}

export function liveGitReporterLayer(): Layer.Layer<Git | Reporter> {
  return Layer.mergeAll(
    Layer.succeed(Git, makeGitService()),
    Layer.succeed(Reporter, makeReporterService()),
  );
}

export function liveCliLayer(): Layer.Layer<CliServices> {
  return Layer.mergeAll(liveGitReporterLayer(), Layer.succeed(Github, makeGithubService()));
}
