/**
 * Git operations for worktree management.
 * Deep module: simple public interface hiding Bun.spawn machinery,
 * timeouts, and error classification.
 */

import { resolve } from 'path';
import { stat } from 'fs/promises';

const GIT_COMMAND_TIMEOUT_MS = 10_000;

export class GitError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export class GitTimeoutError extends Error {
  constructor(command: string) {
    super(`Git command timed out after ${GIT_COMMAND_TIMEOUT_MS}ms: git ${command}`);
    this.name = 'GitTimeoutError';
  }
}

interface RunGitOptions {
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Core git execution with timeout. Single source of truth for Bun.spawn + Promise.race.
 * All other git functions build on this.
 */
async function spawnGit(args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  const { cwd, timeoutMs = GIT_COMMAND_TIMEOUT_MS } = options;

  const spawnOptions =
    cwd !== undefined
      ? { stdout: 'pipe' as const, stderr: 'pipe' as const, cwd }
      : { stdout: 'pipe' as const, stderr: 'pipe' as const };

  const proc = Bun.spawn(['git', ...args], spawnOptions);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new GitTimeoutError(args[0] ?? 'unknown'));
    }, timeoutMs);
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  })();

  try {
    const result = await Promise.race([resultPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function runGit(args: string[], options: RunGitOptions = {}): Promise<string> {
  const result = await spawnGit(args, options);
  if (result.exitCode !== 0) {
    throw new GitError(`git ${args[0]} failed: ${result.stderr}`, result.stderr);
  }
  return result.stdout;
}

async function runGitSafe(args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  return spawnGit(args, options);
}

// --- Public interface ---

export async function isStandardGitRepo(dir?: string): Promise<boolean> {
  const gitPath = resolve(dir ?? '.', '.git');
  try {
    const info = await stat(gitPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function isBareRepo(dir?: string): Promise<boolean> {
  try {
    const result = await runGit(['config', '--get', 'core.bare'], { cwd: dir });
    return result === 'true';
  } catch {
    return false;
  }
}

export async function hasUncommittedChanges(dir?: string): Promise<boolean> {
  const unstaged = await runGitSafe(['diff', '--quiet'], { cwd: dir });
  if (unstaged.exitCode !== 0) return true;

  const staged = await runGitSafe(['diff', '--cached', '--quiet'], { cwd: dir });
  return staged.exitCode !== 0;
}

/**
 * Determine the default branch: main -> master -> current HEAD.
 * Matches the bash script's logic, not fractalspec's (which checks origin/HEAD first).
 */
export async function getDefaultBranch(
  dir?: string,
): Promise<{ branch: string; isDefault: boolean }> {
  const mainCheck = await runGitSafe(['show-ref', '--verify', '--quiet', 'refs/heads/main'], {
    cwd: dir,
  });
  if (mainCheck.exitCode === 0) return { branch: 'main', isDefault: true };

  const masterCheck = await runGitSafe(['show-ref', '--verify', '--quiet', 'refs/heads/master'], {
    cwd: dir,
  });
  if (masterCheck.exitCode === 0) return { branch: 'master', isDefault: true };

  const current = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return { branch: current, isDefault: false };
}

export async function getBareRoot(dir?: string): Promise<string> {
  const gitCommonDir = await runGit(['rev-parse', '--git-common-dir'], { cwd: dir });
  return resolve(dir ?? '.', gitCommonDir, '..');
}

export async function getUntrackedFiles(dir?: string): Promise<string[]> {
  const output = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd: dir });
  if (output === '') return [];
  return output.split('\n');
}

export interface AddWorktreeOptions {
  createBranch?: boolean;
  startPoint?: string;
  cwd?: string;
}

export async function addWorktree(
  worktreePath: string,
  branch: string,
  options: AddWorktreeOptions = {},
): Promise<void> {
  const args =
    options.createBranch === true
      ? ['worktree', 'add', worktreePath, '-b', branch]
      : ['worktree', 'add', worktreePath, branch];

  if (options.startPoint !== undefined) {
    args.push(options.startPoint);
  }

  await runGit(args, { cwd: options.cwd });
}

export async function fetchRef(
  remote: string,
  ref: string,
  options: { cwd?: string } = {},
): Promise<boolean> {
  const result = await runGitSafe(['fetch', remote, ref], { cwd: options.cwd });
  return result.exitCode === 0;
}

export async function refExists(ref: string, options: { cwd?: string } = {}): Promise<boolean> {
  const result = await runGitSafe(['rev-parse', '--verify', '--quiet', ref], {
    cwd: options.cwd,
  });
  return result.exitCode === 0;
}

export async function hasRemoteUrl(
  remote: string,
  options: { cwd?: string } = {},
): Promise<boolean> {
  const result = await runGitSafe(['config', '--get', `remote.${remote}.url`], {
    cwd: options.cwd,
  });
  return result.exitCode === 0 && result.stdout !== '';
}

export interface RemoveWorktreeOptions {
  force?: boolean;
  cwd?: string;
}

export async function removeWorktree(
  worktreePath: string,
  options: RemoveWorktreeOptions = {},
): Promise<void> {
  const args =
    options.force === true
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath];

  await runGit(args, { cwd: options.cwd });
}

export async function deleteBranch(branch: string, dir?: string): Promise<void> {
  await runGit(['branch', '-D', branch], { cwd: dir });
}

export async function setConfig(key: string, value: string, dir?: string): Promise<void> {
  await runGit(['config', key, value], { cwd: dir });
}

export async function listWorktrees(dir?: string): Promise<string> {
  return runGit(['worktree', 'list'], { cwd: dir });
}

export interface WorktreeEntry {
  path: string;
  branch: string;
}

const WORKTREE_LINE_PATTERN = /^(.+?)\s+[0-9a-f]+\s+\[(.+)\]$/;

export function parseWorktreeList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const line of raw.split('\n')) {
    const match = WORKTREE_LINE_PATTERN.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.push({ path: match[1], branch: match[2] });
    }
  }
  return entries;
}

export async function getWorktreeEntries(dir?: string): Promise<WorktreeEntry[]> {
  const output = await listWorktrees(dir);
  return parseWorktreeList(output);
}

export async function findWorktreeByBranch(branch: string, dir?: string): Promise<string | null> {
  const entries = await getWorktreeEntries(dir);
  const match = entries.find((entry) => entry.branch === branch);
  return match?.path ?? null;
}

/** Replace `/` with `-` for worktree directory names. */
export function flattenBranchName(branch: string): string {
  return branch.replace(/\//g, '-');
}
