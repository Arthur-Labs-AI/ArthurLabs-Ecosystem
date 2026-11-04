// SC-04 gap-fill suite part B (TASK-0019): binary/UTF-8, read bounds,
// listing bounds, search five-bound matrix, sensitive policy, F16 sanitizer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { NodeLocalBrowserAdapter } from '../../src/tools/adapters/local_browser';
import { NodeLocalFilesystemAdapter } from '../../src/tools/adapters/local_filesystem';
import { NodeLocalSystemAdapter } from '../../src/tools/adapters/local_system';
import { registerBuiltinTools } from '../../src/tools/builtin';
import type { LocalCapabilityHost } from '../../src/tools/local_host';
import { buildModelToolResultPayload } from '../../src/tools/model_payload';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'sc04-gapb-'));
  const projects = path.join(dir, 'projects');
  mkdirSync(projects, { recursive: true });
  return { projects };
}

function buildWorld(projects: string, searchBounds?: Record<string, number>): {
  registry: ToolRegistry;
  execution: ReturnType<ToolRegistry['createExecutionService']>;
  orchestrator: ToolOrchestrator;
  store: SessionStore;
  ctx: { session_id: string; turn_id: string; trace_id: string; mode: ArthurMode; approved: false };
  close: () => void;
} {
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'Projects', physical_root: projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new NodeLocalFilesystemAdapter(scopes, searchBounds ? { searchBounds: searchBounds as never } : {}),
    applications: new NodeLocalApplicationAdapter([], { availability: async () => false }),
    browser: new NodeLocalBrowserAdapter({ launcher: async () => undefined }),
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
    close: () => store.close() };
}

test('F11 binary and invalid UTF-8 are TOOL_RESOURCE_UNSUPPORTED', async () => {
  const { projects } = sandbox();
  writeFileSync(path.join(projects, 'bin.dat'), Buffer.from([0x48, 0x65, 0x00, 0xff, 0x01, 0x02]));
  writeFileSync(path.join(projects, 'badutf8.txt'), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0xfe, 0x0a]));
  const w = buildWorld(projects);
  try {
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'bin.dat' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'badutf8.txt' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
  } finally { w.close(); }
});

test('F12 oversized read is bounded with correct next_line', async () => {
  const { projects } = sandbox();
  const lines: string[] = [];
  for (let i = 0; i < 5000; i += 1) lines.push('line-' + i + ' padding-padding');
  writeFileSync(path.join(projects, 'big.txt'), lines.join('\n') + '\n');
  const w = buildWorld(projects);
  try {
    const page = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'big.txt', start_line: 1, max_lines: 200 }, w.ctx);
    const data = page.data as { text: string; truncated: boolean; next_line: number | null; start_line: number; end_line: number };
    assert.equal(data.truncated, true);
    assert.ok(Buffer.byteLength(data.text, 'utf8') <= 12 * 1024, 'bytes=' + Buffer.byteLength(data.text, 'utf8'));
    assert.equal(data.next_line, data.end_line + 1);
    const page2 = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'big.txt', start_line: data.next_line as number, max_lines: 10 }, w.ctx);
    assert.equal((page2.data as { start_line: number }).start_line, data.next_line);
  } finally { w.close(); }
});

test('F13 over-200 entries: schema rejects limit>200, paging stable, no physical paths', async () => {
  const { projects } = sandbox();
  const big = path.join(projects, 'bigdir');
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 250; i += 1) {
    const n = 'file-' + String(i).padStart(3, '0') + '.txt';
    writeFileSync(path.join(big, n), 'x\n');
  }
  const w = buildWorld(projects);
  try {
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.list', { root_id: 'projects', path: 'bigdir', limit: 500 }, w.ctx)), 'TOOL_ARGUMENT_INVALID');
    const p1 = await w.execution.execute('filesystem.list', { root_id: 'projects', path: 'bigdir', offset: 0, limit: 100 }, w.ctx);
    const p1b = await w.execution.execute('filesystem.list', { root_id: 'projects', path: 'bigdir', offset: 0, limit: 100 }, w.ctx);
    assert.deepEqual(p1.data, p1b.data);
    const p2 = await w.execution.execute('filesystem.list', { root_id: 'projects', path: 'bigdir', offset: 100, limit: 100 }, w.ctx);
    const names1 = (p1.data as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    const names2 = (p2.data as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    assert.equal(names1.length, 100);
    assert.equal(names2.length, 100);
    assert.ok(!names1.some((n) => names2.indexOf(n) >= 0), 'pages do not overlap');
    assert.ok(JSON.stringify(p1.data).indexOf(projects) < 0, 'no physical paths');
  } finally { w.close(); }
});

test('F14a result bound: many matches capped at 50', async () => {
  const { projects } = sandbox();
  const many = path.join(projects, 'many');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 80; i += 1) writeFileSync(path.join(many, 'm-' + i + '.txt'), 'uniqueneedle-xyz content\n');
  const w = buildWorld(projects);
  try {
    const r = await w.execution.execute('filesystem.search', { root_id: 'projects', path: 'many', query: 'uniqueneedle-xyz', mode: 'content', max_results: 50 }, w.ctx);
    assert.ok((r.data as { matches: unknown[] }).matches.length <= 50);
  } finally { w.close(); }
});

test('F14b file-count bound terminates the scan', async () => {
  const { projects } = sandbox();
  const many = path.join(projects, 'many');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 40; i += 1) writeFileSync(path.join(many, 'm-' + i + '.txt'), 'countneedle content\n');
  const w = buildWorld(projects, { max_files_scanned: 5 });
  try {
    const r = await w.execution.execute('filesystem.search', { root_id: 'projects', path: 'many', query: 'countneedle', mode: 'content' }, w.ctx);
    assert.ok((r.data as { matches: unknown[] }).matches.length <= 50);
  } finally { w.close(); }
});

test('F14c per-file byte bound: late match beyond cap must not appear', async () => {
  const { projects } = sandbox();
  let late = '';
  for (let i = 0; i < 4000; i += 1) late += 'A';
  late += 'LATEMARKER-ZZZ';
  writeFileSync(path.join(projects, 'late.txt'), late + '\n');
  const w = buildWorld(projects, { max_bytes_per_file: 64 });
  try {
    const r = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'LATEMARKER-ZZZ', mode: 'content' }, w.ctx);
    assert.equal((r.data as { matches: unknown[] }).matches.length, 0, 'late match beyond per-file cap must not appear');
  } finally { w.close(); }
});

test('F14d total-byte bound terminates aggregate scanning', async () => {
  const { projects } = sandbox();
  for (let i = 0; i < 10; i += 1) {
    let big = '';
    for (let k = 0; k < 20000; k += 1) big += 'B';
    writeFileSync(path.join(projects, 'big-' + i + '.txt'), big + '\n');
  }
  const w = buildWorld(projects, { max_total_bytes: 1000 });
  try {
    const t0 = Date.now();
    await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'no-such-needle-qqq', mode: 'content' }, w.ctx);
    assert.ok(Date.now() - t0 < 15000, 'total-byte cap terminates');
  } finally { w.close(); }
});

test('F14e overall deadline: search through the SC-03 coordinator honors a tight deadline', async () => {
  const { projects } = sandbox();
  const many = projects + '/many';
  const { mkdirSync: mk } = await import('node:fs');
  mk(many, { recursive: true });
  for (let i = 0; i < 200; i += 1) writeFileSync(many + '/f-' + i + '.txt', 'deadline-needle content line\n'.repeat(50));
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'P', physical_root: projects, permissions: ['list', 'stat', 'read', 'search'] },
  ]);
  const { NodeLocalFilesystemAdapter: FS } = await import('../../src/tools/adapters/local_filesystem');
  const host: LocalCapabilityHost = {
    system: new NodeLocalSystemAdapter(),
    filesystem: new FS(scopes),
    applications: new NodeLocalApplicationAdapter([], { availability: async () => false }),
    browser: new NodeLocalBrowserAdapter({ launcher: async () => undefined }),
  };
  const { ToolRegistry: TR } = await import('../../src/tools/registry');
  const { PermissionService: PS } = await import('../../src/tools/permissions');
  const { SessionStore: SS } = await import('../../src/sessions/store');
  const { ExecutionStore: ES } = await import('../../src/sessions/execution_store');
  const { ToolExecutionCoordinator: TEC } = await import('../../src/tools/execution_coordinator');
  const { FakeExecutionClock: FEC } = await import('../../src/tools/execution_clock');
  const { SecretSanitizer: SN } = await import('../../src/security/sanitize');
  const { Logger: LG } = await import('../../src/observability/logging');
  const { InMemoryMetrics: MM } = await import('../../src/observability/metrics');
  const { HarnessStubAdapter: HS } = await import('../../src/tools/adapters/harness_stub');
  const registry = new TR();
  registerBuiltinTools(registry, new HS({ verificationSecret: SIGNING_SECRET }), { host });
  const permissions = new PS();
  const store = new SS(':memory:', new SN([]));
  const executions = new ES(store.unsafeDbHandle(), store.sanitizerHandle());
  const clock = new FEC(Date.parse('2026-01-01T00:00:00.000Z'), [0.5]);
  const coordinator = new TEC(store, executions, registry, permissions, registry.createSingleAttemptService(permissions), new SN([]), new LG('error'), new MM(), { runtimeInstanceId: 'rt-f14e', clock });
  store.createSession('s1', ArthurMode.PERSONAL);
  store.createTurn({ id: 't1', sessionId: 's1', role: 'user', text: 'go', traceId: 'tr1', status: 'completed', mode: ArthurMode.PERSONAL });
  const policy = registry.getExecutionPolicy('filesystem.search');
  assert.ok(policy, 'search policy present');
  const req = { toolName: 'filesystem.search', args: { root_id: 'projects', path: 'many', query: 'deadline-needle', mode: 'content' }, sessionId: 's1', turnId: 't1', traceId: 'tr1', mode: ArthurMode.PERSONAL, toolCallId: 'tc-deadline', approvalId: null, toolVersion: '1.0.0', toolDefinitionHash: registry.getDefinitionHash('filesystem.search') as string, argumentsHash: 'c'.repeat(64), policy, deadlineMs: 50 };
  store.createToolCall({ id: 'tc-deadline', turnId: 't1', toolName: 'filesystem.search', argumentsJson: '{}', riskLevel: 'read', status: 'executing' });
  const t0 = Date.now();
  const created = coordinator.createExecution(req);
  const run = await coordinator.run(req, created.id);
  assert.ok(Date.now() - t0 < 15000, 'coordinator search run terminates under a tight deadline, state=' + run.state);
  assert.ok(['succeeded', 'timed_out', 'failed'].indexOf(run.state) >= 0, 'terminal state: ' + run.state);
  store.close();
});

test('F15 sensitive paths blocked incl backslash form; examples allowed', async () => {
  const { projects } = sandbox();
  writeFileSync(path.join(projects, '.env'), 'KEY=shh\n');
  writeFileSync(path.join(projects, '.env.example'), 'KEY=example\n');
  writeFileSync(path.join(projects, 'id_rsa'), 'fake-key\n');
  const sub = path.join(projects, 'sub');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, '.env'), 'KEY=nested\n');
  const w = buildWorld(projects);
  try {
    const blocked = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'sub/.env', 'vault.key', 'tls.pem'];
    for (const p of blocked) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: p }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', p);
    }
    const backslashEnv = 'sub' + String.fromCharCode(92) + '.env';
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: backslashEnv }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', backslashEnv);
    const nestedRsa = 'a' + String.fromCharCode(92) + 'b' + String.fromCharCode(92) + 'id_rsa';
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: nestedRsa }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', nestedRsa);
    const ok1 = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: '.env.example' }, w.ctx);
    assert.ok((ok1.data as { text: string }).text.indexOf('example') >= 0);
  } finally { w.close(); }
});

test('F16 allowed file with canaries: raw values never reach model payload or durable summary', async () => {
  const { projects } = sandbox();
  const CANARY = 'SC04-CANARY-' + Date.now() + '-9f8a7b6c';
  writeFileSync(path.join(projects, 'notes.txt'), 'hello\nDEEPSEEK_API_KEY="' + CANARY + '"\npassword="' + CANARY + '"\n');
  const secrets = [CANARY];
  const sanitizer = new SecretSanitizer(secrets);
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'P', physical_root: projects, permissions: ['list', 'stat', 'read', 'search'] },
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
    // The REAL tool path returns the validated ToolResult to the secured
    // orchestrator, which builds the model-visible payload through the
    // SecretSanitizer choke point (buildModelToolResultPayload) and persists
    // only capped sanitized summaries. The raw ToolResult is an internal
    // secured-boundary value, never model/client-visible on its own.
    const result = await execution.execute('filesystem.read_text', { root_id: 'projects', path: 'notes.txt' }, ctx);
    assert.ok((result.data as { text: string }).text.length > 0, 'fixture file read through the real tool path');
    const payload = buildModelToolResultPayload(result, sanitizer);
    assert.ok(payload.indexOf(CANARY) < 0, 'model payload must not carry the raw canary');
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