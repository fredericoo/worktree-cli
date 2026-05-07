/**
 * wt init - Output shell wrapper for auto-cd on checkout.
 * The wrapper captures stdout (worktree path) and cd's into it.
 * Stderr passes through naturally since $() only captures stdout.
 */

import type { CommandHandler } from '../types';
import type { CommandHelp } from '../help.js';
import { printCommandUsage } from '../help.js';

const BASH_WRAPPER = `wt() {
  local _wt_output
  _wt_output=$(command wt "$@")
  local _wt_exit=$?
  if [ $_wt_exit -eq 0 ] && [ -n "$_wt_output" ] && [ -d "$_wt_output" ]; then
    cd "$_wt_output" || return 1
    return 0
  fi
  [ -n "$_wt_output" ] && echo "$_wt_output"
  return $_wt_exit
}`;

const ZSH_WRAPPER = BASH_WRAPPER;

const FISH_WRAPPER = `function wt
  set -l _wt_output (command wt $argv)
  set -l _wt_exit $status
  if test $_wt_exit -eq 0; and test -n "$_wt_output"; and test -d "$_wt_output"
    cd "$_wt_output"
    return 0
  end
  if test -n "$_wt_output"
    echo "$_wt_output"
  end
  return $_wt_exit
end`;

const SHELLS: Record<string, string> = {
  bash: BASH_WRAPPER,
  zsh: ZSH_WRAPPER,
  fish: FISH_WRAPPER,
};

const SUPPORTED_SHELLS = Object.keys(SHELLS);

const HELP: CommandHelp = {
  name: 'wt init',
  synopsis: 'wt init <bash|zsh|fish>',
  description: `Output a shell function that wraps the wt binary.

The wrapper captures stdout from any wt command. If the output is a
directory path, it auto-cd's into it. Otherwise, it prints the output
as-is. This enables auto-cd for checkout and the interactive selector.`,

  examples: [
    '# Add to ~/.zshrc',
    'eval "$(wt init zsh)"',
    '',
    '# Add to ~/.bashrc',
    'eval "$(wt init bash)"',
    '',
    '# Add to ~/.config/fish/config.fish',
    'wt init fish | source',
  ],
};

export const command: CommandHandler = {
  name: 'init',
  description: 'Output shell wrapper for auto-cd on checkout',
  getHelp: () => HELP,

  async execute(args: string[]): Promise<number> {
    const shell = args[0];

    if (shell === undefined || shell === '') {
      printCommandUsage(HELP);
      return 1;
    }

    const wrapper = SHELLS[shell];
    if (wrapper === undefined) {
      console.error(`Error: Unsupported shell '${shell}'.`);
      console.error(`Supported shells: ${SUPPORTED_SHELLS.join(', ')}`);
      return 1;
    }

    console.log(wrapper);
    return 0;
  },
};
