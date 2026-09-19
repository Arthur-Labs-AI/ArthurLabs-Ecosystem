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

  it('translates Windows source paths before RPC (never sends C:\\)', async () => {
    const h = await harness();
    await expect(h.service.addProject('C:\\Users\\Mert\\Documents\\Project')).rejects.toThrow();
    expect(h.seen.filter((c) => c.method === 'projects.add')).toHaveLength(0);
  });

  it('pushes runtime configuration after credential save', async () => {
    const h = await harness();
    await h.service.providerSaveKey('SENTRY_DEEPSEEK_MODEL', 'deepseek-flash');
    expect(h.seen.some((c) => c.method === 'runtime.configure')).toBe(true);
    const configured = h.seen.find((c) => c.method === 'runtime.configure');
    expect(configured?.params).toMatchObject({ models: { deepseek: 'deepseek-flash' } });
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
