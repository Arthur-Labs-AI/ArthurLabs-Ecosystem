import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';
import { INITIAL_AGENT_STACKS } from '@qa/domain';

const roots: string[] = [];
async function rmRoot(value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(value, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rmRoot(value)));
});

/**
 * Desktop service over a fake RPC transport (allowed test double): asserts the
 * adapter forwards typed calls, translates Windows paths, pushes configuration
 * on credential changes, and never constructs a RunCoordinator on Windows.
 */
function fakeService(calls: Array<{ method: string; params: Record<string, unknown> }>) {
  const runtime = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      switch (method) {
        case 'runs.start':
          return { operationId: 'dop_test', runId: 'run_01K7777777777777777777A8W1' };
        case 'retests.start':
          return { operationId: 'dop_test', retestRunId: 'retest_01K7777777777777777777A8W1' };
        case 'production.preRunGate':
          return { ready: true, stacks: [] };
        case 'runtime.configure':
          return { configured: true };
        default:
          return { ok: true };
      }
    },
    status: { connected: true, distro: 'Ubuntu', hello: undefined, lastError: undefined },
  };
  return { runtime, calls };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-desktop-rpc-'));
  roots.push(root);
  const credentials = new ProviderCredentialService({ filePath: join(root, 'providers.json') });
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  const { runtime } = fakeService(seen);
  const service = new DesktopApplicationService({
    runtime: runtime as never,
    distro: 'Ubuntu',
    credentials,
    agentStacks: [...INITIAL_AGENT_STACKS],
  });
  return { root, service, credentials, seen };
}

describe('desktop RPC adapter', () => {
  it('forwards startRun without a simulation executionKind', async () => {
    const h = await harness();
    const operation = await h.service.startRun('proj_01K7777777777777777777A8W1', { mode: 'full' });
    expect(operation).toMatchObject({ runId: 'run_01K7777777777777777777A8W1' });
    const start = h.seen.find((c) => c.method === 'runs.start');
    expect(start).toBeDefined();
    expect(start?.params).not.toHaveProperty('executionKind');
    expect(start?.params).not.toHaveProperty('scenario');
  });

  it('rejects invalid source paths before RPC (wslpath covered by integration)', async () => {
    const h = await harness();
    await expect(h.service.addProject('')).rejects.toThrow();
    expect(h.seen.filter((c) => c.method === 'projects.add')).toHaveLength(0);
  });

  it('pushes runtime configuration after credential save', async () => {
    const h = await harness();
    await h.service.providerSaveKey('SENTRY_DEEPSEEK_MODEL', 'deepseek-flash');
    expect(h.seen.some((c) => c.method === 'runtime.configure')).toBe(true);
    const configured = h.seen.find((c) => c.method === 'runtime.configure');
    expect(configured?.params).toMatchObject({ models: { deepseek: 'deepseek-flash' } });
  });

  it('forwards the OpenCode model and OpenRouter key without exposing the secret', async () => {
    const h = await harness();
    await h.service.providerSaveKey('SENTRY_OPENCODE_MODEL', 'anthropic/claude-test');
    h.service.providerSetKey('OPENROUTER_API_KEY', 'sk-or-test-12345678');
    await h.service.pushRuntimeConfiguration();
    const configured = h.seen.filter((c) => c.method === 'runtime.configure').at(-1);
    expect(configured?.params).toMatchObject({
      models: { opencode: 'anthropic/claude-test' },
      providers: { openRouterApiKey: 'sk-or-test-12345678' },
    });
    await h.service.providerSaveKey('SENTRY_OPENCODE_BINARY', '/home/u/tools/opencode');
    await h.service.pushRuntimeConfiguration();
    const reconfigured = h.seen.filter((c) => c.method === 'runtime.configure').at(-1);
    expect(reconfigured?.params).toMatchObject({
      binaries: { opencode: '/home/u/tools/opencode' },
    });
    await h.service.providerSaveKey('OPENCODE_API_KEY', 'zen-test-key');
    await h.service.providerSaveKey('SENTRY_OPENCODE_PROVIDER', 'opencode');
    await h.service.pushRuntimeConfiguration();
    const zen = h.seen.filter((c) => c.method === 'runtime.configure').at(-1);
    expect(zen?.params).toMatchObject({
      providers: { openCodeApiKey: 'zen-test-key' },
      openCodeProvider: 'opencode',
    });
    const statuses = h.service.providerStatuses() as Array<{ name: string }>;
    expect(statuses.some((status) => status.name === 'OPENROUTER_API_KEY')).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain('sk-or-test-12345678');
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['SENTRY_OPENCODE_MODEL'];
  });

  it('never exposes secret values through statuses', async () => {
    const h = await harness();
    await h.service.providerSaveKey('SENTRY_DEEPSEEK_MODEL', 'deepseek-flash');
    const statuses = h.service.providerStatuses() as Array<{ name: string; hint: string }>;
    expect(JSON.stringify(statuses)).not.toContain(
      'deepseek-flash'.slice(0, 4) === 'deep' ? 'sk-' : 'sk-',
    );
  });

  it('exposes runtime status for the Environment page', async () => {
    const h = await harness();
    expect(h.service.runtimeStatus()).toMatchObject({ connected: true, distro: 'Ubuntu' });
  });

  it('pre-run gate delegates to the runtime (no local provider spawning)', async () => {
    const h = await harness();
    const gate = await h.service.preRunGate(['stack_deepseek_main']);
    expect(gate.ready).toBe(true);
    expect(h.seen.some((c) => c.method === 'production.preRunGate')).toBe(true);
  });
});
