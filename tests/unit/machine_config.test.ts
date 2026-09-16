/**
 * FRS-01: canonical machine configuration foundation tests.
 *
 * Deterministic (env save/restore, temp dirs, platform/pathImpl seams).
 * Task matrix:
 *   A. canonical path shapes (Windows LOCALAPPDATA / Linux XDG / HOME fallback)
 *   B. CWD independence (repo / home / temp share one identity)
 *   C. precedence (process env > repo .env > machine config > defaults)
 *   D. programmatic overrides remain highest in loadSettings()
 *   E. atomic update preserves + patches without duplicate keys
 *   F. override removal falls back to lower-precedence source/default
 *   G. malformed/NUL input fails safely (INVALID_CONFIG)
 *   H. secret-safe rendering (human/JSON never contain secret text)
 *   I. CLI config path/show (no DB, valid JSON, no banners, no secrets)
 *   J. existing .env compatibility (repo .env outranks machine config)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ArthurError } from '../../src/core/errors/errors';
import {
  describeConfigurationEnvironment,
  isSecretLikeName,
  loadConfigurationEnvironment,
  parseMachineConfigText,
  readMachineConfig,
  resolveMachineConfigPath,
  resolveMachineConfigPathFor,
  serializeMachineConfig,
  updateMachineConfig,
} from '../../src/config/machine_config';
import { loadDotEnv, loadSettings } from '../../src/config/settings';
import { runConfig } from '../../apps/cli/config';
import type { CliIO } from '../../apps/cli/index';

const NUL = String.fromCharCode(0);

// ---- env helpers ----------------------------------------------------------

const TRACKED_KEYS = [
  'ARTHUR_DATA_DIR', 'XDG_DATA_HOME', 'HOME', 'LOCALAPPDATA', 'APPDATA',
  'ARTHUR_ENV', 'ARTHUR_MODEL_PROVIDER', 'ARTHUR_MODEL_NAME', 'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY', 'ARTHUR_STT_LANGUAGE', 'ARTHUR_STT_POLICY', 'ARTHUR_DB_PATH',
  'ARTHUR_MEMORY_PERSONAL_DB_PATH', 'ARTHUR_MEMORY_BUSINESS_DB_PATH',
  'ARTHUR_TOOL_LOOP_MAX_ROUNDS', 'ARTHUR_LOG_LEVEL',
];

function saveEnv(): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const key of TRACKED_KEYS) saved.set(key, process.env[key]);
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function scrubEnv(values: Record<string, string> = {}): void {
  for (const key of TRACKED_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

function makeTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-frs01-'));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

function captureIo(): { io: CliIO; out: () => string; err: () => string } {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    io: { out: (text) => outBuf.push(text), err: (text) => errBuf.push(text) },
    out: () => outBuf.join(''),
    err: () => errBuf.join(''),
  };
}

// ---- A. canonical path -----------------------------------------------------

test('A: windows-shape machine config path is LOCALAPPDATA\\ARTHUR\\config.env', () => {
  const p = resolveMachineConfigPathFor({
    env: { LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local' },
    platform: 'win32',
    pathImpl: path.win32,
  });
  assert.equal(p, path.win32.join('C:\\Users\\op\\AppData\\Local', 'ARTHUR', 'config.env'));
});

test('A: linux XDG machine config path honors $XDG_DATA_HOME', () => {
  const p = resolveMachineConfigPathFor({
    env: { XDG_DATA_HOME: '/data/xdg', HOME: '/home/op' },
    platform: 'linux',
    pathImpl: path.posix,
  });
  assert.equal(p, '/data/xdg/arthur/config.env');
});

test('A: linux HOME fallback is ~/.local/share/arthur/config.env', () => {
  const p = resolveMachineConfigPathFor({
    env: { HOME: '/home/op' },
    platform: 'linux',
    pathImpl: path.posix,
  });
  assert.equal(p, '/home/op/.local/share/arthur/config.env');
});

test('A: ARTHUR_DATA_DIR overrides the machine config root', () => {
  const p = resolveMachineConfigPathFor({
    env: { ARTHUR_DATA_DIR: '/srv/arthur-data', HOME: '/home/op' },
    platform: 'linux',
    pathImpl: path.posix,
  });
  assert.equal(p, '/srv/arthur-data/config.env');
});

// ---- B. CWD independence ----------------------------------------------------

test('B: same machine config identity from repo, home, and temp cwds', () => {
  const saved = saveEnv();
  try {
    const dir = makeTemp();
    try {
      scrubEnv({ HOME: path.join(dir, 'home'), ARTHUR_DATA_DIR: path.join(dir, 'data') });
      const repoCwd = process.cwd();
      const homeCwd = path.join(dir, 'home');
      const tempCwd = path.join(dir, 'elsewhere');
      fs.mkdirSync(homeCwd, { recursive: true });
      fs.mkdirSync(tempCwd, { recursive: true });
      const results = new Set<string>();
      const prev = process.cwd();
      for (const cwd of [repoCwd, homeCwd, tempCwd]) {
        process.chdir(cwd);
        results.add(resolveMachineConfigPath());
      }
      process.chdir(prev);
      assert.equal(results.size, 1);
      assert.equal([...results][0], path.join(dir, 'data', 'config.env'));
    } finally {
      cleanup(dir);
    }
  } finally {
    restoreEnv(saved);
  }
});

// ---- C. precedence ----------------------------------------------------------

test('C: process env > repo .env > machine config (each layer independently)', () => {
  const saved = saveEnv();
  const dir = makeTemp();
  const prevCwd = process.cwd();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const machinePath = path.join(dir, 'data', 'config.env');
    const repoDir = path.join(dir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const repoEnv = path.join(repoDir, '.env');

    // Machine only -> machine value applies.
    fs.mkdirSync(path.dirname(machinePath), { recursive: true });
    fs.writeFileSync(machinePath, 'ARTHUR_STT_LANGUAGE=bg\n', 'utf8');
    const env1: NodeJS.ProcessEnv = {};
    loadConfigurationEnvironment({ machineConfigPath: machinePath, repoEnvPath: path.join(repoDir, 'missing.env'), env: env1 });
    assert.equal(env1['ARTHUR_STT_LANGUAGE'], 'bg');

    // Repo .env outranks machine config.
    fs.writeFileSync(repoEnv, 'ARTHUR_STT_LANGUAGE=en\n', 'utf8');
    const env2: NodeJS.ProcessEnv = {};
    loadConfigurationEnvironment({ machineConfigPath: machinePath, repoEnvPath: repoEnv, env: env2 });
    assert.equal(env2['ARTHUR_STT_LANGUAGE'], 'en');

    // Ambient process env outranks both files and is never overwritten.
    const env3: NodeJS.ProcessEnv = { ARTHUR_STT_LANGUAGE: 'auto' };
    const res = loadConfigurationEnvironment({ machineConfigPath: machinePath, repoEnvPath: repoEnv, env: env3 });
    assert.equal(env3['ARTHUR_STT_LANGUAGE'], 'auto');
    assert.deepEqual(res.machineKeys, []);
    assert.deepEqual(res.repoKeys, []);
  } finally {
    process.chdir(prevCwd);
    cleanup(dir);
    restoreEnv(saved);
  }
});

test('C: task example end-to-end (bg/en/auto/default layers)', () => {
  const saved = saveEnv();
  const dir = makeTemp();
  try {
    const machinePath = path.join(dir, 'config.env');
    fs.writeFileSync(machinePath, 'ARTHUR_STT_LANGUAGE=bg\n', 'utf8');
    const repoEnv = path.join(dir, '.env');
    fs.writeFileSync(repoEnv, 'ARTHUR_STT_LANGUAGE=en\n', 'utf8');

    // With shell: auto.
    const withShell: NodeJS.ProcessEnv = { ARTHUR_STT_LANGUAGE: 'auto' };
    loadConfigurationEnvironment({ machineConfigPath: machinePath, repoEnvPath: repoEnv, env: withShell });
    assert.equal(withShell['ARTHUR_STT_LANGUAGE'], 'auto');

    // Without shell: repo en.
    const withoutShell: NodeJS.ProcessEnv = {};
    loadConfigurationEnvironment({ machineConfigPath: machinePath, repoEnvPath: repoEnv, env: withoutShell });
    assert.equal(withoutShell['ARTHUR_STT_LANGUAGE'], 'en');

    // Without shell or repo .env: machine bg.
    const machineOnly: NodeJS.ProcessEnv = {};
    loadConfigurationEnvironment({ machineConfigPath: machinePath, repoEnvPath: path.join(dir, 'absent.env'), env: machineOnly });
    assert.equal(machineOnly['ARTHUR_STT_LANGUAGE'], 'bg');

    // Without any: code default path — loadSettings() falls back to 'auto'
    // (voice default) when the env key is absent entirely. ARTHUR_DATA_DIR
    // keeps app-data-root resolution platform-independent (win32 needs an
    // explicit root; HOME alone does not resolve there).
    scrubEnv({ ARTHUR_DATA_DIR: path.join(dir, 'data-default') });
    const settings = loadSettings({ modelProvider: 'fake' });
    assert.equal(settings.voice.sttLanguage, 'auto');
  } finally {
    cleanup(dir);
    restoreEnv(saved);
  }
});

// ---- D. programmatic overrides highest ---------------------------------------

test('D: programmatic loadSettings() overrides beat env and files', () => {
  const saved = saveEnv();
  const dir = makeTemp();
  try {
    const machinePath = path.join(dir, 'config.env');
    fs.writeFileSync(machinePath, 'ARTHUR_STT_LANGUAGE=bg\nARTHUR_LOG_LEVEL=debug\n', 'utf8');
    scrubEnv({ ARTHUR_DATA_DIR: path.join(dir, 'data-d'), ARTHUR_STT_LANGUAGE: 'en' });
    loadConfigurationEnvironment({ machineConfigPath: machinePath, repoEnvPath: path.join(dir, 'absent.env') });
    // Env layer: ambient 'en' survived the machine 'bg'; machine-only
    // ARTHUR_LOG_LEVEL applied from the file.
    assert.equal(process.env['ARTHUR_STT_LANGUAGE'], 'en');
    assert.equal(process.env['ARTHUR_LOG_LEVEL'], 'debug');
    // Programmatic override wins over everything.
    const settings = loadSettings({ modelProvider: 'fake', voice: { sttLanguage: 'fr' } } as never);
    assert.equal(settings.voice.sttLanguage, 'fr');
  } finally {
    cleanup(dir);
    restoreEnv(saved);
  }
});

// ---- E. atomic update --------------------------------------------------------

test('E: update preserves untouched entries, patches, no duplicate keys', () => {
  const dir = makeTemp();
  try {
    const configPath = path.join(dir, 'sub', 'config.env');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'A=1\nB=2\n', 'utf8');
    const next = updateMachineConfig({ set: { B: '3', C: '4' } }, configPath);
    assert.deepEqual(next, { A: '1', B: '3', C: '4' });
    const text = fs.readFileSync(configPath, 'utf8');
    assert.equal(text, 'A=1\nB=3\nC=4\n');
    // Deterministic: re-serializing the same record is byte-identical.
    assert.equal(serializeMachineConfig(next), text);
    // Round-trip through the standard grammar.
    assert.deepEqual(parseMachineConfigText(text), next);
    // No temp files leaked beside the target.
    assert.deepEqual(fs.readdirSync(path.dirname(configPath)).sort(), ['config.env']);
  } finally {
    cleanup(dir);
  }
});

test('E: update creates parent directories and funny values round-trip', () => {
  const dir = makeTemp();
  try {
    const configPath = path.join(dir, 'deep', 'nested', 'config.env');
    const tricky = 'C:\\ffmpeg\\bin\\ffplay.exe -f dshow -i audio="Mic" -ar 16000';
    const next = updateMachineConfig({ set: { ARTHUR_AUDIO_PLAYBACK_COMMAND: tricky, EMPTY: '', HASHED: 'a#b c' } }, configPath);
    assert.equal(next['ARTHUR_AUDIO_PLAYBACK_COMMAND'], tricky);
    const reread = readMachineConfig(configPath);
    assert.deepEqual(reread, next);
  } finally {
    cleanup(dir);
  }
});

// ---- F. removal --------------------------------------------------------------

test('F: removed override disappears; effective value falls back', () => {
  const dir = makeTemp();
  try {
    const configPath = path.join(dir, 'config.env');
    fs.writeFileSync(configPath, 'A=1\nB=2\n', 'utf8');
    const next = updateMachineConfig({ remove: ['B'] }, configPath);
    assert.deepEqual(next, { A: '1' });
    const text = fs.readFileSync(configPath, 'utf8');
    assert.ok(!text.includes('B='));
    // Effective value falls back to the lower-precedence layer: with B
    // absent from the file, an injected env default applies.
    const env: NodeJS.ProcessEnv = { B: 'fallback' };
    const fileEntries = readMachineConfig(configPath);
    for (const [key, value] of Object.entries(fileEntries)) {
      if (env[key] === undefined) env[key] = value;
    }
    assert.equal(env['B'], 'fallback');
    assert.equal(env['A'], '1');
  } finally {
    cleanup(dir);
  }
});

test('F: set+remove of the same key fails without touching the file', () => {
  const dir = makeTemp();
  try {
    const configPath = path.join(dir, 'config.env');
    fs.writeFileSync(configPath, 'A=1\n', 'utf8');
    assert.throws(
      () => updateMachineConfig({ set: { A: '2' }, remove: ['A'] }, configPath),
      (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'A=1\n');
  } finally {
    cleanup(dir);
  }
});

// ---- G. malformed/NUL --------------------------------------------------------

test('G: NUL in key, value, and file text fails typed', () => {
  assert.throws(
    () => updateMachineConfig({ set: { ['A' + NUL + 'B']: '1' } }, path.join(makeTemp(), 'c.env')),
    (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
  );
  const dir = makeTemp();
  try {
    assert.throws(
      () => updateMachineConfig({ set: { A: 'x' + NUL + 'y' } }, path.join(dir, 'c.env')),
      (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
    );
    assert.throws(
      () => parseMachineConfigText('A=1' + NUL + '\n'),
      (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
    );
    // Newline smuggling (entry injection) is rejected, not serialized.
    assert.throws(
      () => serializeMachineConfig({ A: 'one\ntwo=1' }),
      (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
    );
    // Bad keys are rejected.
    for (const bad of ['', 'HAS SPACE', 'DASH-KEY', '9LEAD']) {
      assert.throws(
        () => serializeMachineConfig({ [bad]: '1' }),
        (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
        'key ' + JSON.stringify(bad),
      );
    }
  } finally {
    cleanup(dir);
  }
});

test('G: malformed machine config fails typed on read; missing file is empty', () => {
  const dir = makeTemp();
  try {
    assert.deepEqual(readMachineConfig(path.join(dir, 'absent.env')), {});
    const badPath = path.join(dir, 'bad.env');
    fs.writeFileSync(badPath, 'A=' + NUL + 'x\n', 'utf8');
    assert.throws(
      () => readMachineConfig(badPath),
      (err: unknown) => err instanceof ArthurError && err.code === 'INVALID_CONFIG',
    );
  } finally {
    cleanup(dir);
  }
});

// ---- H. secret-safe rendering --------------------------------------------------

test('H: secret names are secret-like; show never contains secret text', () => {
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'MY_TOKEN', 'APP_SECRET', 'DB_PASSWORD', 'SVC_CREDENTIAL']) {
    assert.equal(isSecretLikeName(name), true, name);
  }
  assert.equal(isSecretLikeName('ARTHUR_STT_LANGUAGE'), false);

  const env: NodeJS.ProcessEnv = {
    DEEPSEEK_API_KEY: 'super-secret',
    OPENAI_API_KEY: 'another-secret',
    ARTHUR_STT_LANGUAGE: 'bg',
  };
  const rows = describeConfigurationEnvironment(env);
  const byName = new Map(rows.map((row) => [row.name, row]));
  assert.equal(byName.get('DEEPSEEK_API_KEY')?.display, 'configured');
  assert.equal(byName.get('OPENAI_API_KEY')?.display, 'configured');
  assert.equal(byName.get('ARTHUR_STT_LANGUAGE')?.display, 'bg');

  const human = rows.map((row) => row.name + '  ' + row.display).join('\n');
  const payload = JSON.stringify({ ok: true, command: 'config show', data: { entries: rows } });
  for (const text of [human, payload]) {
    assert.ok(!text.includes('super-secret'), 'human/JSON leaked DEEPSEEK secret');
    assert.ok(!text.includes('another-secret'), 'human/JSON leaked OPENAI secret');
  }
  assert.ok(payload.includes('configured'));
  assert.ok(payload.includes('bg'));
});

// ---- I. CLI config path/show ----------------------------------------------------

test('I: runConfig path prints the canonical path (human + JSON)', () => {
  const saved = saveEnv();
  try {
    const dir = makeTemp();
    try {
      scrubEnv({ HOME: path.join(dir, 'home'), ARTHUR_DATA_DIR: path.join(dir, 'data') });
      const expected = resolveMachineConfigPath();
      const human = captureIo();
      assert.equal(runConfig('config', new Map(), ['config', 'path'], human.io), 0);
      assert.equal(human.out(), expected + '\n');
      const json = captureIo();
      assert.equal(runConfig('config', new Map([['json', 'true']]), ['config', 'path'], json.io), 0);
      const parsed = JSON.parse(json.out()) as { ok: boolean; command: string; data: { path: string } };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.path, expected);
    } finally {
      cleanup(dir);
    }
  } finally {
    restoreEnv(saved);
  }
});

test('I: runConfig show is secret-safe, creates no DB, valid JSON only on stdout', () => {
  const saved = saveEnv();
  try {
    const dir = makeTemp();
    try {
      const dataDir = path.join(dir, 'data');
      scrubEnv({
        HOME: path.join(dir, 'home'),
        ARTHUR_DATA_DIR: dataDir,
        DEEPSEEK_API_KEY: 'super-secret-child',
        OPENAI_API_KEY: 'another-secret-child',
      });
      fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
      updateMachineConfig(
        { set: { ARTHUR_STT_LANGUAGE: 'bg', DEEPSEEK_API_KEY: 'file-secret-value' } },
        path.join(dataDir, 'config.env'),
      );
      // Ambient env wins over the file for DEEPSEEK_API_KEY here.
      const cap = captureIo();
      assert.equal(runConfig('config', new Map(), ['config', 'show'], cap.io), 0);
      assert.ok(!cap.out().includes('super-secret-child'));
      assert.ok(!cap.out().includes('file-secret-value'));
      assert.ok(cap.out().includes('DEEPSEEK_API_KEY'));
      assert.ok(cap.out().includes('configured'));

      const jcap = captureIo();
      assert.equal(runConfig('config', new Map([['json', 'true']]), ['config', 'show'], jcap.io), 0);
      const parsed = JSON.parse(jcap.out()) as { ok: boolean; data: { entries: { name: string; display: string }[] } };
      assert.equal(parsed.ok, true);
      assert.ok(!jcap.out().includes('super-secret-child'));
      assert.ok(!jcap.out().includes('file-secret-value'));
      assert.ok(!jcap.out().includes('another-secret-child'));
      // No DB files created by show.
      assert.ok(!fs.existsSync(path.join(dataDir, 'arthur.db')));
      assert.ok(!fs.existsSync(path.join(dataDir, 'memory-personal.db')));
      assert.ok(!fs.existsSync(path.join(dataDir, 'memory-business.db')));
      assert.equal(jcap.err(), '');
    } finally {
      cleanup(dir);
    }
  } finally {
    restoreEnv(saved);
  }
});

// ---- J. existing .env compatibility ----------------------------------------------

test('J: repo .env still works and outranks machine config (loadDotEnv path)', () => {
  const saved = saveEnv();
  const dir = makeTemp();
  const prevCwd = process.cwd();
  try {
    const machinePath = path.join(dir, 'data', 'config.env');
    fs.mkdirSync(path.dirname(machinePath), { recursive: true });
    fs.writeFileSync(machinePath, 'ARTHUR_STT_LANGUAGE=bg\nARTHUR_LOG_LEVEL=debug\n', 'utf8');
    const repoDir = path.join(dir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.env'), 'ARTHUR_STT_LANGUAGE=en\n', 'utf8');
    scrubEnv({ HOME: path.join(dir, 'home'), ARTHUR_DATA_DIR: path.join(dir, 'data') });
    process.chdir(repoDir);
    // Unified bootstrap via the historic loadDotEnv() entry point.
    loadDotEnv();
    assert.equal(process.env['ARTHUR_STT_LANGUAGE'], 'en');
    assert.equal(process.env['ARTHUR_LOG_LEVEL'], 'debug');
    const settings = loadSettings({ modelProvider: 'fake' });
    assert.equal(settings.voice.sttLanguage, 'en');
    assert.equal(settings.logLevel, 'debug');
  } finally {
    process.chdir(prevCwd);
    cleanup(dir);
    restoreEnv(saved);
  }
});

// ---- child-process CLI acceptance (I, no-DB + JSON purity) ------------------------

const CLI = path.join(process.cwd(), 'dist', 'apps', 'cli', 'index.js');

function runCli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): { exit: number; stdout: string; stderr: string; spawnBlocked?: boolean } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: 90000,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { exit: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    // Confined sandboxes may forbid piped child capture (spawn EPERM);
    // that is an environment limitation, not a product failure. Callers
    // skip strictly when the spawn itself was blocked.
    const message = err instanceof Error ? err.message : String(err);
    if (/spawnSync? .*EPERM/i.test(message)) return { exit: 1, stdout: '', stderr: message, spawnBlocked: true };
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return { exit: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

test('I(child): config path identical from two cwds; show JSON pure + secret-safe + DB-free', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-frs01-cli-'));
  try {
    const home = path.join(prefix, 'home');
    const dataDir = path.join(prefix, 'data');
    fs.mkdirSync(home, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of TRACKED_KEYS) delete env[key];
    env['HOME'] = home;
    env['ARTHUR_DATA_DIR'] = dataDir;
    env['DEEPSEEK_API_KEY'] = 'child-super-secret';
    env['OPENAI_API_KEY'] = 'child-another-secret';

    const fromRepo = runCli(['config', 'path'], { cwd: process.cwd(), env });
    if (fromRepo.spawnBlocked) {
      cleanup(prefix);
      console.log('skip: child-process spawn blocked in this sandbox (EPERM); in-process I tests cover the contract');
      return;
    }
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-frs01-cwd-'));
    try {
      const fromElsewhere = runCli(['config', 'path'], { cwd: otherCwd, env });
      assert.equal(fromRepo.exit, 0, fromRepo.stderr.slice(0, 500));
      assert.equal(fromElsewhere.exit, 0, fromElsewhere.stderr.slice(0, 500));
      assert.equal(fromRepo.stdout.trim(), fromElsewhere.stdout.trim());
      assert.equal(fromRepo.stdout.trim(), path.join(dataDir, 'config.env'));
    } finally {
      cleanup(otherCwd);
    }

    const show = runCli(['config', 'show', '--json'], { cwd: os.tmpdir(), env });
    assert.equal(show.exit, 0, show.stderr.slice(0, 500));
    // Exactly valid JSON on stdout: no banners, no contamination.
    const parsed = JSON.parse(show.stdout) as { ok: boolean; command: string; data: { path: string; entries: unknown[] } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'config show');
    assert.equal(parsed.data.path, path.join(dataDir, 'config.env'));
    assert.ok(!show.stdout.includes('child-super-secret'));
    assert.ok(!show.stderr.includes('child-super-secret'));
    assert.ok(!show.stdout.includes('child-another-secret'));
    assert.ok(show.stdout.includes('configured'));
    // No DB creation by config commands.
    assert.ok(!fs.existsSync(path.join(dataDir, 'arthur.db')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'memory-personal.db')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'memory-business.db')));
  } finally {
    cleanup(prefix);
  }
});
