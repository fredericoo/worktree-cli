import { describe, expect, test } from 'bun:test';
import {
  stderrSelect,
  stderrText,
  stderrConfirm,
  stderrLog,
  stderrNote,
  stderrIntro,
  stderrOutro,
  stderrCancel,
  isCancel,
} from './interactive';

describe('interactive module exports', () => {
  test('exports all stderr-bound prompt wrappers', () => {
    expect(typeof stderrSelect).toBe('function');
    expect(typeof stderrText).toBe('function');
    expect(typeof stderrConfirm).toBe('function');
    expect(typeof stderrNote).toBe('function');
    expect(typeof stderrIntro).toBe('function');
    expect(typeof stderrOutro).toBe('function');
    expect(typeof stderrCancel).toBe('function');
  });

  test('exports all stderr-bound log methods', () => {
    expect(typeof stderrLog.info).toBe('function');
    expect(typeof stderrLog.success).toBe('function');
    expect(typeof stderrLog.step).toBe('function');
    expect(typeof stderrLog.warn).toBe('function');
    expect(typeof stderrLog.error).toBe('function');
    expect(typeof stderrLog.message).toBe('function');
  });

  test('re-exports isCancel from @clack/prompts', () => {
    expect(typeof isCancel).toBe('function');
    expect(isCancel('not-cancelled')).toBe(false);
  });
});
