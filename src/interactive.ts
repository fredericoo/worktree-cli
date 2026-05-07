import {
  select,
  text,
  confirm,
  log,
  note,
  intro,
  outro,
  cancel,
  type SelectOptions,
  type TextOptions,
  type ConfirmOptions,
  type NoteOptions,
  type LogMessageOptions,
  type CommonOptions,
} from '@clack/prompts';

export { isCancel } from '@clack/prompts';

type StderrSelectOptions<Value> = Omit<SelectOptions<Value>, 'output'>;
type StderrTextOptions = Omit<TextOptions, 'output'>;
type StderrConfirmOptions = Omit<ConfirmOptions, 'output'>;
type StderrLogOptions = Omit<LogMessageOptions, 'output'>;
type StderrNoteOptions = Omit<NoteOptions, 'output'>;

export function stderrSelect<Value>(opts: StderrSelectOptions<Value>) {
  return select({ ...opts, output: process.stderr });
}

export function stderrText(opts: StderrTextOptions) {
  return text({ ...opts, output: process.stderr });
}

export function stderrConfirm(opts: StderrConfirmOptions) {
  return confirm({ ...opts, output: process.stderr });
}

export const stderrLog = {
  info: (message: string, opts?: StderrLogOptions) =>
    log.info(message, { ...opts, output: process.stderr }),
  success: (message: string, opts?: StderrLogOptions) =>
    log.success(message, { ...opts, output: process.stderr }),
  step: (message: string, opts?: StderrLogOptions) =>
    log.step(message, { ...opts, output: process.stderr }),
  warn: (message: string, opts?: StderrLogOptions) =>
    log.warn(message, { ...opts, output: process.stderr }),
  error: (message: string, opts?: StderrLogOptions) =>
    log.error(message, { ...opts, output: process.stderr }),
  message: (message?: string | string[], opts?: StderrLogOptions) =>
    log.message(message, { ...opts, output: process.stderr }),
};

export function stderrNote(message?: string, title?: string, opts?: StderrNoteOptions) {
  return note(message, title, { ...opts, output: process.stderr });
}

export function stderrIntro(title?: string, opts?: Omit<CommonOptions, 'output'>) {
  return intro(title, { ...opts, output: process.stderr });
}

export function stderrOutro(message?: string, opts?: Omit<CommonOptions, 'output'>) {
  return outro(message, { ...opts, output: process.stderr });
}

export function stderrCancel(message?: string, opts?: Omit<CommonOptions, 'output'>) {
  return cancel(message, { ...opts, output: process.stderr });
}
