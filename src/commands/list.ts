/**
 * wt list - List all worktrees in the bare repo.
 */

import { Effect, Layer } from 'effect';
import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { Git, liveGitReporterLayer, Reporter } from '../services';

type ListServices = Git | Reporter;

const HELP: CommandHelp = {
  name: 'wt list',
  synopsis: 'wt list',
  description: 'List all worktrees in the bare repo.',

  examples: ['wt list'],

  notes: ['Must be run from within a bare repo (created by wt create).'],
};

function writeStderr(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStderr(message);
  });
}

function writeStdout(message: string): Effect.Effect<void, never, Reporter> {
  return Effect.gen(function* () {
    const reporter = yield* Reporter;
    yield* reporter.writeStdout(message);
  });
}

export function listProgram(): Effect.Effect<number, never, ListServices> {
  return Effect.gen(function* () {
    const git = yield* Git;

    const bareRepo = yield* Effect.either(git.isBareRepo);
    if (bareRepo._tag === 'Left' || !bareRepo.right) {
      yield* writeStderr(
        'Error: Not in a bare repo. wt list only works with bare repo worktree setups.',
      );
      return 1;
    }

    const output = yield* Effect.either(git.listWorktrees());
    if (output._tag === 'Left') {
      yield* writeStderr(`Error: ${output.left.message}`);
      return 1;
    }

    yield* writeStdout(output.right);
    return 0;
  });
}

export function makeListCommand(layer: Layer.Layer<ListServices>): CommandHandler {
  return {
    name: 'list',
    description: 'List all worktrees',
    getHelp: () => HELP,
    execute: () => Effect.runPromise(Effect.provide(listProgram(), layer)),
  };
}

export const command: CommandHandler = makeListCommand(liveGitReporterLayer());
