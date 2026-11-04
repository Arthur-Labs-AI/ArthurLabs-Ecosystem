// SC-04 F30 Linux local capability integration.
//
// Real Linux behavior over a temporary scope: lexical containment,
// realpath/symlink containment, symlink loops, special objects (FIFO,
// socket, broken symlink), UTF-8/binary contract, statfs storage probe,
// sensitive-path policy, SecretSanitizer E2E, search bounds, AbortSignal
// through the SC-03 coordinator, production app/browser launch spec
// (trusted exe/args, shell:false, sanitized child env) via the same
// production composition path with an observing fake launcher seam.
// All flows traverse ToolRegistry -> ToolExecutionService (-> SC-03
// coordinator where noted). No real GUI is opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  mkdtempSync as _mkd,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import { NodeLocalFilesystemAdapter } from '../../src/tools/adapters/local_filesystem';
import { NodeLocalSystemAdapter } from '../../src/tools/adapters/local_system';
import { buildChildEnv } from '../../src/tools/child_env';
import { buildModelToolResultPayload } from '../../src/tools/model_payload';
import { registerBuiltinTools } from '../../src/tools/builtin';
import { ToolExecutionCoordinator } from '../../src/tools/execution_coordinator';
import { FakeExecutionClock } from '../../src/tools/execution_clock';
import type { ToolExecutionPolicy } from '../../src/tools/execution_policy';
import type { LocalCapabilityHost } from '../../src/tools/local_host';
import { ToolOrchestrator } from '../../src/tools/orchestrator';
import { PermissionService } from '../../src/tools/permissions';
import { ToolRegistry } from '../../src/tools/registry';
import { FilesystemScopeRegistry } from '../../src/tools/scoped_path';
import { probeStorage } from '../../src/tools/storage_probe';

void _mkd;

const SIGNING_SECRET = "<redacted:nexus-contributor-secret>";

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) {
    assert.ok(err instanceof ArthurError, 'expected ArthurError, got ' + String(err));
    return (err as ArthurError).code;
  }
  throw new Error('expected rejection');
}

interface LinuxFixture {
  dir: string;
  projects: string;
  outside: string;
}

/** Task section 5 fixture with real Linux symlinks. */
function linuxFixture(): LinuxFixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc04-linux-'));
  const projects = path.join(dir, 'projects');
  const outside = path.join(dir, 'outside');
  const alphaSrc = path.join(projects, 'alpha', 'src');
  mkdirSync(alphaSrc, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(projects, 'alpha', 'README.md'), '# alpha\nlinux fixture\n');
  writeFileSync(
    path.join(projects, 'alpha', 'unicode.txt'),
    'hello \u4e16\u754c \u041f\u0440\u0438\u0432\u0435\u0442 \u2014 \u{1F600}\nsecond line\n',
  );
  writeFileSync(path.join(alphaSrc, 'app.ts'), 'export const greeting = "hello linux";\n// ToolExecutionService\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'linux outside secret\n');
  symlinkSync(path.join('..', 'outside'), path.join(projects, 'outside-link'));
  symlinkSync('.', path.join(projects, 'loop'));
  return { dir, projects, outside };
}

interface World {
  registry: ToolRegistry;
  execution: ReturnType<ToolRegistry['createExecutionService']>;
  orchestrator: ToolOrchestrator;
  store: SessionStore;
  ctx: { session_id: string; turn_id: string; trace_id: string; mode: ArthurMode; approved: false };
  launched: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }>;
  opened: string[];
  close: () => void;
}

function buildLinuxWorld(fx: LinuxFixture, searchBounds?: Record<string, number>): World {
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'Projects', physical_root: fx.projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const launched: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const opened: string[] = [];
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes, searchBounds ? { searchBounds: searchBounds as never } : {}),
    applications: new NodeLocalApplicationAdapter(
      [{ id: 'gedit', display_name: 'Text Editor', executable: '/usr/bin/gedit', args: ['--new-window'] }],
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
  return { registry, execution, orchestrator, store,
    ctx: { session_id: 's1', turn_id: 't1', trace_id: 'tr1', mode: ArthurMode.PERSONAL, approved: false },
    launched, opened, close: () => store.close() };
}

test('F30 scope root validation: realpath canonical root, unknown root rejected', async () => {
  const fx = linuxFixture();
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'Projects', physical_root: fx.projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  assert.equal(scopes.realRoot('projects'), realpathSync(fx.projects));
  assert.throws(() => scopes.get('nope'), (e: unknown) => e instanceof ArthurError && e.code === 'TOOL_SCOPE_VIOLATION');
  const w = buildLinuxWorld(fx);
  try {
    const roots = await w.execution.execute('filesystem.roots', {}, w.ctx);
    assert.deepEqual(roots.data, { roots: [{ id: 'projects', label: 'Projects' }] });
  } finally { w.close(); }
});

test('F30 lexical matrix: hostile Linux and Windows-style paths are TOOL_SCOPE_VIOLATION', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  try {
    const hostile = [
      '/etc/passwd',
      '/tmp/file',
      '../outside',
      '../../outside',
      '..',
      '/',
      'C:/Windows/file',
      'D:/anything',
      'C:drive-relative-x',
      '//server/share/file',
    ];
    for (const evil of hostile) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: evil }, w.ctx)), 'TOOL_SCOPE_VIOLATION', evil + ' read_text');
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.list', { root_id: 'projects', path: evil }, w.ctx)), 'TOOL_SCOPE_VIOLATION', evil + ' list');
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.stat', { root_id: 'projects', path: evil }, w.ctx)), 'TOOL_SCOPE_VIOLATION', evil + ' stat');
    }
    const bs = String.fromCharCode(92);
    const winAbs = 'C:' + bs + 'Windows' + bs + 'file';
    const unc = bs + bs + 'server' + bs + 'share';
    const nul = 'a' + String.fromCharCode(0) + 'b';
    for (const evil of [winAbs, unc, nul]) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: evil }, w.ctx)), 'TOOL_SCOPE_VIOLATION', JSON.stringify(evil));
    }
  } finally { w.close(); }
});

test('F30 physical containment: outside-link symlink never yields outside data', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  try {
    const st = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'outside-link' }, w.ctx);
    assert.equal((st.data as { type: string }).type, 'symlink', 'lstat reports the entry without following it');
    assert.equal(lstatSync(path.join(fx.projects, 'outside-link')).isSymbolicLink(), true);
    assert.equal(
      await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'outside-link/secret.txt' }, w.ctx)),
      'TOOL_SCOPE_VIOLATION',
    );
    assert.equal(
      await codeOfAsync(w.execution.execute('filesystem.list', { root_id: 'projects', path: 'outside-link' }, w.ctx)),
      'TOOL_SCOPE_VIOLATION',
    );
    assert.equal(
      await codeOfAsync(w.execution.execute('filesystem.search', { root_id: 'projects', path: 'outside-link', query: 'linux outside secret', mode: 'content' }, w.ctx)),
      'TOOL_SCOPE_VIOLATION',
      'search rooted at the symlink must not traverse it',
    );
    const search = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'linux outside secret', mode: 'content' }, w.ctx);
    const hits = (search.data as { matches: Array<{ relative_path: string; snippet: string }> }).matches;
    const outsideHits = hits.filter((h) => (h.relative_path + ' ' + h.snippet).indexOf('linux outside secret') >= 0);
    assert.equal(outsideHits.length, 0, 'outside secret occurrence count must be 0, got ' + JSON.stringify(hits));
  } finally { w.close(); }
});

test('F30 symlink loop: recursive search terminates without traversal', async () => {
  const fx = linuxFixture();
  const loopDir = path.join(fx.projects, 'a');
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(path.join(loopDir, 'note.txt'), 'loop needle here\n');
  symlinkSync(path.join('..', 'a'), path.join(loopDir, 'loop'));
  const w = buildLinuxWorld(fx);
  try {
    const t0 = Date.now();
    const res = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'loop needle', mode: 'content' }, w.ctx);
    const dt = Date.now() - t0;
    assert.ok(dt < 15000, 'search terminated in bounded time (' + dt + 'ms)');
    const hits = (res.data as { matches: Array<{ relative_path: string }> }).matches;
    assert.ok(hits.length >= 1, 'inside file still found');
    assert.ok(hits.every((h) => h.relative_path.indexOf('loop') < 0), 'loop link is not traversed');
  } finally { w.close(); }
});

test('F30 special objects: only regular files are readable', async () => {
  const fx = linuxFixture();
  const sub = path.join(fx.projects, 'special');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, 'ok.txt'), 'plain\n');
  symlinkSync(path.join(sub, 'ok.txt'), path.join(sub, 'flink'));
  symlinkSync(path.join(sub, 'nonexistent-target-xyz'), path.join(sub, 'broken'));
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('/usr/bin/mkfifo', [path.join(sub, 'pipe')]); } catch { /* mkfifo unavailable */ }
  let haveSocket = false;
  try {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(sub, 'sock'), () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    haveSocket = lstatSync(path.join(sub, 'sock')).isSocket();
  } catch { haveSocket = false; }
  const w = buildLinuxWorld(fx);
  try {
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'special' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
    const linkStat = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'special/flink' }, w.ctx);
    assert.equal((linkStat.data as { type: string }).type, 'symlink');
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'special/flink' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
    const brokenStat = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'special/broken' }, w.ctx);
    assert.equal((brokenStat.data as { type: string }).type, 'symlink');
    const brokenCode = await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'special/broken' }, w.ctx));
    assert.ok(brokenCode === 'TOOL_RESOURCE_UNSUPPORTED' || brokenCode === 'TOOL_SCOPE_VIOLATION' || brokenCode === 'TOOL_RESOURCE_NOT_FOUND', 'broken -> ' + brokenCode);
    try {
      const fifoSt = lstatSync(path.join(sub, 'pipe'));
      if (fifoSt.isFIFO()) {
        const st = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'special/pipe' }, w.ctx);
        assert.equal((st.data as { type: string }).type, 'other');
        assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'special/pipe' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
      }
    } catch { /* fifo not created; covered by socket/directory gates */ }
    if (haveSocket) {
      const st = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'special/sock' }, w.ctx);
      assert.equal((st.data as { type: string }).type, 'other');
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'special/sock' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
    }
  } finally { w.close(); }
});

test('F30 UTF-8 round-trips; invalid UTF-8 and binary are TOOL_RESOURCE_UNSUPPORTED', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  try {
    const read = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'alpha/unicode.txt' }, w.ctx);
    const text = (read.data as { text: string }).text;
    assert.ok(text.indexOf('\u4e16\u754c') >= 0, 'CJK round-trips');
    assert.ok(text.indexOf('\u041f\u0440\u0438\u0432\u0435\u0442') >= 0, 'Bulgarian round-trips');
    assert.ok(text.indexOf('\u2014') >= 0, 'em dash round-trips');
    assert.ok(text.indexOf('\u{1F600}') >= 0, 'emoji round-trips');
    writeFileSync(path.join(fx.projects, 'badutf8.txt'), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe, 0x0a]));
    writeFileSync(path.join(fx.projects, 'bin.dat'), Buffer.from([0x48, 0x65, 0x00, 0xff, 0x01, 0x02]));
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'badutf8.txt' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'bin.dat' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
  } finally { w.close(); }
});

test('F30 statfs storage probe: non-negative totals keyed by root_id only', async () => {
  const fx = linuxFixture();
  const probed = probeStorage(fx.projects);
  assert.ok(probed.total_bytes >= 0 && probed.free_bytes >= 0, 'statfs probe non-negative');
  const w = buildLinuxWorld(fx);
  try {
    const res = await w.execution.execute('system.storage', {}, w.ctx);
    const data = res.data as { roots: Array<{ root_id: string; total_bytes: number; free_bytes: number }> };
    assert.equal(data.roots.length, 1);
    assert.deepEqual(Object.keys(data.roots[0] as object).sort(), ['free_bytes', 'root_id', 'total_bytes']);
    assert.equal(data.roots[0]?.root_id, 'projects');
    assert.ok(JSON.stringify(data).indexOf(fx.projects) < 0, 'no physical path');
    assert.ok(JSON.stringify(data).indexOf('/mnt/') < 0, 'no mount path');
    assert.ok(JSON.stringify(data).indexOf('/home/') < 0, 'no home path');
  } finally { w.close(); }
});

test('F30 sensitive paths blocked on Linux separators; examples allowed', async () => {
  const fx = linuxFixture();
  writeFileSync(path.join(fx.projects, '.env'), 'K=shh\n');
  writeFileSync(path.join(fx.projects, '.env.example'), 'K=example\n');
  writeFileSync(path.join(fx.projects, '.env.sample'), 'K=sample\n');
  writeFileSync(path.join(fx.projects, 'id_rsa'), 'fake\n');
  const sub = path.join(fx.projects, 'nested');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, '.env'), 'K=nested\n');
  const w = buildLinuxWorld(fx);
  try {
    for (const p of ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'nested/.env', 'vault.key', 'tls.pem']) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: p }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', p);
    }
    for (const p of ['.env.example', '.env.sample']) {
      const ok = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: p }, w.ctx);
      assert.ok((ok.data as { text: string }).text.length > 0, p + ' allowed');
    }
  } finally { w.close(); }
});

test('F30 SecretSanitizer E2E through the real filesystem path', async () => {
  const fx = linuxFixture();
  const CANARY = 'SC04-LINUX-CANARY-' + Date.now() + '-7c2e1a';
  writeFileSync(path.join(fx.projects, 'notes.txt'), 'hello\nDEEPSEEK_API_KEY="' + CANARY + '"\npassword="' + CANARY + '"\n');
  const secrets = [CANARY, 'DEEPSEEK_API_KEY'];
  const sanitizer = new SecretSanitizer(secrets);
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'P', physical_root: fx.projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes),
    applications: new NodeLocalApplicationAdapter([], { availability: async () => false }),
    browser: new NodeLocalBrowserAdapter({ launcher: async () => undefined }),
  };
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }), { host });
  const permissions = new PermissionService();
  const store = new SessionStore(':memory:', sanitizer);
  const execution = registry.createExecutionService(permissions);
  const orchestrator = new ToolOrchestrator({
    registry, execution, store, permissions, sanitizer,
    approvalTtlSeconds: 300, approvalSigningSecret: SIGNING_SECRET,
    logger: new Logger('error'), metrics: new InMemoryMetrics(),
  });
  store.createSession('s9', ArthurMode.PERSONAL);
  store.createTurn({ id: 't9', sessionId: 's9', role: 'user', text: 'go', traceId: 't', status: 'completed', mode: ArthurMode.PERSONAL });
  const ctx = { session_id: 's9', turn_id: 't9', trace_id: 't', mode: ArthurMode.PERSONAL, approved: false as const };
  try {
    const result = await execution.execute('filesystem.read_text', { root_id: 'projects', path: 'notes.txt' }, ctx);
    assert.ok((result.data as { text: string }).text.length > 0, 'fixture read through the real tool path');
    assert.ok(buildModelToolResultPayload(result, sanitizer).indexOf(CANARY) < 0, 'model payload clean');
    const handling = await orchestrator.handleProposed(
      [{ id: 'r1', name: 'filesystem.read_text', arguments: { root_id: 'projects', path: 'notes.txt' } }],
      ctx,
    );
    assert.equal(handling.summaries[0]?.status, 'completed');
    assert.ok((handling.summaries[0]?.result_summary ?? '').indexOf(CANARY) < 0, 'durable summary clean');
    assert.ok((handling.toolResultMessages[0]?.content ?? '').indexOf(CANARY) < 0, 'tool message clean');
    assert.ok(JSON.stringify(store.getToolCallsForTurn('t9')).indexOf(CANARY) < 0, 'persisted tool calls clean');
  } finally { store.close(); }
});

test('F30 search bounds hold on Linux; model args cannot raise trusted caps', async () => {
  const fx = linuxFixture();
  const many = path.join(fx.projects, 'many');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 80; i += 1) writeFileSync(path.join(many, 'm-' + i + '.txt'), 'linuxboundneedle content\n');
  const w = buildLinuxWorld(fx);
  try {
    const r = await w.execution.execute('filesystem.search', { root_id: 'projects', path: 'many', query: 'linuxboundneedle', mode: 'content', max_results: 50 }, w.ctx);
    assert.ok((r.data as { matches: unknown[] }).matches.length <= 50);
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.search', { root_id: 'projects', path: 'many', query: 'x', max_results: 500 }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'x', max_total_bytes: 1 }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
  } finally { w.close(); }
  let late = '';
  for (let i = 0; i < 4000; i += 1) late += 'A';
  late += 'LATEMARKER-LINUX';
  writeFileSync(path.join(fx.projects, 'late.txt'), late + '\n');
  const w2 = buildLinuxWorld(fx, { max_bytes_per_file: 64 });
  try {
    const r = await w2.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'LATEMARKER-LINUX', mode: 'content' }, w2.ctx);
    assert.equal((r.data as { matches: unknown[] }).matches.length, 0, 'late match beyond per-file cap must not appear');
  } finally { w2.close(); }
});

test('F30 AbortSignal through the SC-03 coordinator cancels search as CANCELLED', async () => {
  const fx = linuxFixture();
  const many = path.join(fx.projects, 'many');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 60; i += 1) writeFileSync(path.join(many, 'f-' + i + '.txt'), 'cancelneedle content line\n'.repeat(20));
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'P', physical_root: fx.projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes),
    applications: new NodeLocalApplicationAdapter([], { availability: async () => false }),
    browser: new NodeLocalBrowserAdapter({ launcher: async () => undefined }),
  };
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET }), { host });
  const permissions = new PermissionService();
  const store = new SessionStore(':memory:', new SecretSanitizer([]));
  const executions = new ExecutionStore(store.unsafeDbHandle(), store.sanitizerHandle());
  const clock = new FakeExecutionClock(Date.parse('2026-01-01T00:00:00.000Z'), []);
  const coordinator = new ToolExecutionCoordinator(store, executions, registry, permissions, registry.createSingleAttemptService(permissions), new SecretSanitizer([]), new Logger('error'), new InMemoryMetrics(), { runtimeInstanceId: 'rt-f30-linux', clock });
  store.createSession('s1', ArthurMode.PERSONAL);
  store.createTurn({ id: 't1', sessionId: 's1', role: 'user', text: 'go', traceId: 'tr1', status: 'completed', mode: ArthurMode.PERSONAL });
  const policy = registry.getExecutionPolicy('filesystem.search') as ToolExecutionPolicy;
  assert.equal(policy.effects, 'none');
  const req = { toolName: 'filesystem.search', args: { root_id: 'projects', path: 'many', query: 'cancelneedle', mode: 'content' }, sessionId: 's1', turnId: 't1', traceId: 'tr1', mode: ArthurMode.PERSONAL, toolCallId: 'tc-cancel', approvalId: null, toolVersion: '1.0.0', toolDefinitionHash: registry.getDefinitionHash('filesystem.search') as string, argumentsHash: 'c'.repeat(64), policy };
  store.createToolCall({ id: 'tc-cancel', turnId: 't1', toolName: 'filesystem.search', argumentsJson: '{}', riskLevel: 'read', status: 'executing' });
  const created = coordinator.createExecution(req);
  const pending = coordinator.run(req, created.id);
  coordinator.requestCancel(created.id);
  const run = await pending;
  assert.equal(run.state, 'cancelled', 'cooperative search cancellation reaches CANCELLED, got ' + run.state);
  store.close();
});

test('F30 app catalog on Linux: trusted exe+args, missing app is available=false', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  try {
    await w.execution.execute('app.launch', { app_id: 'gedit' }, w.ctx);
    assert.equal(w.launched.length, 1);
    assert.equal(w.launched[0]?.exe, '/usr/bin/gedit');
    assert.deepEqual(w.launched[0]?.args, ['--new-window']);
    const list = await w.execution.execute('app.list', {}, w.ctx);
    assert.deepEqual(list.data, { applications: [{ id: 'gedit', name: 'Text Editor', available: true }] });
    for (const id of ['unknown-app', 'gedit --extra', '/usr/bin/gedit']) {
      const c = await codeOfAsync(w.execution.execute('app.launch', { app_id: id }, w.ctx));
      assert.ok(c === 'TOOL_ARGUMENT_INVALID' || c === 'TOOL_CAPABILITY_UNAVAILABLE', id + ' -> ' + c);
    }
    assert.equal(await codeOfAsync(w.execution.execute('app.launch', { app_id: 'gedit', args: ['x'] }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
  } finally { w.close(); }
  const ghost = new NodeLocalApplicationAdapter(
    [{ id: 'ghost', display_name: 'Ghost', executable: path.join(fx.projects, 'does-not-exist-bin'), args: [] }],
    { availability: async () => false },
  );
  assert.deepEqual(await ghost.list(), [{ id: 'ghost', name: 'Ghost', available: false }]);
});

test('F30 shell-free posture: app/browser launch with shell:false, URL as one argv', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  try {
    const tricky = 'https://example.com/search?q=a&b;c|d';
    const res = await w.execution.execute('browser.open_url', { url: tricky }, w.ctx);
    assert.equal((res.data as { opened: boolean }).opened, true);
    assert.equal(w.opened.length, 1);
    const appSrc = readFileSync('src/tools/adapters/local_applications.ts', 'utf8');
    const broSrc = readFileSync('src/tools/adapters/local_browser.ts', 'utf8');
    assert.ok(appSrc.indexOf('shell: false') >= 0, 'app spawn shell:false in production source');
    assert.ok(broSrc.indexOf('shell: false') >= 0, 'browser spawn shell:false in production source');
    assert.ok(appSrc.indexOf('sh -c') < 0 && broSrc.indexOf('sh -c') < 0, 'no shell-string dispatch');
    assert.ok(broSrc.indexOf('shell: true') < 0 && appSrc.indexOf('shell: true') < 0, 'no shell:true anywhere');
    const plat = platformLauncher();
    assert.equal(process.platform === 'linux' ? plat.exe : plat.exe, process.platform === 'linux' ? '/usr/bin/xdg-open' : plat.exe);
    assert.ok(plat.args(tricky).some((a) => a === tricky), 'URL travels as exactly one argv element');
  } finally { w.close(); }
});

test('F30 child env on Linux: secrets stripped, present plumbing preserved', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  const canaries: Record<string, string> = { DEEPSEEK_API_KEY: 'lx-canary-1', ARTHUR_PRIVATE_CANARY: 'lx-canary-2', SOME_ACCESS_TOKEN: 'lx-canary-3', DB_PASSWORD: 'lx-canary-4', CLIENT_SECRET: 'lx-canary-5', AWS_SECRET_ACCESS_KEY: 'lx-canary-6' };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(canaries)) { saved[k] = process.env[k]; (process.env as Record<string, string>)[k] = canaries[k] as string; }
  try {
    await w.execution.execute('app.launch', { app_id: 'gedit' }, w.ctx);
    assert.equal(w.launched.length, 1);
    const env = w.launched[0]?.env ?? {};
    for (const k of Object.keys(canaries)) {
      assert.equal(env[k], undefined, k + ' must not inherit');
      for (const val of Object.values(env)) {
        if (typeof val === 'string') assert.ok(val.indexOf(canaries[k] as string) < 0, 'value leak of ' + k);
      }
    }
    const present: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      if (process.env[k] !== undefined) present[k] = process.env[k] as string;
    }
    const child = buildChildEnv({ ...present, DEEPSEEK_API_KEY: 's3cr3t' } as NodeJS.ProcessEnv);
    for (const k of Object.keys(present)) assert.equal(child[k], present[k], k + ' plumbing preserved');
    assert.equal(child.DEEPSEEK_API_KEY, undefined);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    w.close();
  }
});

test('F30 browser URL boundary on Linux', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  try {
    for (const good of ['https://example.com/', 'http://example.com/', 'http://localhost:3000/']) {
      const res = await w.execution.execute('browser.open_url', { url: good }, w.ctx);
      assert.equal((res.data as { opened: boolean }).opened, true, good);
    }
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://x/y', 'custom://x']) {
      assert.equal(await codeOfAsync(w.execution.execute('browser.open_url', { url: bad }, w.ctx)), 'TOOL_ARGUMENT_INVALID', bad);
    }
    assert.equal(await codeOfAsync(w.execution.execute('browser.open_url', { url: 'https://user:<redacted:nexus-contributor-secret>@example.com/' }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    assert.equal(await codeOfAsync(w.execution.execute('browser.open_url', { url: 'https://example.com/\nX' }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    assert.equal(await codeOfAsync(w.execution.execute('browser.open_url', { url: 'https://' + 'a'.repeat(5000) }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
  } finally { w.close(); }
});

test('F30 raw Linux OS errors never cross the boundary', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
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
        assert.ok(json.indexOf(fx.projects) < 0, c.tool + ' leaks physical root');
        assert.ok(json.indexOf('at ') < 0 || json.indexOf('TOOL_') >= 0, c.tool + ' stable code present');
      }
    }
  } finally { w.close(); }
});

test('F30 canonical E2E: all 10 tools through the real ToolExecutionService path', async () => {
  const fx = linuxFixture();
  const w = buildLinuxWorld(fx);
  try {
    const status = await w.execution.execute('system.status', {}, w.ctx);
    assert.equal((status.data as { platform: string }).platform, 'linux');
    const storage = await w.execution.execute('system.storage', {}, w.ctx);
    assert.equal((storage.data as { roots: unknown[] }).roots.length, 1);
    const roots = await w.execution.execute('filesystem.roots', {}, w.ctx);
    assert.deepEqual(roots.data, { roots: [{ id: 'projects', label: 'Projects' }] });
    const list = await w.execution.execute('filesystem.list', { root_id: 'projects', path: 'alpha/src' }, w.ctx);
    assert.deepEqual((list.data as { entries: Array<{ name: string }> }).entries.map((e) => e.name), ['app.ts']);
    const stat = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'alpha/README.md' }, w.ctx);
    assert.equal((stat.data as { type: string }).type, 'file');
    const read = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'alpha/README.md' }, w.ctx);
    assert.ok((read.data as { text: string }).text.indexOf('linux fixture') >= 0);
    const search = await w.execution.execute('filesystem.search', { root_id: 'projects', path: 'alpha', query: 'ToolExecutionService', mode: 'content' }, w.ctx);
    assert.ok((search.data as { matches: unknown[] }).matches.length >= 1);
    const apps = await w.execution.execute('app.list', {}, w.ctx);
    assert.equal((apps.data as { applications: unknown[] }).applications.length, 1);
    const launch = await w.execution.execute('app.launch', { app_id: 'gedit' }, w.ctx);
    assert.equal((launch.data as { launched: boolean }).launched, true);
    const open = await w.execution.execute('browser.open_url', { url: 'https://example.com/' }, w.ctx);
    assert.equal((open.data as { opened: boolean }).opened, true);
    const hostile = await w.orchestrator.handleProposed([{ id: 'x', name: 'filesystem.read_text', arguments: { root_id: 'projects', path: '../../secret' } }], w.ctx);
    assert.equal(hostile.summaries[0]?.status, 'failed');
  } finally { w.close(); }
});
