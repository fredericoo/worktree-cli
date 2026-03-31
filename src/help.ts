// Node's child_process.spawn is used for the pager because its stdio: 'inherit'
// support for stdout/stderr is more ergonomic than Bun.spawn for this use case.
import { spawn } from 'child_process';

export interface FlagHelp {
  flag: string;
  description: string;
}

export interface SubcommandHelp {
  synopsis: string;
  description: string;
  examples?: string[];
}

export interface CommandHelp {
  name: string;
  synopsis: string;
  description: string;
  flags?: FlagHelp[];
  examples?: string[];
  notes?: string[];
  subcommands?: Record<string, SubcommandHelp>;
}

// Per no-color.org: respect NO_COLOR when present and not an empty string
export function isNoColorSet(): boolean {
  const value = process.env['NO_COLOR'];
  return value !== undefined && value !== '';
}

export function bold(text: string): string {
  if (isNoColorSet()) return text;
  return `\x1b[1m${text}\x1b[0m`;
}

export function underline(text: string): string {
  if (isNoColorSet()) return text;
  return `\x1b[4m${text}\x1b[0m`;
}

export function dim(text: string): string {
  if (isNoColorSet()) return text;
  return `\x1b[2m${text}\x1b[0m`;
}

export function formatSection(title: string, content: string): string {
  return `${bold(title)}\n${content}\n`;
}

export function formatFlagList(flags: FlagHelp[]): string {
  if (flags.length === 0) return '';

  const maxFlagLength = Math.max(...flags.map((f) => f.flag.length));
  return flags.map((f) => `    ${f.flag.padEnd(maxFlagLength + 2)} ${f.description}`).join('\n');
}

export function formatSubcommands(subcommands: Record<string, SubcommandHelp>): string {
  const entries = Object.entries(subcommands);
  if (entries.length === 0) return '';

  const maxNameLength = Math.max(...entries.map(([name]) => name.length));
  return entries
    .map(([name, help]) => {
      const firstLine = `    ${underline(name.padEnd(maxNameLength + 2))} ${help.description}`;
      if (!help.examples || help.examples.length === 0) return firstLine;

      const exampleLines = help.examples.map((ex) => `      ${dim(ex)}`).join('\n');
      return `${firstLine}\n${exampleLines}`;
    })
    .join('\n\n');
}

export function formatCommandHelp(help: CommandHelp): string {
  const sections: string[] = [];

  sections.push(`${bold('NAME')}\n  ${help.name}\n`);
  sections.push(`${bold('SYNOPSIS')}\n  ${help.synopsis}\n`);
  sections.push(
    formatSection(
      'DESCRIPTION',
      help.description
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    ),
  );

  if (help.subcommands && Object.keys(help.subcommands).length > 0) {
    sections.push(`${bold('SUBCOMMANDS')}\n${formatSubcommands(help.subcommands)}\n`);
  }

  if (help.flags && help.flags.length > 0) {
    sections.push(`${bold('FLAGS')}\n${formatFlagList(help.flags)}\n`);
  }

  if (help.examples && help.examples.length > 0) {
    const exampleText = help.examples.map((ex) => `  ${ex}`).join('\n\n');
    sections.push(`${bold('EXAMPLES')}\n${exampleText}\n`);
  }

  if (help.notes && help.notes.length > 0) {
    const noteText = help.notes.map((note) => `  ${note}`).join('\n\n');
    sections.push(`${bold('NOTES')}\n${noteText}\n`);
  }

  return sections.join('\n');
}

export function formatSubcommandHelp(
  commandName: string,
  subcommandName: string,
  help: SubcommandHelp,
): string {
  const sections: string[] = [];

  sections.push(`${bold('NAME')}\n  ${commandName} ${subcommandName}\n`);
  sections.push(`${bold('SYNOPSIS')}\n  ${help.synopsis}\n`);
  sections.push(formatSection('DESCRIPTION', `  ${help.description}`));

  if (help.examples && help.examples.length > 0) {
    const exampleText = help.examples.map((ex) => `  ${ex}`).join('\n\n');
    sections.push(`${bold('EXAMPLES')}\n${exampleText}\n`);
  }

  return sections.join('\n');
}

export async function displayWithPager(content: string): Promise<void> {
  if (!process.stdout.isTTY) {
    console.log(content);
    return;
  }

  const terminalHeight = process.stdout.rows ?? 24;
  const contentLines = content.split('\n').length;

  if (contentLines <= terminalHeight - 2) {
    console.log(content);
    return;
  }

  try {
    await usePager(content);
  } catch {
    console.log(content);
  }
}

function usePager(content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const pager = spawn('less', ['-R'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    pager.on('error', reject);
    pager.on('close', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Pager exited with code ${code}`));
      }
    });

    pager.stdin.write(content);
    pager.stdin.end();
  });
}

export async function printCommandHelp(help: CommandHelp): Promise<void> {
  const formatted = formatCommandHelp(help);
  await displayWithPager(formatted);
}

export async function printSubcommandHelp(
  commandName: string,
  subcommandName: string,
  help: SubcommandHelp,
): Promise<void> {
  const formatted = formatSubcommandHelp(commandName, subcommandName, help);
  await displayWithPager(formatted);
}

export function printCommandUsage(help: CommandHelp): void {
  console.error(`Usage: ${help.synopsis}`);
}
