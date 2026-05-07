import { describe, expect, it } from 'bun:test';
import { runWt } from '../test-scaffold';

describe('wt init', () => {
  it('outputs bash wrapper function', async () => {
    const result = await runWt(['init', 'bash']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('wt()');
    expect(result.stdout).toContain('command wt');
    expect(result.stdout).toContain('cd "$_wt_output"');
  });

  it('outputs zsh wrapper function', async () => {
    const result = await runWt(['init', 'zsh']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('wt()');
    expect(result.stdout).toContain('command wt');
  });

  it('outputs fish wrapper function', async () => {
    const result = await runWt(['init', 'fish']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('function wt');
    expect(result.stdout).toContain('command wt');
  });

  it('fails for unsupported shell', async () => {
    const result = await runWt(['init', 'powershell']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unsupported shell');
  });

  it('fails without shell argument', async () => {
    const result = await runWt(['init']);
    expect(result.exitCode).toBe(1);
  });

  it('wrapper auto-cd applies to all commands', async () => {
    const result = await runWt(['init', 'zsh']);
    expect(result.stdout).toContain('cd "$_wt_output"');
    expect(result.stdout).not.toContain('"co"');
    expect(result.stdout).not.toContain('"checkout"');
  });

  it('wrapper is a single invocation (no double wt call)', async () => {
    const result = await runWt(['init', 'zsh']);
    const commandCalls = result.stdout.match(/\$\(command wt/g);
    expect(commandCalls).not.toBeNull();
    expect(commandCalls?.length).toBe(1);
  });
});
