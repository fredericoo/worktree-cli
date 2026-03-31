/**
 * Shared test infrastructure for wt CLI integration tests.
 * Provides helpers for creating git repos, running the CLI, and managing temp dirs.
 */

import { mkdtemp, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export async function createTempDir(prefix: string): Promise<string> {
  // Resolve symlinks (macOS: /var -> /private/var) to match git's resolved paths
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function initGitRepo(dir: string, branch = 'main'): Promise<void> {
  await Bun.spawn(['git', 'init', '-b', branch, dir], { stdout: 'pipe', stderr: 'pipe' }).exited;
  await Bun.spawn(['git', '-C', dir, 'config', 'user.email', 'test@test.com'], {
    stdout: 'pipe',
    stderr: 'pipe',
  }).exited;
  await Bun.spawn(['git', '-C', dir, 'config', 'user.name', 'Test'], {
    stdout: 'pipe',
    stderr: 'pipe',
  }).exited;
  await Bun.write(join(dir, 'README.md'), '# Test Repo\n');
  await Bun.spawn(['git', '-C', dir, 'add', '.'], { stdout: 'pipe', stderr: 'pipe' }).exited;
  await Bun.spawn(['git', '-C', dir, 'commit', '-m', 'initial commit'], {
    stdout: 'pipe',
    stderr: 'pipe',
  }).exited;
}

export async function createBareRepo(dir: string): Promise<void> {
  await initGitRepo(dir);
  const cliPath = join(import.meta.dir, 'cli.ts');
  await Bun.spawn(['bun', 'run', cliPath, 'create', dir], { stdout: 'pipe', stderr: 'pipe' })
    .exited;
}

export async function runWt(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cliPath = join(import.meta.dir, 'cli.ts');
  const spawnOptions =
    cwd !== undefined
      ? { stdout: 'pipe' as const, stderr: 'pipe' as const, cwd }
      : { stdout: 'pipe' as const, stderr: 'pipe' as const };
  const proc = Bun.spawn(['bun', 'run', cliPath, ...args], spawnOptions);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
