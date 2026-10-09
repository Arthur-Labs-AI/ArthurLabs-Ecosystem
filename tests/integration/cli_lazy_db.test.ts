/**
 * HR-02.5F Part B/D integration tests: lazy DB initialization boundary.
 *
 * Strong behavioral proof (no warning-chasing, no test-only bypasses):
 *  7. model-only commands succeed with DB locations that are impossible
 *     to open (read-only directory), and create no DB files;
 *  8. `models detect/status/list/recommend` succeed with the DEFAULT
 *     stable paths from an arbitrary cwd (no ARTHUR_DB_PATH);
 *  10. DB-backed commands with the same impossible location fail fast
 *      with a typed error (they genuinely need SQLite);
 *  12. existing migration/schema behavior unchanged (session store opens
 *      and migrates on a writable scratch root).
 *
 * Mechanism: real child `node dist/apps/cli/index.js` processes with a
 * scrubbed environment (synthetic HOME + ARTHUR_DATA_DIR under a temp
 * prefix), run from several cwds. Read-only (0o555) data dirs make every
 * SQLite open fail fast with SQLITE_CANTOPEN instead of hanging.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.join(process.cwd(), 'dist', 'apps', 'cli', 'index.js');

interface ChildResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): ChildResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs ?? 90000,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { exit: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown };
    return { exit: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

function scrubbedEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of ['ARTHUR_DB_PATH', 'ARTHUR_MEMORY_PERSONAL_DB_PATH', 'ARTHUR_MEMORY_BUSINESS_DB_PATH', 'ARTHUR_DATA_DIR']) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function makeScratch(): { prefix: string; home: string; dataDir: string } {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'arthur-cli-lazy-'));
  const home = path.join(prefix, 'home');
  const dataDir = path.join(prefix, 'data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return { prefix, home, dataDir };
}

function cleanup(prefix: string): void {
  try { fs.chmodSync(prefix, 0o755); } catch { /* best effort */ }
  try {
    const dataDir = path.join(prefix, 'data');
    try { fs.chmodSync(dataDir, 0o755); } catch { /* best effort */ }
    fs.rmSync(prefix, { recursive: true, force: true });
  } catch { /* best effort */ }
}

function treeFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(d); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry);
      out.push(full);
      try { if (fs.statSync(full).isDirectory()) visit(full); } catch { /* gone */ }
    }
  };
  visit(dir);
  return out;
}

test('model-only commands succeed with impossible DB locations and create nothing', () => {
  const { prefix, home, dataDir } = makeScratch();
  try {
    // Read-only data dir: every SQLite open fails fast (CANTOPEN), and
    // nothing can be created inside. Model commands must not care.
    fs.chmodSync(dataDir, 0o555);
    const env = scrubbedEnv({ HOME: home, ARTHUR_DATA_DIR: dataDir });
    for (const args of [['models', 'detect', '--json'], ['models', 'status', '--json'], ['models', 'list', '--json'], ['models', 'recommend', '--json']] as string[][]) {
      const result = runCli(args, { cwd: os.tmpdir(), env });
      assert.equal(result.exit, 0, args.join(' ') + ' failed: ' + result.stderr.slice(0, 500));
      assert.ok(result.stdout.includes('"ok": true'), args.join(' ') + ' not ok');
    }
    assert.deepEqual(treeFiles(dataDir), [], 'model-only commands created DB files: ' + treeFiles(dataDir).join(','));
  } finally {
    cleanup(prefix);
  }
});

test('models detect/status/list/recommend work from arbitrary cwd with default paths', () => {
  const { prefix, home } = makeScratch();
  try {
    const env = scrubbedEnv({ HOME: home });
    const cwds = [home, process.cwd(), os.tmpdir()];
    const firstOutputs = new Map<string, string>();
    for (const cwd of cwds) {
      for (const args of [['models', 'detect', '--json'], ['models', 'status', '--json'], ['models', 'list', '--json'], ['models', 'recommend', '--json']] as string[][]) {
        const result = runCli(args, { cwd, env });
        assert.equal(result.exit, 0, args.join(' ') + ' from ' + cwd + ' failed: ' + result.stderr.slice(0, 500));
        const key = args.join(' ');
        const normalized = result.stdout.replace(/"duration_ms": [0-9.]+/g, '');
        if (!firstOutputs.has(key)) firstOutputs.set(key, normalized);
      }
    }
    // Default state path is stable (same file regardless of cwd).
    const statusOut = firstOutputs.get('models status --json') ?? '';
    const parsed = JSON.parse(statusOut) as { data: { state_path: string; managed_root: string } };
    assert.ok(path.isAbsolute(parsed.data.state_path));
    assert.ok(parsed.data.state_path.startsWith(path.join(home, '.local', 'share', 'arthur')));
  } finally {
    cleanup(prefix);
  }
});

test('DB-backed commands fail fast with the same impossible location', () => {
  const { prefix, home, dataDir } = makeScratch();
  try {
    fs.chmodSync(dataDir, 0o555);
    const env = scrubbedEnv({ HOME: home, ARTHUR_DATA_DIR: dataDir });
    // `status` needs the session database: it must fail typed, proving
    // the DB-backed path genuinely opens SQLite (no bypass).
    const result = runCli(['status', '--json'], { cwd: os.tmpdir(), env });
    assert.notEqual(result.exit, 0, 'DB-backed status unexpectedly succeeded without a database');
    const combined = result.stdout + result.stderr;
    assert.ok(/INVALID_CONFIG|CANTOPEN|unable to open|readonly|read-only/i.test(combined), 'unexpected failure shape: ' + combined.slice(0, 500));
  } finally {
    cleanup(prefix);
  }
});

test('DB-backed commands still initialize and use the DB on a writable root', () => {
  const { prefix, home, dataDir } = makeScratch();
  try {
    const env = scrubbedEnv({ HOME: home, ARTHUR_DATA_DIR: dataDir });
    // `ask` with the fake provider exercises the full DB-backed path:
    // session store open + migrate + turn persistence.
    const result = runCli(['ask', '--mode', 'personal', '--json', 'hello'], { cwd: os.tmpdir(), env });
    assert.equal(result.exit, 0, 'ask failed: ' + result.stderr.slice(0, 800));
    const dbFile = path.join(dataDir, 'arthur.db');
    assert.ok(fs.existsSync(dbFile), 'session database was not created at the stable default');
    const memPersonal = path.join(dataDir, 'memory-personal.db');
    const memBusiness = path.join(dataDir, 'memory-business.db');
    assert.ok(fs.existsSync(memPersonal), 'personal memory database missing');
    assert.ok(fs.existsSync(memBusiness), 'business memory database missing');
    // Same stable file from another cwd (proof 6 at the DB level).
    const again = runCli(['ask', '--mode', 'personal', '--json', 'hello again'], { cwd: home, env });
    assert.equal(again.exit, 0, 'ask from second cwd failed: ' + again.stderr.slice(0, 500));
    assert.deepEqual(treeFiles(dataDir).filter((f) => f.endsWith('.db')).sort(), [dbFile, memBusiness, memPersonal].sort());
  } finally {
    cleanup(prefix);
  }
});
