import { Context, Effect, Layer, Schema } from 'effect';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'fs/promises';
import { isCancel, stderrCancel, stderrLog, stderrSelect, stderrText } from './interactive';
import {
  getDefaultBranch,
  getBareRoot,
  getHeadOid,
  getUntrackedFiles,
  getWorktreeEntries,
  addWorktree,
  fetchRef,
  refExists,
  hasRemoteUrl,
  findWorktreeByBranch,
  isBareRepo,
  isStandardGitRepo,
  hasUncommittedChanges,
  listWorktrees,
  removeWorktree,
  deleteBranch,
  setConfig,
  type AddWorktreeOptions,
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
  readonly isStandardGitRepo: (repoDir: string) => Effect.Effect<boolean, Error>;
  readonly isBareRepo: Effect.Effect<boolean, Error>;
  readonly hasUncommittedChanges: (repoDir: string) => Effect.Effect<boolean, Error>;
  readonly getDefaultBranch: (
    repoDir: string,
  ) => Effect.Effect<{ branch: string; isDefault: boolean }, Error>;
  readonly getUntrackedFiles: (repoDir: string) => Effect.Effect<string[], Error>;
  readonly getBareRoot: Effect.Effect<string, Error>;
  readonly listWorktrees: () => Effect.Effect<string, Error>;
  readonly getWorktreeEntries: (bareRoot: string) => Effect.Effect<WorktreeEntry[], Error>;
  readonly findWorktreeByBranch: (
    branch: string,
    bareRoot: string,
  ) => Effect.Effect<string | null, Error>;
  readonly getHeadOid: (worktreePath: string) => Effect.Effect<string, Error>;
  readonly addWorktree: (
    worktreePath: string,
    branch: string,
    options: AddWorktreeOptions,
  ) => Effect.Effect<void, Error>;
  readonly hasRemoteUrl: (remote: string, bareRoot: string) => Effect.Effect<boolean, Error>;
  readonly fetchRef: (
    remote: string,
    ref: string,
    bareRoot: string,
  ) => Effect.Effect<boolean, Error>;
  readonly refExists: (ref: string, bareRoot: string) => Effect.Effect<boolean, Error>;
  readonly removeWorktree: (
    worktreePath: string,
    bareRoot: string,
    options?: { force?: boolean },
  ) => Effect.Effect<void, Error>;
  readonly deleteBranch: (branch: string, bareRoot: string) => Effect.Effect<void, Error>;
  readonly setConfig: (key: string, value: string, repoDir: string) => Effect.Effect<void, Error>;
}

export class Git extends Context.Tag('Git')<Git, GitService>() {}

export interface GithubService {
  readonly getPullRequest: (entry: WorktreeEntry) => Effect.Effect<PullRequest | null, Error>;
}

export class Github extends Context.Tag('Github')<Github, GithubService>() {}

export interface ReporterService {
  readonly stderrIsTty: boolean;
  readonly log: (message: string) => Effect.Effect<void>;
  readonly writeStdout: (message: string) => Effect.Effect<void>;
  readonly writeStderr: (message: string) => Effect.Effect<void>;
  readonly writeStderrRaw: (message: string) => Effect.Effect<void>;
}

export class Reporter extends Context.Tag('Reporter')<Reporter, ReporterService>() {}

export interface FileSystemEntry {
  readonly name: string;
}

export interface FileSystemService {
  readonly makeTempDir: (parentDir: string, prefix: string) => Effect.Effect<string, Error>;
  readonly readDir: (dir: string) => Effect.Effect<FileSystemEntry[], Error>;
  readonly rename: (from: string, to: string) => Effect.Effect<void, Error>;
  readonly exists: (path: string) => Effect.Effect<boolean, Error>;
  readonly isFile: (path: string) => Effect.Effect<boolean, Error>;
  readonly makeDir: (path: string) => Effect.Effect<void, Error>;
  readonly remove: (path: string) => Effect.Effect<void, Error>;
  readonly writeFile: (path: string, contents: string) => Effect.Effect<void, Error>;
}

export class FileSystem extends Context.Tag('FileSystem')<FileSystem, FileSystemService>() {}

export interface InteractiveOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface InteractiveService {
  readonly select: (
    message: string,
    options: InteractiveOption[],
  ) => Effect.Effect<string | symbol, Error>;
  readonly text: (
    message: string,
    validate: (value: string | undefined) => string | undefined,
  ) => Effect.Effect<string | symbol, Error>;
  readonly isCancel: (value: unknown) => boolean;
  readonly cancel: () => Effect.Effect<void>;
  readonly warn: (message: string) => Effect.Effect<void>;
}

export class Interactive extends Context.Tag('Interactive')<Interactive, InteractiveService>() {}

export type CliServices = Git | Github | Reporter;
export type CreateServices = Git | Reporter | FileSystem;
export type PromptServices = Git | Reporter | Interactive;

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
    isStandardGitRepo: (repoDir) => fromPromise(() => isStandardGitRepo(repoDir)),
    isBareRepo: fromPromise(() => isBareRepo()),
    hasUncommittedChanges: (repoDir) => fromPromise(() => hasUncommittedChanges(repoDir)),
    getDefaultBranch: (repoDir) => fromPromise(() => getDefaultBranch(repoDir)),
    getUntrackedFiles: (repoDir) => fromPromise(() => getUntrackedFiles(repoDir)),
    getBareRoot: fromPromise(() => getBareRoot()),
    listWorktrees: () => fromPromise(() => listWorktrees()),
    getWorktreeEntries: (bareRoot) => fromPromise(() => getWorktreeEntries(bareRoot)),
    findWorktreeByBranch: (branch, bareRoot) =>
      fromPromise(() => findWorktreeByBranch(branch, bareRoot)),
    getHeadOid: (worktreePath) => fromPromise(() => getHeadOid(worktreePath)),
    addWorktree: (worktreePath, branch, options) =>
      fromPromise(() => addWorktree(worktreePath, branch, options)),
    hasRemoteUrl: (remote, bareRoot) => fromPromise(() => hasRemoteUrl(remote, { cwd: bareRoot })),
    fetchRef: (remote, ref, bareRoot) =>
      fromPromise(() => fetchRef(remote, ref, { cwd: bareRoot })),
    refExists: (ref, bareRoot) => fromPromise(() => refExists(ref, { cwd: bareRoot })),
    removeWorktree: (worktreePath, bareRoot, options = {}) =>
      fromPromise(() => {
        const removeOptions =
          options.force === true ? { cwd: bareRoot, force: true } : { cwd: bareRoot };
        return removeWorktree(worktreePath, removeOptions);
      }),
    deleteBranch: (branch, bareRoot) => fromPromise(() => deleteBranch(branch, bareRoot)),
    setConfig: (key, value, repoDir) => fromPromise(() => setConfig(key, value, repoDir)),
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
    stderrIsTty: process.stderr.isTTY === true,
    log: (message) => Effect.sync(() => console.error(message)),
    writeStdout: (message) => Effect.sync(() => console.log(message)),
    writeStderr: (message) => Effect.sync(() => console.error(message)),
    writeStderrRaw: (message) => Effect.sync(() => process.stderr.write(message)),
  };
}

function makeFileSystemService(): FileSystemService {
  return {
    makeTempDir: (parentDir, prefix) => fromPromise(() => mkdtemp(`${parentDir}/${prefix}`)),
    readDir: (dir) => fromPromise(async () => await readdir(dir, { withFileTypes: true })),
    rename: (from, to) => fromPromise(() => rename(from, to)),
    exists: (path) =>
      Effect.gen(function* () {
        const result = yield* Effect.either(fromPromise(() => stat(path)));
        return result._tag === 'Right';
      }),
    isFile: (path) =>
      Effect.gen(function* () {
        const result = yield* Effect.either(fromPromise(() => stat(path)));
        return result._tag === 'Right' && result.right.isFile();
      }),
    makeDir: (path) =>
      fromPromise(async () => {
        await mkdir(path, { recursive: true });
      }),
    remove: (path) => fromPromise(() => rm(path, { recursive: true, force: true })),
    writeFile: (path, contents) => fromPromise(() => Bun.write(path, contents).then(() => {})),
  };
}

function makeInteractiveService(): InteractiveService {
  return {
    select: (message, options) => fromPromise(() => stderrSelect({ message, options })),
    text: (message, validate) => fromPromise(() => stderrText({ message, validate })),
    isCancel: (value) => isCancel(value),
    cancel: () => Effect.sync(() => stderrCancel()),
    warn: (message) => Effect.sync(() => stderrLog.warn(message)),
  };
}

export function liveGitReporterLayer(): Layer.Layer<Git | Reporter> {
  return Layer.mergeAll(
    Layer.succeed(Git, makeGitService()),
    Layer.succeed(Reporter, makeReporterService()),
  );
}

export function liveCreateLayer(): Layer.Layer<CreateServices> {
  return Layer.mergeAll(liveGitReporterLayer(), Layer.succeed(FileSystem, makeFileSystemService()));
}

export function livePromptLayer(): Layer.Layer<PromptServices> {
  return Layer.mergeAll(
    liveGitReporterLayer(),
    Layer.succeed(Interactive, makeInteractiveService()),
  );
}

export function liveCliLayer(): Layer.Layer<CliServices> {
  return Layer.mergeAll(liveGitReporterLayer(), Layer.succeed(Github, makeGithubService()));
}
