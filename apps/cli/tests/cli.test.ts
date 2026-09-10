import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { doctorLines, runCli, versionLine } from '../src/index.js';

describe('qa cli', () => {
  it('--version prints qa version', () => {
    expect(versionLine()).toMatch(/^qa \d+\.\d+\.\d+$/);
  });
  it('doctor reports runtime foundation OK and defers real AI harnesses', () => {
    const lines = doctorLines();
    expect(lines[0]).toBe('Sentry');
    expect(lines.join('\n')).toContain('Domain       OK');
    expect(lines.join('\n')).not.toContain('ERROR');
    expect(lines.join('\n')).toContain('Real AI harnesses are not implemented yet');
    expect(lines.join('\n')).toContain('SQLite       OK');
  });
  it('prints help and rejects unknown commands', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runCli(['node', 'qa', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: qa'));
    expect(runCli(['node', 'qa', 'unknown'])).toBe(1);
    expect(error).toHaveBeenCalledWith('Unknown command: unknown');
    log.mockRestore();
    error.mockRestore();
  });
  it('supports actual built CLI invocation', () => {
    const entry = resolve(__dirname, '..', 'dist', 'index.js');
    const result = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(versionLine());
  });
  it('does not execute or set exitCode when the built module is imported', () => {
    const entryUrl = pathToFileURL(resolve(__dirname, '..', 'dist', 'index.js')).href;
    const script = `await import(${JSON.stringify(entryUrl)}); console.log(JSON.stringify({ exitCode: process.exitCode ?? null }));`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script, 'importer-placeholder.mjs'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('{"exitCode":null}');
  });
});
