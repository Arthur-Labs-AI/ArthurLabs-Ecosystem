// SC-05 hardening regression (TASK-0023): direct .git metadata access through
// generic filesystem tools must fail closed with TOOL_RESOURCE_UNSUPPORTED,
// while legitimate lookalike names stay allowed. Git intelligence flows only
// through git.* tools (covered by sc05 suites); this suite pins the
// filesystem side of that boundary.
//
// Policy lives in assertNotSensitive (scoped_path.ts: isGitMetadataPath +
// sensitive-path guard); enforcement fans out to all four filesystem tools
// (list/stat/read_text/search) in local_filesystem.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';

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
import { PermissionService } from '../../src/tools/permissions';
import { ToolRegistry } from '../../src/tools/registry';
import { FilesystemScopeRegistry, isGitMetadataPath } from '../../src/tools/scoped_path';

const SIGNING_SECRET = 'sc05-gitfs-secret';
const BS = String.fromCharCode(92);

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) {
    assert.ok(err instanceof ArthurError);
    return (err as ArthurError).code;
  }
  throw new Error('expected rejection');
}

function sandbox(): { projects: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc05-gitfs-'));
  const projects = path.join(dir, 'projects');
  const gitDir = path.join(projects, '.git', 'refs', 'heads');
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(path.join(projects, 'nested', '.git'), { recursive: true });
  writeFileSync(path.join(projects, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(projects, '.git', 'refs', 'heads', 'main'), 'abc123\n');
  writeFileSync(path.join(projects, '.git', 'config'), '[core]\n');
  writeFileSync(path.join(projects, 'nested', '.git', 'config'), '[core]\n');
  writeFileSync(path.join(projects, '.gitignore'), 'node_modules\n');
  writeFileSync(path.join(projects, '.gitattributes'), '*.txt text\n');
  mkdirSync(path.join(projects, '.github'), { recursive: true });
  writeFileSync(path.join(projects, '.github', 'workflows.txt'), 'ci\n');
  return { projects };
}

function buildWorld(projects: string): {
  execution: ReturnType<ToolRegistry['createExecutionService']>;
  ctx: { session_id: string; turn_id: string; trace_id: string; mode: ArthurMode; approved: false };
  close: () => void;
} {
  const scopes = new FilesystemScopeRegistry([
    { id: 'projects', label: 'Projects', physical_root: projects, permissions: ['list', 'stat', 'read', 'search'] },
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
  const execution = registry.createExecutionService(permissions);
  store.createSession('s1', ArthurMode.PERSONAL);
  store.createTurn({ id: 't1', sessionId: 's1', role: 'user', text: 'go', traceId: 'tr1', status: 'completed', mode: ArthurMode.PERSONAL });
  return {
    execution,
    ctx: { session_id: 's1', turn_id: 't1', trace_id: 'tr1', mode: ArthurMode.PERSONAL, approved: false },
    close: () => store.close(),
  };
}

test('isGitMetadataPath: component semantics, not substring matching', () => {
  for (const blocked of ['.git', '.git/HEAD', '.git/refs/heads/main', 'src/../.git/config', 'foo/.git/index', 'nested/.git/config']) {
    assert.equal(isGitMetadataPath(blocked), true, blocked);
  }
  for (const blocked of ['.git' + BS + 'HEAD', 'nested' + BS + '.git' + BS + 'config', 'a' + BS + 'b/.git/c']) {
    assert.equal(isGitMetadataPath(blocked), true, blocked);
  }
  for (const allowed of ['.gitignore', '.gitattributes', '.github/', '.github/workflows.txt', 'docs/git-notes.md', 'some.git.txt', 'a/.git/../notes.md', '.', 'src/app.ts']) {
    assert.equal(isGitMetadataPath(allowed), false, allowed);
  }
});

test('filesystem.read_text rejects .git metadata access', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    for (const p of ['.git', '.git/HEAD', 'nested/.git/config', 'src/../.git/config', '.git' + BS + 'HEAD', 'nested' + BS + '.git' + BS + 'config']) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.read_text', { root_id: 'projects', path: p }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', 'read_text ' + p);
    }
  } finally { w.close(); }
});

test('filesystem.list rejects .git metadata access', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    for (const p of ['.git', '.git/refs', 'nested/.git', 'src/../.git/config', '.git' + BS + 'refs', 'nested/.git' + BS + 'config']) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.list', { root_id: 'projects', path: p }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', 'list ' + p);
    }
  } finally { w.close(); }
});

test('filesystem.stat rejects .git metadata access', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    for (const p of ['.git', '.git/HEAD', 'nested/.git/config', 'src/../.git/config', '.git' + BS + 'HEAD', 'a' + BS + 'b/.git/c']) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.stat', { root_id: 'projects', path: p }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', 'stat ' + p);
    }
  } finally { w.close(); }
});

test('filesystem.search rejects .git metadata access', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    for (const p of ['.git', '.git/refs', 'nested/.git', 'src/../.git/config', '.git' + BS + 'refs']) {
      assert.equal(await codeOfAsync(w.execution.execute('filesystem.search', { root_id: 'projects', path: p, query: 'ref', mode: 'content' }, w.ctx)), 'TOOL_RESOURCE_UNSUPPORTED', 'search ' + p);
    }
  } finally { w.close(); }
});

test('lookalike names remain allowed through filesystem tools', async () => {
  const { projects } = sandbox();
  const w = buildWorld(projects);
  try {
    const ignore = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: '.gitignore' }, w.ctx);
    assert.ok(((ignore.data as { text: string }).text ?? '').includes('node_modules'));
    const attrs = await w.execution.execute('filesystem.read_text', { root_id: 'projects', path: '.gitattributes' }, w.ctx);
    assert.ok(((attrs.data as { text: string }).text ?? '').length > 0);
    const gh = await w.execution.execute('filesystem.list', { root_id: 'projects', path: '.github' }, w.ctx);
    assert.ok(((gh.data as { entries: unknown[] }).entries ?? []).length > 0);
    const st = await w.execution.execute('filesystem.stat', { root_id: 'projects', path: '.gitignore' }, w.ctx);
    assert.equal((st.data as { type: string }).type, 'file');
  } finally { w.close(); }
});
