import type { CommandHelp } from './help.js';

export interface CommandHandler {
  name: string;
  description: string;
  execute: (args: string[]) => Promise<number>;
  getHelp?: () => CommandHelp;
}
