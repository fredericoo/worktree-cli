/**
 * wt list - List all worktrees in the bare repo.
 */

import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { isBareRepo, listWorktrees } from '../git';

export const command: CommandHandler = {
  name: 'list',
  description: 'List all worktrees',

  getHelp(): CommandHelp {
    return {
      name: 'wt list',
      synopsis: 'wt list',
      description: 'List all worktrees in the bare repo.',

      examples: ['wt list'],

      notes: ['Must be run from within a bare repo (created by wt create).'],
    };
  },

  async execute(_args: string[]): Promise<number> {
    if (!(await isBareRepo())) {
      console.error(
        'Error: Not in a bare repo. wt list only works with bare repo worktree setups.',
      );
      return 1;
    }

    try {
      const output = await listWorktrees();
      console.log(output);
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Error: ${message}`);
      return 1;
    }
  },
};
