import { describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Bridge exposure test: loads the COMPILED preload (dist/preload/preload.js)
 * in a child process where 'electron' resolves to a stub, then asserts
 * contextBridge receives the narrow `sentry` API. Catches regressions like
 * the ESM preload incident (sandboxed preloads must be CommonJS) without
 * launching Electron.
 */
describe('preload bridge exposure', () => {
  it('exposes window.sentry with the full narrow API from compiled output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-preload-stub-'));
    try {
      const stubDir = join(dir, 'node_modules', 'electron');
      await mkdir(stubDir, { recursive: true });
      await writeFile(
        join(stubDir, 'package.json'),
        JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.cjs' }),
      );
      await writeFile(
        join(stubDir, 'index.cjs'),
        'module.exports = { contextBridge: { exposeInMainWorld: (k, v) => { globalThis.__exposed = { ...globalThis.__exposed, [k]: Object.keys(v) }; } }, ' +
          'ipcRenderer: { invoke: async () => ({ ok: true, result: null }), on: () => undefined, removeListener: () => undefined } };',
      );
      // Co-locate a copy: nested require('electron') resolves from the
      // requiring file's directory, so the copy must sit next to the stub.
      await copyFile(join(root, 'dist', 'preload', 'preload.js'), join(dir, 'preload-copy.cjs'));
      const entry = join(dir, 'entry.cjs');
      await writeFile(
        entry,
        'globalThis.__exposed = {};\n' +
          "require('./preload-copy.cjs');\n" +
          'process.stdout.write(JSON.stringify(globalThis.__exposed));\n',
      );
      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', cwd: dir });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const exposed = JSON.parse(result.stdout) as Record<string, string[]>;
      const namespaces = exposed['sentry'] ?? [];
      for (const ns of [
        'projects',
        'runs',
        'issues',
        'retests',
        'doctors',
        'providers',
        'system',
        'subscribe',
      ]) {
        expect(namespaces).toContain(ns);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
