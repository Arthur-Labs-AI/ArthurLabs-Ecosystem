/**
 * HR-02.5F Part A/C unit tests: stable default DB paths.
 *
 * Proves (deterministic, env save/restore, no SQLite opened):
 *  1. default DB paths are absolute;
 *  2. Linux default uses the stable user-data root;
 *  3. XDG_DATA_HOME honored;
 *  4. ARTHUR_DATA_DIR honored;
 *  5. ARTHUR_DB_PATH (and memory overrides) win verbatim;
 *  6. same effective path regardless of cwd influence;
 *  11. Personal/Business isolation unchanged (distinct files);
 *  12. `:memory:` stays `:memory:` for all three DBs (never rewritten).
 *
 * Windows-shape assertions use the platform/pathImpl seams (proof 13),
 * never host-OS assumptions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  MEMORY_BUSINESS_DB_FILENAME,
  MEMORY_PERSONAL_DB_FILENAME,
  SESSION_DB_FILENAME,
  defaultMemoryBusinessDbPath,
  defaultMemoryPersonalDbPath,
  defaultSessionDbPath,
  loadSettings,
} from '../../src/config/settings';
import { resolveAppDataRoot } from '../../src/runtime/app_data';

const DB_ENV_KEYS = ['ARTHUR_DB_PATH', 'ARTHUR_MEMORY_PERSONAL_DB_PATH', 'ARTHUR_MEMORY_BUSINESS_DB_PATH', 'ARTHUR_DATA_DIR', 'XDG_DATA_HOME', 'HOME', 'LOCALAPPDATA', 'APPDATA'];

function saveEnv(): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const key of DB_ENV_KEYS) saved.set(key, process.env[key]);
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setEnv(values: Record<string, string>): void {
  for (const key of DB_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

test('default DB paths are absolute under the stable Linux user-data root', () => {
  const saved = saveEnv();
  try {
    setEnv({ HOME: '/home/op' });
    const settings = loadSettings({ modelProvider: 'fake' });
    for (const p of [settings.dbPath, settings.memoryPersonalDbPath, settings.memoryBusinessDbPath]) {
      assert.ok(path.isAbsolute(p), p);
      assert.ok(!p.includes('data/arthur') || p.includes('.local/share/arthur'), p);
    }
    assert.equal(settings.dbPath, path.join('/home/op/.local/share/arthur', SESSION_DB_FILENAME));
    assert.equal(settings.memoryPersonalDbPath, path.join('/home/op/.local/share/arthur', MEMORY_PERSONAL_DB_FILENAME));
    assert.equal(settings.memoryBusinessDbPath, path.join('/home/op/.local/share/arthur', MEMORY_BUSINESS_DB_FILENAME));
  } finally { restoreEnv(saved); }
});

test('XDG_DATA_HOME is honored for all three default DB paths', () => {
  const saved = saveEnv();
  try {
    setEnv({ XDG_DATA_HOME: '/data/xdg', HOME: '/home/op' });
    const settings = loadSettings({ modelProvider: 'fake' });
    assert.equal(settings.dbPath, path.join('/data/xdg/arthur', SESSION_DB_FILENAME));
    assert.equal(settings.memoryPersonalDbPath, path.join('/data/xdg/arthur', MEMORY_PERSONAL_DB_FILENAME));
    assert.equal(settings.memoryBusinessDbPath, path.join('/data/xdg/arthur', MEMORY_BUSINESS_DB_FILENAME));
  } finally { restoreEnv(saved); }
});

test('ARTHUR_DATA_DIR is honored for all three default DB paths', () => {
  const saved = saveEnv();
  try {
    setEnv({ ARTHUR_DATA_DIR: '/srv/arthur-data', HOME: '/home/op' });
    const settings = loadSettings({ modelProvider: 'fake' });
    assert.equal(settings.dbPath, path.join('/srv/arthur-data', SESSION_DB_FILENAME));
    assert.equal(settings.memoryPersonalDbPath, path.join('/srv/arthur-data', MEMORY_PERSONAL_DB_FILENAME));
    assert.equal(settings.memoryBusinessDbPath, path.join('/srv/arthur-data', MEMORY_BUSINESS_DB_FILENAME));
  } finally { restoreEnv(saved); }
});

test('explicit ARTHUR_*_PATH overrides win verbatim (existing semantics)', () => {
  const saved = saveEnv();
  try {
    setEnv({
      HOME: '/home/op',
      ARTHUR_DATA_DIR: '/srv/arthur-data',
      ARTHUR_DB_PATH: './data/custom.db',
      ARTHUR_MEMORY_PERSONAL_DB_PATH: '/explicit/p.db',
      ARTHUR_MEMORY_BUSINESS_DB_PATH: 'rel/b.db',
    });
    const settings = loadSettings({ modelProvider: 'fake' });
    // Explicit values pass through loadSettings untouched; the store
    // constructors keep their existing resolve() semantics.
    assert.equal(settings.dbPath, './data/custom.db');
    assert.equal(settings.memoryPersonalDbPath, '/explicit/p.db');
    assert.equal(settings.memoryBusinessDbPath, 'rel/b.db');
  } finally { restoreEnv(saved); }
});

test('default resolvers share one app-data-root (no second resolver)', () => {
  const saved = saveEnv();
  try {
    setEnv({ HOME: '/home/op' });
    const root = resolveAppDataRoot();
    assert.equal(defaultSessionDbPath(), path.join(root, SESSION_DB_FILENAME));
    assert.equal(defaultMemoryPersonalDbPath(), path.join(root, MEMORY_PERSONAL_DB_FILENAME));
    assert.equal(defaultMemoryBusinessDbPath(), path.join(root, MEMORY_BUSINESS_DB_FILENAME));
  } finally { restoreEnv(saved); }
});

test('personal and business defaults are distinct files', () => {
  const saved = saveEnv();
  try {
    setEnv({ HOME: '/home/op' });
    assert.notEqual(defaultMemoryPersonalDbPath(), defaultMemoryBusinessDbPath());
  } finally { restoreEnv(saved); }
});

test(':memory: stays :memory: for all three DBs (never rewritten)', () => {
  const saved = saveEnv();
  try {
    setEnv({ HOME: '/home/op' });
    const settings = loadSettings({
      modelProvider: 'fake',
      dbPath: ':memory:',
      memoryPersonalDbPath: ':memory:',
      memoryBusinessDbPath: ':memory:',
    });
    assert.equal(settings.dbPath, ':memory:');
    assert.equal(settings.memoryPersonalDbPath, ':memory:');
    assert.equal(settings.memoryBusinessDbPath, ':memory:');
  } finally { restoreEnv(saved); }
});

test('windows-shape defaults use LOCALAPPDATA via the platform seam', () => {
  const root = resolveAppDataRoot({
    env: { LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local' },
    platform: 'win32',
    pathImpl: path.win32,
  });
  assert.equal(root, path.win32.join('C:\\Users\\op\\AppData\\Local', 'ARTHUR'));
  assert.ok(!root.includes('Roaming'));
});

test('macos-shape defaults use Library/Application Support via the platform seam', () => {
  const root = resolveAppDataRoot({
    env: { HOME: '/Users/op' },
    platform: 'darwin',
    pathImpl: path.posix,
  });
  assert.equal(root, '/Users/op/Library/Application Support/ARTHUR');
});

test('CLI source keeps buildApp off the static import graph (lazy boundary)', () => {
  // Source-level boundary: apps/cli/index.ts must reach src/app ONLY
  // through a dynamic import inside the DB-backed path (deferred until
  // a DB-backed command actually runs). The compiled CJS output cannot
  // distinguish deferred from top-level require, so this asserts the
  // TypeScript source directly.
  const fs = require('node:fs') as typeof import('node:fs');
  const indexSource = fs.readFileSync('apps/cli/index.ts', 'utf8');
  const valueImportOfApp = indexSource.split("\n").some((ln) => ln.startsWith("import ") && ln.includes("src/app") && !ln.includes("import type"));
  assert.equal(valueImportOfApp, false, 'apps/cli/index statically imports src/app');
  assert.ok(indexSource.includes('await import("../../src/app")'), 'DB-backed path lost its lazy src/app import');
  for (const file of ['apps/cli/model_branch.ts', 'apps/cli/models.ts', 'apps/cli/setup.ts']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!source.includes('src/app'), file + ' references src/app');
    assert.ok(!source.includes('node:sqlite'), file + ' references node:sqlite');
  }
});
