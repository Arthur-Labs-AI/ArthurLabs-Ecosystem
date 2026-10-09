// SC-04 gap-fill suite part C (TASK-0019): F17/F18-F22/F23-F28/F29,
// config matrix, policy binding, raw-error leakage, F01-F04 path proof.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ArthurError } from '../../src/core/errors/errors';
import { ArthurMode } from '../../src/core/modes/mode';
import { Logger } from '../../src/observability/logging';
import { InMemoryMetrics } from '../../src/observability/metrics';
import { SecretSanitizer } from '../../src/security/sanitize';
import { SessionStore } from '../../src/sessions/store';
import { ExecutionStore } from '../../src/sessions/execution_store';
import { HarnessStubAdapter } from '../../src/tools/adapters/harness_stub';
import { NodeLocalApplicationAdapter } from '../../src/tools/adapters/local_applications';
import { NodeLocalBrowserAdapter, platformLauncher } from '../../src/tools/adapters/local_browser';
import { NodeLocalFilesystemAdapter, sortFilesystemEntries } from '../../src/tools/adapters/local_filesystem';
import { NodeLocalSystemAdapter } from '../../src/tools/adapters/local_system';
import { validateBrowserUrl } from '../../src/tools/browser_policy';
import { buildChildEnv } from '../../src/tools/child_env';
import { buildDefaultLocalHost, registerBuiltinTools } from '../../src/tools/builtin';
import { FakeExecutionClock } from '../../src/tools/execution_clock';
import type { ToolExecutionPolicy } from '../../src/tools/execution_policy';
import { ToolExecutionCoordinator } from '../../src/tools/execution_coordinator';
import type { LocalCapabilityHost } from '../../src/tools/local_host';
import { validateApplicationEntry, validateLocalCapabilityConfig } from '../../src/tools/local_config';
import { ToolOrchestrator } from '../../src/tools/orchestrator';
import { PermissionService } from '../../src/tools/permissions';
import { ToolRegistry } from '../../src/tools/registry';
import { FilesystemScopeRegistry } from '../../src/tools/scoped_path';

const SIGNING_SECRET = 'sc04-gapfill-secret';

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) {
    assert.ok(err instanceof ArthurError);
    return (err as ArthurError).code;
  }
  throw new Error('expected rejection');
}

function sandbox(): { projects: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc04-gapc-'));
  const projects = path.join(dir, 'projects');
  mkdirSync(projects, { recursive: true });
  return { projects };
}

interface World {
  registry: ToolRegistry;
  execution: ReturnType<ToolRegistry['createExecutionService']>;
  orchestrator: ToolOrchestrator;
  store: SessionStore;
  ctx: { session_id: string; turn_id: string; trace_id: string; mode: ArthurMode; approved: false };
  apps: NodeLocalApplicationAdapter;
  browser: NodeLocalBrowserAdapter;
  launched: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }>;
  opened: string[];
  close: () => void;
}

function buildWorld(projects: string): World {
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'Projects', physical_root: projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const launched: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const opened: string[] = [];
  const apps = new NodeLocalApplicationAdapter(
    [{ id: 'firefox', display_name: 'Firefox', executable: path.join(projects, 'firefox-bin'), args: ['--safe'] }],
    { launcher: async (exe, args, env) => { launched.push({ exe, args, env }); }, availability: async () => true },
  );
  const browser = new NodeLocalBrowserAdapter({ launcher: async (url) => { opened.push(url); } });
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes),
    applications: apps,
    browser,
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
  store.createSession('s1', ArthurMode.PERSONAL);
  store.createTurn({ id: 't1', sessionId: 's1', role: 'user', text: 'go', traceId: 'tr1', status: 'completed', mode: ArthurMode.PERSONAL });
  return { registry, execution, orchestrator, store,
    ctx: { session_id: 's1', turn_id: 't1', trace_id: 'tr1', mode: ArthurMode.PERSONAL, approved: false },
    apps, browser, launched, opened, close: () => store.close() };
}

test('F17 outputs, errors, storage expose zero physical-root leakage', async () => {
  const { projects } = sandbox();
  writeFileSync(path.join(projects, 'a.txt'), 'hello\n');
  mkdirSync(path.join(projects, 'd'), { recursive: true });
  const w = buildWorld(projects);
  try {
    const outs: string[] = [];
    outs.push(JSON.stringify((await w.execution.execute('filesystem.roots', {}, w.ctx)).data));
    outs.push(JSON.stringify((await w.execution.execute('filesystem.list', { root_id: 'projects', path: 'd' }, w.ctx)).data));
    outs.push(JSON.stringify((await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'a.txt' }, w.ctx)).data));
    outs.push(JSON.stringify((await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'a.txt' }, w.ctx)).data));
    outs.push(JSON.stringify((await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'hello', mode: 'content' }, w.ctx)).data));
    outs.push(JSON.stringify((await w.execution.execute('system.storage', {}, w.ctx)).data));
    outs.push(JSON.stringify((await w.execution.execute('system.status', {}, w.ctx)).data));
    try { await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'missing.txt' }, w.ctx); }
    catch (err) { outs.push(JSON.stringify((err as ArthurError).toJSON())); }
    try { await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: '../x' }, w.ctx); }
    catch (err) { outs.push(JSON.stringify((err as ArthurError).toJSON())); }
    for (const o of outs) assert.ok(o.indexOf(projects) < 0, 'leak: ' + o.slice(0, 200));
  } finally { w.close(); }
});

test('F18/F19/F20 app injection matrix: rejection with spawn calls = 0', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const evil = ['unknown-app', 'firefox.exe', 'firefox --arg', 'firefox; calc', 'FIREFOX', ''];
    for (const id of evil) {
      const c = await codeOfAsync(w.execution.execute('app.launch', { app_id: id }, w.ctx));
      assert.ok(c === 'TOOL_ARGUMENT_INVALID' || c === 'TOOL_CAPABILITY_UNAVAILABLE', id + ' -> ' + c);
    }
    const sep = String.fromCharCode(92);
    for (const id of ['..' + sep + 'evil.exe', 'firefox' + sep + 'x', 'C:' + sep + 'Windows' + sep + 'System32' + sep + 'cmd.exe', 'firefox && calc', 'firefox|calc']) {
      const c = await codeOfAsync(w.execution.execute('app.launch', { app_id: id }, w.ctx));
      assert.ok(c === 'TOOL_ARGUMENT_INVALID' || c === 'TOOL_CAPABILITY_UNAVAILABLE', JSON.stringify(id) + ' -> ' + c);
    }
    assert.equal(await codeOfAsync(w.execution.execute('app.launch', { app_id: 'firefox', executable: '/bin/evil' }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    assert.equal(await codeOfAsync(w.execution.execute('app.launch', { app_id: 'firefox', args: ['x'] }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    assert.equal(await codeOfAsync(w.execution.execute('app.launch', { app_id: 'firefox', env: {} }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    assert.equal(w.apps.spawnCalls(), 0, 'no spawn for any rejected proposal');
    assert.equal(w.launched.length, 0);
  } finally { w.close(); }
});

test('missing configured app: available=false, startup still succeeds', async () => {
  const { projects } = sandbox();
  const apps = new NodeLocalApplicationAdapter(
    [{ id: 'ghost', display_name: 'Ghost', executable: path.join(projects, 'does-not-exist-bin'), args: [] }],
    { availability: async () => false },
  );
  assert.deepEqual(await apps.list(), [{ id: 'ghost', name: 'Ghost', available: false }]);
  const host = buildDefaultLocalHost(new NodeLocalSystemAdapter(), {
    filesystem_roots: [{ id: 'projects', label: 'P', physical_root: projects, permissions: ['list'] }],
    applications: [{ id: 'ghost', display_name: 'Ghost', executable: path.join(projects, 'does-not-exist-bin'), args: [] }],
    filesystem_bounds: { list_limit_max: 200, read_max_lines: 200, read_max_bytes: 12288, search_max_results: 50, search_max_files: 5000, search_max_bytes_per_file: 1048576, search_max_total_bytes: 52428800 },
  });
  assert.equal((await host.applications.list())[0]?.available, false);
});

test('F21 launch boundary: trusted exe+args only, shell:false, no exec/cmd/sh', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    await w.execution.execute('app.launch', { app_id: 'firefox' }, w.ctx);
    assert.equal(w.launched.length, 1);
    assert.equal(w.launched[0]?.exe, path.join(projects, 'firefox-bin'));
    assert.deepEqual(w.launched[0]?.args, ['--safe']);
    const appSrc = readFileSync('src/tools/adapters/local_applications.ts', 'utf8');
    const broSrc = readFileSync('src/tools/adapters/local_browser.ts', 'utf8');
    assert.ok(appSrc.indexOf('shell: false') >= 0, 'app shell:false');
    assert.ok(broSrc.indexOf('shell: false') >= 0, 'browser shell:false');
    assert.ok(appSrc.indexOf('cmd') < 0 || appSrc.indexOf('/c", "start"') < 0, 'app has no cmd /c spawn');
    // The only remaining 'cmd /c' mention in the browser adapter is the
    // comment documenting WHY rundll32 replaced it (FIX-D); no spawn call
    // may pass '/c' as an argument.
    assert.ok(broSrc.indexOf('"/c"') < 0 && broSrc.indexOf("'/c'") < 0, 'browser never spawns cmd /c (rundll32 path)');
    const plat = platformLauncher();
    assert.notEqual(plat.exe.toLowerCase(), 'cmd');
    assert.ok(plat.args('https://example.com/').indexOf('https://example.com/') >= 0, 'URL is one argv element');
  } finally { w.close(); }
});

test('F22 child env: canaries never inherit; plumbing preserved; denylist-first', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  const canaries: Record<string, string> = { DEEPSEEK_API_KEY: 'canary-deepseek-1', ARTHUR_PRIVATE_CANARY: 'canary-arthur-2', SOME_ACCESS_TOKEN: 'canary-token-3', DB_PASSWORD: 'canary-pw-4', CLIENT_SECRET: 'canary-secret-5', AWS_SECRET_ACCESS_KEY: 'canary-aws-6', SC04_RANDOM_SECRET: 'canary-rnd-7' };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(canaries)) { saved[k] = process.env[k]; (process.env as Record<string, string>)[k] = canaries[k] as string; }
  try {
    await w.execution.execute('app.launch', { app_id: 'firefox' }, w.ctx);
    assert.equal(w.launched.length, 1);
    const env = w.launched[0]?.env ?? {};
    for (const k of Object.keys(canaries)) {
      assert.equal(env[k], undefined, k + ' must not inherit');
      for (const val of Object.values(env)) {
        if (typeof val === 'string') assert.ok(val.indexOf(canaries[k] as string) < 0, 'value leak of ' + k);
      }
    }
    const child = buildChildEnv({ PATH: 'C:/bin', SystemRoot: 'C:/Windows', TEMP: 'C:/Temp', LANG: 'en_US.UTF-8', DEEPSEEK_API_KEY: 's3cr3t' } as NodeJS.ProcessEnv);
    assert.equal(child.PATH, 'C:/bin');
    assert.equal(child.SystemRoot, 'C:/Windows');
    assert.equal(child.DEEPSEEK_API_KEY, undefined);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    w.close();
  }
});

test('launch failure sanitization: raw paths/errnos/stacks never cross', async () => {
  const { projects } = sandbox();
  const apps = new NodeLocalApplicationAdapter(
    [{ id: 'boom', display_name: 'Boom', executable: path.join(projects, 'boom-bin'), args: [] }],
    { launcher: async () => { const err = new Error('spawn failed ENOENT EPERM'); (err as { code?: string }).code = 'ENOENT'; throw err; }, availability: async () => true },
  );
  try { await apps.launch('boom'); assert.fail('expected failure'); }
  catch (err) {
    assert.ok(err instanceof ArthurError);
    assert.equal((err as ArthurError).code, 'TOOL_EXECUTION_FAILED');
    const json = JSON.stringify((err as ArthurError).toJSON());
    assert.ok(json.indexOf('ENOENT') < 0, 'raw errno must not leak');
    assert.ok(json.indexOf('EPERM') < 0, 'raw errno must not leak');
  }
});

test('F23/F24 browser URL boundary', () => {
  assert.ok(validateBrowserUrl('https://example.com/').indexOf('https://') === 0);
  assert.ok(validateBrowserUrl('http://example.com/').indexOf('http://') === 0);
  assert.ok(validateBrowserUrl('http://localhost:3000/').indexOf('localhost') >= 0);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://x/y', 'custom://x', 'shell:open']) {
    assert.throws(() => validateBrowserUrl(bad), /Only http and https/, bad);
  }
  assert.throws(() => validateBrowserUrl('https://user:<redacted:nexus-contributor-secret>@example.com/'), /credentials/);
  assert.throws(() => validateBrowserUrl('https://example.com/\nX-Inject: 1'), /control/);
  assert.throws(() => validateBrowserUrl('https://' + 'a'.repeat(5000)), /exceeds/);
});

test('F25 shell-metachar URLs reach the launcher as one inert arg', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const tricky = 'https://example.com/search?q=a&b;c|d';
    const res = await w.execution.execute('browser.open_url', { url: tricky }, w.ctx);
    assert.equal((res.data as { opened: boolean }).opened, true);
    assert.equal(w.opened.length, 1);
    assert.equal(w.opened[0], validateBrowserUrl(tricky));
    const plat = platformLauncher();
    assert.ok(plat.args(tricky).some((a) => a === tricky), 'URL exactly one argv element');
  } finally { w.close(); }
});

test('F26/F27 launch tools never blindly retry: one spawn through the coordinator', async () => {
  const { projects } = sandbox();
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'P', physical_root: projects, permissions: ['list'] },
  ]);
  let spawnCalls = 0;
  const apps = new NodeLocalApplicationAdapter(
    [{ id: 'flaky', display_name: 'Flaky', executable: path.join(projects, 'flaky-bin'), args: [] }],
    { launcher: async () => { spawnCalls += 1; throw new Error('transient EAGAIN simulation'); }, availability: async () => true },
  );
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes),
    applications: apps,
    browser: new NodeLocalBrowserAdapter({ launcher: async () => undefined }),
  };
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }), { host });
  const appPolicy = registry.getExecutionPolicy('app.launch');
  assert.equal(appPolicy?.effects, 'mutation');
  assert.equal(appPolicy?.idempotency, 'none');
  assert.equal(appPolicy?.retry.strategy, 'off');
  assert.equal(appPolicy?.retry.max_attempts, 1);
  assert.equal(appPolicy?.cancellation, 'unsupported');
  assert.equal(appPolicy?.reconciliation, 'none');
  const broPolicy = registry.getExecutionPolicy('browser.open_url');
  assert.equal(broPolicy?.retry.strategy, 'off');
  assert.equal(broPolicy?.retry.max_attempts, 1);
  assert.equal(broPolicy?.cancellation, 'unsupported');
  const permissions = new PermissionService();
  const store = new SessionStore(':memory:', new SecretSanitizer([]));
  const executions = new ExecutionStore(store.unsafeDbHandle(), store.sanitizerHandle());
  const clock = new FakeExecutionClock(Date.parse('2026-01-01T00:00:00.000Z'), [0.5]);
  const coordinator = new ToolExecutionCoordinator(store, executions, registry, permissions, registry.createSingleAttemptService(permissions), new SecretSanitizer([]), new Logger('error'), new InMemoryMetrics(), { runtimeInstanceId: 'rt-f26', clock });
  store.createSession('s1', ArthurMode.PERSONAL);
  store.createTurn({ id: 't1', sessionId: 's1', role: 'user', text: 'go', traceId: 'tr1', status: 'completed', mode: ArthurMode.PERSONAL });
  const policy = registry.getExecutionPolicy('app.launch') as ToolExecutionPolicy;
  const req = { toolName: 'app.launch', args: { app_id: 'flaky' }, sessionId: 's1', turnId: 't1', traceId: 'tr1', mode: ArthurMode.PERSONAL, toolCallId: 'tc-flaky', approvalId: null, toolVersion: '1.0.0', toolDefinitionHash: registry.getDefinitionHash('app.launch') as string, argumentsHash: 'b'.repeat(64), policy };
  store.createToolCall({ id: 'tc-flaky', turnId: 't1', toolName: 'app.launch', argumentsJson: '{}', riskLevel: 'low_write', status: 'executing' });
  const created = coordinator.createExecution(req);
  let run = await coordinator.run(req, created.id);
  let guard = 0;
  while (run.state === 'retry_wait' && guard < 5) { guard += 1; run = await coordinator.run(req, created.id); }
  assert.equal(spawnCalls, 1, 'exactly one spawn attempt, state=' + run.state);
  store.close();
});

test('F28 filesystem tools honor an aborted SC-03 signal', async () => {
  const { projects } = sandbox();
  const big = path.join(projects, 'wide');
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 30; i += 1) writeFileSync(path.join(big, 'f-' + i + '.txt'), 'content line\ncontent line\n');
  writeFileSync(path.join(projects, 'note.txt'), 'hello\nhello\n');
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'P', physical_root: projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const fs = new NodeLocalFilesystemAdapter(scopes);
  const aborted = AbortSignal.abort(new Error('user cancel'));
  await assert.rejects(fs.search('projects', '.', 'content', 'content', 50, aborted), /cancel/i);
  await assert.rejects(fs.list('projects', 'wide', 0, 50, aborted), /cancel/i);
  await assert.rejects(fs.readText('projects', 'note.txt', 1, 10, 4096, aborted), /cancel/i);
});

test('F29 adapters deterministic without real GUI or user filesystem', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const a = await w.execution.execute('app.list', {}, w.ctx);
    const b = await w.execution.execute('app.list', {}, w.ctx);
    assert.deepEqual(a.data, b.data);
    const s1 = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'nothing-here-zzz', mode: 'content' }, w.ctx);
    const s2 = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'nothing-here-zzz', mode: 'content' }, w.ctx);
    assert.deepEqual(s1.data, s2.data);
  } finally { w.close(); }
});

test('config fail-closed matrix: invalid security config never falls back', () => {
  const { projects } = sandbox();
  const dir2 = mkdtempSync(path.join(tmpdir(), 'sc04-gapc2-'));
  const goodBounds = { list_limit_max: 200, read_max_lines: 200, read_max_bytes: 12288, search_max_results: 50, search_max_files: 5000, search_max_bytes_per_file: 1048576, search_max_total_bytes: 52428800 };
  const goodRoot = { id: 'projects', label: 'P', physical_root: projects, permissions: ['list'] as Array<'list'> };
  const goodApp = { id: 'firefox', display_name: 'Firefox', executable: path.join(projects, 'fx'), args: [] as string[] };
  assert.throws(() => validateLocalCapabilityConfig({ filesystem_roots: [goodRoot, { ...goodRoot, physical_root: dir2 }], applications: [], filesystem_bounds: goodBounds }), /Duplicate filesystem scope id/);
  assert.throws(() => validateLocalCapabilityConfig({ filesystem_roots: [{ ...goodRoot, id: 'BAD' }], applications: [], filesystem_bounds: goodBounds }), /scope id/);
  assert.throws(() => validateLocalCapabilityConfig({ filesystem_roots: [{ ...goodRoot, physical_root: 'relative/path' }], applications: [], filesystem_bounds: goodBounds }), /absolute/);
  assert.throws(() => validateLocalCapabilityConfig({ filesystem_roots: [goodRoot, { ...goodRoot, id: 'dup' }], applications: [], filesystem_bounds: goodBounds }), /Duplicate filesystem physical root/);
  assert.throws(() => validateLocalCapabilityConfig({ filesystem_roots: [goodRoot], applications: [], filesystem_bounds: { ...goodBounds, list_limit_max: 0 } }), /filesystem_bounds/);
  assert.throws(() => validateLocalCapabilityConfig({ filesystem_roots: [goodRoot], applications: [goodApp, { ...goodApp }], filesystem_bounds: goodBounds }), /Duplicate application id/);
  assert.throws(() => validateApplicationEntry({ ...goodApp, id: 'Bad Id' }), /application id/);
  assert.throws(() => validateApplicationEntry({ ...goodApp, shell: true }), /forbidden field shell/);
  assert.throws(() => validateApplicationEntry({ ...goodApp, executable: 'relative/firefox' }), /absolute/);
  assert.throws(() => buildDefaultLocalHost(new NodeLocalSystemAdapter(), { filesystem_roots: [goodRoot], applications: [{ ...goodApp, shell: true } as never], filesystem_bounds: goodBounds }), /forbidden field shell/);
  assert.throws(() => buildDefaultLocalHost(new NodeLocalSystemAdapter(), { filesystem_roots: [goodRoot], applications: [{ ...goodApp, executable: 'relative/fx' }], filesystem_bounds: goodBounds }), /absolute/);
});

test('all 10 tools expose frozen SC-03 policies; model args cannot alter them', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const names = ['system.status', 'system.storage', 'filesystem.roots', 'filesystem.list', 'filesystem.stat', 'filesystem.read_text', 'filesystem.search', 'app.list', 'app.launch', 'browser.open_url'];
    for (const n of names) {
      const def = w.registry.getDefinition(n);
      const pol = w.registry.getExecutionPolicy(n);
      assert.ok(def && pol, n + ' registered with policy');
      assert.ok(Object.isFrozen(def), n + ' definition frozen');
    }
    for (const n of ['system.status', 'system.storage', 'filesystem.roots', 'filesystem.list', 'filesystem.stat', 'filesystem.read_text', 'filesystem.search', 'app.list']) {
      assert.equal(w.registry.getExecutionPolicy(n)?.effects, 'none', n);
      assert.equal(w.registry.getExecutionPolicy(n)?.cancellation, 'cooperative', n);
    }
    for (const n of ['app.launch', 'browser.open_url']) {
      assert.equal(w.registry.getDefinition(n)?.risk, 'low_write', n);
      assert.equal(w.registry.getExecutionPolicy(n)?.effects, 'mutation', n);
      assert.equal(w.registry.getExecutionPolicy(n)?.retry.strategy, 'off', n);
      assert.equal(w.registry.getExecutionPolicy(n)?.cancellation, 'unsupported', n);
    }
    assert.equal(await codeOfAsync(w.execution.execute('app.launch', { app_id: 'firefox', retry: { strategy: 'transient' } }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'x', max_total_bytes: 1 }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
  } finally { w.close(); }
});

test('no raw OS errors leak across the capability boundary', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'filesystem.read_text', args: { root_id: 'projects', path: 'no-such-file-xyz.txt' } },
      { tool: 'filesystem.stat', args: { root_id: 'projects', path: 'no-such-file-xyz.txt' } },
      { tool: 'filesystem.list', args: { root_id: 'projects', path: 'no-such-dir-xyz' } },
      { tool: 'filesystem.read_text', args: { root_id: 'projects', path: '../escape' } },
      { tool: 'app.launch', args: { app_id: 'ghost-app' } },
    ];
    for (const c of cases) {
      try { await w.execution.execute(c.tool, c.args, w.ctx); assert.fail('expected failure for ' + c.tool); }
      catch (err) {
        assert.ok(err instanceof ArthurError);
        const json = JSON.stringify((err as ArthurError).toJSON());
        assert.ok(json.indexOf('ENOENT') < 0, c.tool + ' leaks ENOENT');
        assert.ok(json.indexOf('EACCES') < 0, c.tool + ' leaks EACCES');
        assert.ok(json.indexOf('EPERM') < 0, c.tool + ' leaks EPERM');
        assert.ok(json.indexOf(projects) < 0, c.tool + ' leaks physical root');
      }
    }
  } finally { w.close(); }
});

test('F01/F02 host has no dispatcher; all 10 tools run through the secured path', async () => {
  const src = readFileSync('src/tools/local_host.ts', 'utf8');
  assert.ok(src.indexOf('execute(') < 0, 'host must not define execute()');
  assert.ok(/[^a-zA-Z]run\s*\(/.test(src) === false, 'host must not define run()');
  assert.ok(src.indexOf('dispatch(') < 0, 'host must not define dispatch()');
  assert.ok(src.indexOf('callTool(') < 0, 'host must not define callTool()');
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    for (const n of ['system.status', 'system.storage', 'filesystem.roots', 'filesystem.list', 'filesystem.stat', 'filesystem.read_text', 'filesystem.search', 'app.list', 'app.launch', 'browser.open_url']) {
      assert.ok(w.registry.getDefinition(n), n + ' registered');
    }
    const hostile = await w.orchestrator.handleProposed([{ id: 'x', name: 'filesystem.read_text', arguments: { root_id: 'projects', path: '../../secret' } }], w.ctx);
    assert.equal(hostile.summaries[0]?.status, 'failed');
  } finally { w.close(); }
});

test('F03/F04 public surfaces expose no raw adapters or executable handles', async () => {
  const { buildTestApp } = await import('../helpers');
  const app = buildTestApp();
  try {
    const keys = Object.keys(app);
    for (const forbidden of ['localHost', 'localFilesystem', 'localBrowser', 'localApps', 'localSystem', 'adapter', 'executor', 'registry', 'execution', 'orchestrator', 'harness']) {
      assert.equal(keys.indexOf(forbidden) < 0, true, 'App must not expose ' + forbidden);
    }
    const appSrc = readFileSync('src/app.ts', 'utf8');
    assert.ok(appSrc.indexOf('const localHost: LocalCapabilityHost') >= 0, 'buildApp composes the host internally');
  } finally { app.close(); }
});

test('system.storage returns only scope identities plus totals', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const res = await w.execution.execute('system.storage', {}, w.ctx);
    const data = res.data as { roots: Array<{ root_id: string; total_bytes: number; free_bytes: number }> };
    assert.equal(data.roots.length, 1);
    assert.deepEqual(Object.keys(data.roots[0] as object).sort(), ['free_bytes', 'root_id', 'total_bytes']);
    assert.equal(data.roots[0]?.root_id, 'projects');
    assert.ok(JSON.stringify(data).indexOf(projects) < 0, 'no physical mount path');
  } finally { w.close(); }
});

test('deterministic exclusions: search skips generated dirs by default', async () => {
  const { projects } = sandbox();
  for (const d of ['.git', 'node_modules', 'dist', 'build', '.cache', 'src']) {
    mkdirSync(path.join(projects, d), { recursive: true });
    writeFileSync(path.join(projects, d, 'hit.txt'), 'exclusionmarker-abc content\n');
  }
  const w = buildWorld(projects);
  try {
    const res = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'exclusionmarker-abc', mode: 'content' }, w.ctx);
    const rels = (res.data as { matches: Array<{ relative_path: string }> }).matches.map((m) => m.relative_path);
    assert.ok(rels.some((r) => r.indexOf('src/') === 0), 'src hit present: ' + rels.join(','));
    for (const d of ['.git', 'node_modules', 'dist', 'build', '.cache']) {
      assert.ok(!rels.some((r) => r.indexOf(d + '/') === 0), d + ' must be skipped');
    }
  } finally { w.close(); }
});

test('search is literal-only: regex metacharacters are inert', async () => {
  const { projects } = sandbox();
  writeFileSync(path.join(projects, 'a.txt'), 'aaa bbb\n');
  const w = buildWorld(projects);
  try {
    const res = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'a.*b', mode: 'content' }, w.ctx);
    assert.equal((res.data as { matches: unknown[] }).matches.length, 0, 'literal match only');
  } finally { w.close(); }
});

test('sortFilesystemEntries is deterministic', () => {
  const entries = [
    { name: 'b.txt', type: 'file', size_bytes: 1 },
    { name: 'a', type: 'directory', size_bytes: 0 },
    { name: 'c', type: 'symlink', size_bytes: 0 },
    { name: 'a.txt', type: 'file', size_bytes: 2 },
  ] as Parameters<typeof sortFilesystemEntries>[0];
  const once = sortFilesystemEntries(entries).map((e) => e.name);
  const twice = sortFilesystemEntries([...entries].reverse()).map((e) => e.name);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ['a', 'a.txt', 'b.txt', 'c']);
});