// SC-04 gap-fill suite part A (TASK-0019): Windows lexical matrix,
// reparse containment, symlink-loop search, special objects.
// Deterministic temp fixtures + fake launchers. No real GUI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
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
import { ToolOrchestrator } from '../../src/tools/orchestrator';
import { PermissionService } from '../../src/tools/permissions';
import { ToolRegistry } from '../../src/tools/registry';
import { FilesystemScopeRegistry } from '../../src/tools/scoped_path';

const SIGNING_SECRET = 'sc04-gapfill-secret';

function codeOf(err: unknown): string {
  assert.ok(err instanceof ArthurError, 'expected ArthurError, got ' + String(err));
  return (err as ArthurError).code;
}

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return codeOf(err);
  }
  throw new Error('expected rejection');
}

function sandbox(): { dir: string; projects: string; outside: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc04-gap-'));
  const projects = path.join(dir, 'projects');
  const outside = path.join(dir, 'outside');
  mkdirSync(projects, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'outside secret\n');
  return { dir, projects, outside };
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

function buildWorld(projects: string, searchBounds?: Record<string, number>): World {
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
    filesystem: new NodeLocalFilesystemAdapter(scopes, searchBounds ? { searchBounds: searchBounds as never } : {}),
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
    approvalTtlSeconds: 300,
    approvalSigningSecret: SIGNING_SECRET,
    logger: new Logger('error'),
    metrics: new InMemoryMetrics(),
  });
  store.createSession('s1', ArthurMode.PERSONAL);
  store.createTurn({ id: 't1', sessionId: 's1', role: 'user', text: 'go', traceId: 'tr1', status: 'completed', mode: ArthurMode.PERSONAL });
  return {
    registry, execution, orchestrator, store,
    ctx: { session_id: 's1', turn_id: 't1', trace_id: 'tr1', mode: ArthurMode.PERSONAL, approved: false },
    apps, browser, launched, opened, close: () => store.close(),
  };
}

test('F05/F07 Windows lexical matrix: hostile paths are TOOL_SCOPE_VIOLATION', async () => {
  const { projects } = sandbox();
  writeFileSync(path.join(projects, 'ok.txt'), 'ok\n');
  const w = buildWorld(projects);
  try {
    // NOTE: lexically-inside-but-missing names (e.g. 'mixed/a../../b' which
    // resolves to in-scope 'b', or a plain missing filename) correctly yield
    // TOOL_RESOURCE_NOT_FOUND, not a scope violation: they stay in scope.
    // NUL-bytes and escaping mixes are covered in F05b below.
    const hostile = [
      '../secret', '../../secret', 'a/../../b', '..', '../outside',
      'C:/Windows/system.ini', 'D:/anything', 'C:drive-relative',
      '//server/share/file', '/file', '/etc/passwd',
    ];
    for (const evil of hostile) {
      const c1 = await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: evil }, w.ctx));
      assert.equal(c1, 'TOOL_SCOPE_VIOLATION', evil + ' read_text -> ' + c1);
      const c2 = await codeOfAsync(w.execution.execute('filesystem.list', { root_id: 'projects', path: evil }, w.ctx));
      assert.equal(c2, 'TOOL_SCOPE_VIOLATION', evil + ' list -> ' + c2);
      const c3 = await codeOfAsync(w.execution.execute('filesystem.stat', { root_id: 'projects', path: evil }, w.ctx));
      assert.equal(c3, 'TOOL_SCOPE_VIOLATION', evil + ' stat -> ' + c3);
    }
    // Uppercase single-letter root_id never reaches scope resolution: the tool
    // schema (^[a-z][a-z0-9_]*$) rejects it first. Either rejection keeps the
    // model from choosing a physical root.
    const rc = await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'C', path: 'x' }, w.ctx));
    assert.ok(rc === 'TOOL_ARGUMENT_INVALID' || rc === 'TOOL_SCOPE_VIOLATION', 'physical root_id -> ' + rc);
  } finally { w.close(); }
});

test('F05b backslash/drive/UNC/NUL hostile paths are TOOL_SCOPE_VIOLATION', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const backslash = String.fromCharCode(46, 46, 92, 46, 46, 92, 115, 101, 99, 114, 101, 116);
    const drive = String.fromCharCode(67, 58, 92, 87, 105, 110, 100, 111, 119, 115);
    const unc = String.fromCharCode(92, 92, 115, 101, 114, 118, 101, 114, 92, 115, 104, 97, 114, 101);
    const nul = String.fromCharCode(97, 0, 98);
    const absish = String.fromCharCode(92, 97, 98, 115);
    for (const evil of [backslash, drive, unc, nul, absish]) {
      const c = await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: evil }, w.ctx));
      assert.equal(c, 'TOOL_SCOPE_VIOLATION', JSON.stringify(evil) + ' -> ' + c);
    }
  } finally { w.close(); }
});

test('F08 physical containment: in-scope link outside is rejected, search never follows', async () => {
  const { projects, outside } = sandbox();
  writeFileSync(path.join(outside, 'secret.txt'), 'outside secret\n');
  writeFileSync(path.join(projects, 'inside.txt'), 'inside\n');
  let linkKind: string | null = null;
  try { symlinkSync(outside, path.join(projects, 'evil-junction'), 'junction'); linkKind = 'junction'; }
  catch { try { symlinkSync(outside, path.join(projects, 'evil-junction')); linkKind = 'symlink-dir'; } catch { linkKind = null; } }
  let fileLink = false;
  try { symlinkSync(path.join(outside, 'secret.txt'), path.join(projects, 'evil-file-link')); fileLink = true; } catch { fileLink = false; }
  const w = buildWorld(projects);
  try {
    if (linkKind === null && !fileLink) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: '../outside/secret.txt' }, w.ctx)), 'TOOL_SCOPE_VIOLATION');
      return;
    }
    if (linkKind !== null) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.list', { root_id: 'projects', path: 'evil-junction' }, w.ctx)), 'TOOL_SCOPE_VIOLATION');
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'evil-junction/secret.txt' }, w.ctx)), 'TOOL_SCOPE_VIOLATION');
      const search = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'outside secret', mode: 'content' }, w.ctx);
      const hits = (search.data as { matches: Array<{ relative_path: string }> }).matches;
      assert.ok(hits.every((h) => h.relative_path.indexOf('evil-junction') < 0), 'link traversal must not surface outside data');
    }
    if (fileLink) {
      const c = await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'evil-file-link' }, w.ctx));
      assert.ok(c === 'TOOL_SCOPE_VIOLATION' || c === 'TOOL_RESOURCE_UNSUPPORTED', 'file link -> ' + c);
    }
  } finally { w.close(); }
});

test('F09 recursive search with inside/loop link terminates without traversal', async () => {
  const { projects } = sandbox();
  const inside = path.join(projects, 'inside');
  mkdirSync(inside, { recursive: true });
  writeFileSync(path.join(inside, 'note.txt'), 'hello needle here\n');
  try { symlinkSync(projects, path.join(inside, 'loop'), 'junction'); }
  catch { try { symlinkSync(projects, path.join(inside, 'loop')); } catch { /* unavailable */ } }
  const w = buildWorld(projects);
  try {
    const t0 = Date.now();
    const res = await w.execution.execute('filesystem.search', { root_id: 'projects', path: '.', query: 'needle', mode: 'content' }, w.ctx);
    const dt = Date.now() - t0;
    assert.ok(dt < 15000, 'search terminated in bounded time (' + dt + 'ms)');
    const hits = (res.data as { matches: Array<{ relative_path: string }> }).matches;
    assert.ok(hits.length >= 1, 'inside file still found');
    assert.ok(hits.every((h) => h.relative_path.indexOf('loop') < 0), 'loop link is not traversed');
  } finally { w.close(); }
});

test('F10 read_text accepts only regular files', async () => {
  const { projects, outside } = sandbox();
  const sub = path.join(projects, 'sub');
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(projects, 'ok.txt'), 'plain\n');
  let haveLink = false;
  let haveBroken = false;
  try { symlinkSync(path.join(outside, 'secret.txt'), path.join(projects, 'flink')); haveLink = true; } catch { /* unavailable */ }
  try { symlinkSync(path.join(projects, 'nonexistent-target-xyz'), path.join(projects, 'broken')); haveBroken = true; } catch { /* unavailable */ }
  const w = buildWorld(projects);
  try {
    assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'sub' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED');
    if (haveLink) {
      const c = await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'flink' }, w.ctx));
      assert.ok(c === 'TOOL_RESOURCE_UNSUPPORTED' || c === 'TOOL_SCOPE_VIOLATION', 'symlink -> ' + c);
      const st = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'flink' }, w.ctx);
      assert.equal((st.data as { type: string }).type, 'symlink');
    }
    if (haveBroken) {
      const st = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: 'broken' }, w.ctx);
      assert.equal((st.data as { type: string }).type, 'symlink');
      const c = await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: 'broken' }, w.ctx));
      assert.ok(c === 'TOOL_RESOURCE_UNSUPPORTED' || c === 'TOOL_SCOPE_VIOLATION' || c === 'TOOL_RESOURCE_NOT_FOUND', 'broken -> ' + c);
    }
  } finally { w.close(); }
});
