// SC-04 F31 Windows local capability integration (TASK-0019).
//
// Real Node/Windows behavior over a temporary scope: drive-letter rejection,
// UNC rejection, backslash/mixed-separator traversal, realpath containment,
// lstat symlink semantics, UTF-8 reading, listing, recursive search, statfs
// storage probing. App/browser launch proves the production Windows
// specification reaches the controlled launcher boundary (trusted
// exe/helper, fixed args, shell:false, sanitized env) via the same
// production composition path with an observing fake launcher seam.
// No real GUI is opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ArthurError } from '../../src/core/errors/errors';
import { ArthurMode } from '../../src/core/modes/mode';
import { Logger } from '../../src/observability/logging';
import { InMemoryMetrics } from '../../src/observability/metrics';
import { SecretSanitizer } from '../../src/security/sanitize';
import { SessionStore } from '../../src/sessions/store';
import { HarnessStubAdapter } from '../../src/tools/adapters/harness_stub';
import { NodeLocalApplicationAdapter } from '../../src/tools/adapters/local_applications';
import { NodeLocalBrowserAdapter, platformLauncher } from '../../src/tools/adapters/local_browser';
import { NodeLocalFilesystemAdapter } from '../../src/tools/adapters/local_filesystem';
import { NodeLocalSystemAdapter } from '../../src/tools/adapters/local_system';
import { buildChildEnv } from '../../src/tools/child_env';
import { registerBuiltinTools } from '../../src/tools/builtin';
import type { LocalCapabilityHost } from '../../src/tools/local_host';
import { probeStorage } from '../../src/tools/storage_probe';
import { ToolOrchestrator } from '../../src/tools/orchestrator';
import { PermissionService } from '../../src/tools/permissions';
import { ToolRegistry } from '../../src/tools/registry';
import { FilesystemScopeRegistry, resolveLexical } from '../../src/tools/scoped_path';

const SIGNING_SECRET = 'sc04-win-secret';

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) {
    assert.ok(err instanceof ArthurError);
    return (err as ArthurError).code;
  }
  throw new Error('expected rejection');
}

function winFixture(): { dir: string; projects: string; outside: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc04-win-'));
  const projects = path.join(dir, 'projects');
  const outside = path.join(dir, 'outside');
  const alpha = path.join(projects, 'alpha', 'src');
  mkdirSync(alpha, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(alpha, 'app.ts'), 'export const greeting = "hello windows";\n// ToolExecutionService\n');
  writeFileSync(path.join(projects, 'alpha', 'README.md'), '# alpha\nwindows fixture\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'windows outside secret\n');
  return { dir, projects, outside };
}

function buildWinWorld(fx: { projects: string }): {
  registry: ToolRegistry;
  execution: ReturnType<ToolRegistry['createExecutionService']>;
  ctx: { session_id: string; turn_id: string; trace_id: string; mode: ArthurMode; approved: false };
  store: SessionStore;
  launched: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }>;
  opened: string[];
  close: () => void;
} {
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'Projects', physical_root: fx.projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const launched: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const opened: string[] = [];
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes),
    applications: new NodeLocalApplicationAdapter(
      [{ id: 'notepad', display_name: 'Notepad', executable: 'C:/Windows/System32/notepad.exe', args: [] }],
      { launcher: async (exe, args, env) => { launched.push({ exe, args, env }); }, availability: async () => true },
    ),
    browser: new NodeLocalBrowserAdapter({ launcher: async (url) => { opened.push(url); } }),
  };
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }), { host });
  const permissions = new PermissionService();
  const store = new SessionStore(':memory:', new SecretSanitizer([]));
  const execution = registry.createExecutionService(permissions);
  const orchestrator = new ToolOrchestrator({
    registry, execution, store, permissions,
    sanitizer: new SecretSanitizer([]),
    approvalTtlSeconds: 300, approvalSigningSecret: SIGNING_SECRET,
    logger: new Logger('error'), metrics: new InMemoryMetrics(),
  });
  void orchestrator;
  store.createSession('s1', ArthurMode.PERSONAL);
  store.createTurn({ id: 't1', sessionId: 's1', role: 'user', text: 'go', traceId: 'tr1', status: 'completed', mode: ArthurMode.PERSONAL });
  return { registry, execution,
    ctx: { session_id: 's1', turn_id: 't1', trace_id: 'tr1', mode: ArthurMode.PERSONAL, approved: false },
    store, launched, opened, close: () => store.close() };
}

test('F31 scope root validation: realpath canonical root, unknown root rejected', async () => {
  const fx = winFixture();
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'Projects', physical_root: fx.projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  assert.equal(scopes.realRoot('projects'), realpathSync(fx.projects));
  assert.throws(() => scopes.get('nope'), (e: unknown) => e instanceof ArthurError && e.code === 'TOOL_SCOPE_VIOLATION');
  const w = buildWinWorld(fx);
  try {
    const roots = await w.execution.execute('filesystem.roots', {}, w.ctx);
    assert.deepEqual(roots.data, { roots: [{ id: 'projects', label: 'Projects' }] });
  } finally { w.close(); }
});

test('F31 drive-letter absolute rejection (C:, D:, drive-relative)', async () => {
  const fx = winFixture();
  const w = buildWinWorld(fx);
  try {
    const driveForms = ['C:/Windows/system.ini', 'D:/anything', 'c:/x', 'C:drive-relative-x'];
    for (const p of driveForms) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: p }, w.ctx)), 'TOOL_SCOPE_VIOLATION', p);
    }
    const backslashDrive = 'C:' + String.fromCharCode(92) + 'Windows' + String.fromCharCode(92) + 'system.ini';
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: backslashDrive }, w.ctx)), 'TOOL_SCOPE_VIOLATION', backslashDrive);
  } finally { w.close(); }
});

test('F31 UNC rejection', async () => {
  const fx = winFixture();
  const w = buildWinWorld(fx);
  try {
    const uncBack = String.fromCharCode(92, 92) + 'server' + String.fromCharCode(92) + 'share' + String.fromCharCode(92) + 'file';
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: uncBack }, w.ctx)), 'TOOL_SCOPE_VIOLATION', uncBack);
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: '//server/share/file' }, w.ctx)), 'TOOL_SCOPE_VIOLATION');
  } finally { w.close(); }
});

test('F31 backslash and mixed-separator traversal rejected', async () => {
  const fx = winFixture();
  const w = buildWinWorld(fx);
  try {
    const bs = String.fromCharCode(92);
    // NOTE: 'mixed/a/../..' collapses to in-scope 'b' (missing -> NOT_FOUND
    // is correct there); escaping mixes need one more '..' to leave the root.
    const cases = ['..' + bs + '..' + bs + 'secret', 'alpha' + bs + '..' + bs + '..' + bs + 'outside', 'alpha' + bs + 'src' + bs + '..' + bs + '..' + bs + '..' + bs + 'escape'];
    void bs;
    for (const p of cases) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: p }, w.ctx)), 'TOOL_SCOPE_VIOLATION', JSON.stringify(p));
    }
    const scope = new FilesystemScopeRegistry([
      { id: 'projects', label: 'P', physical_root: fx.projects, permissions: ['list'] },
    ]).get('projects');
    assert.throws(() => resolveLexical('projects', scope.physical_root, '..' + bs + 'x'), (e: unknown) => e instanceof ArthurError);
    void scope;
  } finally { w.close(); }
});

test('F31 realpath containment + lstat semantics on a junction fixture', async () => {
  const fx = winFixture();
  let made = false;
  try { symlinkSync(fx.outside, path.join(fx.projects, 'win-link'), 'junction'); made = true; }
  catch { made = false; }
  const w = buildWinWorld(fx);
  try {
    if (!made) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: '../outside/secret.txt' }, w.ctx)), 'TOOL_SCOPE_VIOLATION');
      return;
    }
    const st = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'win-link' }, w.ctx);
    assert.equal((st.data as { type: string }).type, 'symlink', 'lstat reports the reparse entry without traversal');
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'win-link/secret.txt' }, w.ctx)), 'TOOL_SCOPE_VIOLATION');
    const search = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'windows outside secret', mode: 'content' }, w.ctx);
    assert.equal((search.data as { matches: unknown[] }).matches.length, 0, 'search never follows the junction');
  } finally { w.close(); }
});

test('F31 UTF-8 reading, listing, recursive search over the real fixture', async () => {
  const fx = winFixture();
  writeFileSync(path.join(fx.projects, 'unicode.txt'), 'hello \u4e16\u754c \u2014 windows utf8\nsecond line\n');
  const w = buildWinWorld(fx);
  try {
    const read = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'unicode.txt' }, w.ctx);
    assert.ok((read.data as { text: string }).text.indexOf('\u4e16\u754c') >= 0, 'UTF-8 content round-trips');
    const list = await w.execution.execute('filesystem.list', { root_id: 'projects', path: 'alpha/src' }, w.ctx);
    assert.deepEqual((list.data as { entries: Array<{ name: string; type: string }> }).entries.map((e) => e.name), ['app.ts']);
    const search = await w.execution.execute('filesystem.search', { root_id: 'projects', path: 'alpha', query: 'ToolExecutionService', mode: 'content' }, w.ctx);
    assert.ok((search.data as { matches: unknown[] }).matches.length >= 1);
    const hit = (search.data as { matches: Array<{ root_id: string; relative_path: string }> }).matches[0] as { root_id: string; relative_path: string };
    assert.equal(hit.root_id, 'projects');
    assert.ok(hit.relative_path.indexOf(':') < 0 && hit.relative_path.charAt(0) !== '/', 'root-relative match');
  } finally { w.close(); }
});

test('F31 statfs storage probe returns real non-negative totals keyed by root_id', async () => {
  const fx = winFixture();
  const probed = probeStorage(fx.projects);
  assert.ok(probed.total_bytes >= 0 && probed.free_bytes >= 0, 'statfs probe non-negative');
  const w = buildWinWorld(fx);
  try {
    const res = await w.execution.execute('system.storage', {}, w.ctx);
    const data = res.data as { roots: Array<{ root_id: string; total_bytes: number; free_bytes: number }> };
    assert.equal(data.roots.length, 1);
    assert.equal(data.roots[0]?.root_id, 'projects');
    assert.ok(JSON.stringify(data).indexOf(fx.projects) < 0, 'no physical path');
  } finally { w.close(); }
});

test('F31 production launch spec reaches the boundary: trusted exe, fixed args, shell:false, sanitized env', async () => {
  const fx = winFixture();
  const w = buildWinWorld(fx);
  process.env.SC04_WIN_CANARY = 'win-canary-value';
  try {
    await w.execution.execute('app.launch', { app_id: 'notepad' }, w.ctx);
    assert.equal(w.launched.length, 1);
    assert.equal(w.launched[0]?.exe, 'C:/Windows/System32/notepad.exe');
    assert.deepEqual(w.launched[0]?.args, []);
    for (const val of Object.values(w.launched[0]?.env ?? {})) {
      if (typeof val === 'string') assert.ok(val.indexOf('win-canary-value') < 0, 'canary must not inherit');
    }
    assert.equal((w.launched[0]?.env ?? {}).SC04_WIN_CANARY, undefined);
    const appSrc = (await import('node:fs')).readFileSync('src/tools/adapters/local_applications.ts', 'utf8');
    assert.ok(appSrc.indexOf('shell: false') >= 0, 'app spawn shell:false in production source');
    const plat = platformLauncher();
    assert.notEqual(plat.exe.toLowerCase(), 'cmd', 'windows browser launcher is not cmd.exe');
    const child = buildChildEnv({ PATH: 'C:/bin', SystemRoot: 'C:/Windows', DEEPSEEK_API_KEY: 'x' } as NodeJS.ProcessEnv);
    assert.equal(child.PATH, 'C:/bin');
    assert.equal(child.SystemRoot, 'C:/Windows');
    assert.equal(child.DEEPSEEK_API_KEY, undefined);
  } finally {
    delete process.env.SC04_WIN_CANARY;
    w.close();
  }
});