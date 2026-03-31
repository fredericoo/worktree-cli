#!/usr/bin/env bun

import { loadCommand, printHelp, printVersion } from './command-router';
import { printCommandHelp, printSubcommandHelp } from './help.js';
import type { CommandHandler } from './types';

function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

function printUnknownCommand(name: string): void {
  console.error(`Unknown command: ${name}`);
  console.error('Run "wt --help" for usage information.');
}

async function handleCommandHelp(
  commandName: string,
  command: CommandHandler,
  args: string[],
  helpIndex: number,
): Promise<number> {
  if (command.getHelp === undefined) {
    console.log(`Usage: wt ${commandName} ...`);
    return 0;
  }

  const help = command.getHelp();
  const subcommand = helpIndex > 1 ? args[1] : undefined;

  if (subcommand !== undefined && help.subcommands?.[subcommand] !== undefined) {
    await printSubcommandHelp(commandName, subcommand, help.subcommands[subcommand]);
    return 0;
  }

  await printCommandHelp(help);
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (firstArg === undefined || isHelpFlag(firstArg)) {
    await printHelp();
    return 0;
  }

  if (firstArg === '--version' || firstArg === '-v') {
    await printVersion();
    return 0;
  }

  const commandName = firstArg;
  const helpIndex = args.findIndex(isHelpFlag);

  if (helpIndex !== -1) {
    const command = await loadCommand(commandName);
    if (command === null) {
      printUnknownCommand(commandName);
      return 1;
    }
    return handleCommandHelp(commandName, command, args, helpIndex);
  }

  const command = await loadCommand(commandName);
  if (command === null) {
    printUnknownCommand(commandName);
    return 1;
  }

  try {
    return await command.execute(args.slice(1));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error: ${message}`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
