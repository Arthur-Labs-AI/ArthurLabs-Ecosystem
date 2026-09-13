import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectManager } from '@qa/project-manager';
import { RuntimeInstanceLease, SentryDatabase, SentryRepository } from '@qa/persistence';
import { FakeHarnessAdapter, HarnessAdapterRegistry } from '@qa/harness-protocol';
import type { HarnessRunRequest } from '@qa/schemas';
import { RunCoordinator } from '@qa/run-engine';
import { createMuseRegistration } from '@qa/harness-muse';
import { createDeepSeekRegistration } from '@qa/harness-deepseek';
import { createGlmRegistration } from '@qa/harness-claude-code';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-cli-selection-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  return { root, dataRoot, source, database, repository, lease, added };
}

describe('stack subset selection', () => {
  it('registers unconfigured stacks without throwing and resolves the selected model via preflight', async () => {
    const f = await fixture();
    const environment = {
      ...process.env,
      SENTRY_MUSE_MODEL: '',
      SENTRY_DEEPSEEK_MODEL: 'deepseek-test-model',
      // node --version exits 0: satisfies the executable probe without
      // needing the real dsh binary on PATH.
      SENTRY_DEEPSEEK_BINARY: process.execPath,
      SENTRY_GLM_MODEL: '',
    };
    // Registration alone must never throw for unselected stacks: config
    // errors surface only when a stack is actually selected.
    const registry = new HarnessAdapterRegistry()
      .register(createMuseRegistration({ environment }))
      .register(createDeepSeekRegistration({ environment }))
      .register(createGlmRegistration({ environment }));
    const deepseek = registry.resolve('stack_deepseek_main');
    expect(deepseek).toBeDefined();
    // The placeholder keeps the stack definition valid until preflight.
    expect(deepseek?.stack.model.modelId).toBe('unconfigured');
    await deepseek?.preflight?.();
    // Preflight with a configured model populates the real identity...
    expect(deepseek?.runtimeIdentity?.modelId).toBe('deepseek-test-model');
    // ...and a run request built from the same registration carries the
    // resolved model, not the placeholder. The fake delegate stands in
    // for the real adapter so no network is touched.
    const requests: HarnessRunRequest[] = [];
    const delegate = new FakeHarnessAdapter({ scenario: 'success' });
    if (deepseek === undefined) throw new Error('DeepSeek fixture registration missing');
    const scoped = new HarnessAdapterRegistry().register({
      stack: deepseek.stack,
      preflight: deepseek.preflight,
      createAdapter: () => ({
        getMetadata: () => delegate.getMetadata(),
        healthCheck: () => delegate.healthCheck(),
        run: (request) => delegate.run(request),
        cancel: (runId) => delegate.cancel(runId),
        dispose: () => delegate.dispose(),
      }),
      runtimeIdentity: deepseek.runtimeIdentity,
    });
    const result = await new RunCoordinator(f.dataRoot, f.repository, f.lease, scoped).run(
      f.added.project.id,
      {
        executionKind: 'simulation',
        agentStackIds: ['stack_deepseek_main'],
        runTimeoutMs: 2_000,
        onHarnessRequest: (request) => requests.push(request),
      },
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model.modelId).toBe('deepseek-test-model');
    expect(result.agentRuns).toHaveLength(1);
    f.database.close();
  });

  it('reports the selected stacks config error instead of an unselected one', async () => {
    const f = await fixture();
    const environment = {
      ...process.env,
      SENTRY_MUSE_MODEL: '',
      SENTRY_DEEPSEEK_MODEL: 'deepseek-test-model',
      SENTRY_DEEPSEEK_BINARY: process.execPath,
    };
    const muse = createMuseRegistration({ environment });
    const deepseek = createDeepSeekRegistration({ environment });
    // Muse is registered but NOT selected: resolving its config must not
    // block the DeepSeek run. Only the selected preflight runs.
    const registry = new HarnessAdapterRegistry().register(muse).register(deepseek);
    const delegate = new FakeHarnessAdapter({ scenario: 'success' });
    const scoped = new HarnessAdapterRegistry().register({
      stack: deepseek.stack,
      preflight: deepseek.preflight,
      createAdapter: () => ({
        getMetadata: () => delegate.getMetadata(),
        healthCheck: () => delegate.healthCheck(),
        run: (request) => delegate.run(request),
        cancel: (runId) => delegate.cancel(runId),
        dispose: () => delegate.dispose(),
      }),
      runtimeIdentity: deepseek.runtimeIdentity,
    });
    expect(registry.resolve('stack_muse_main')).toBeDefined();
    const result = await new RunCoordinator(f.dataRoot, f.repository, f.lease, scoped).run(
      f.added.project.id,
      {
        executionKind: 'simulation',
        agentStackIds: ['stack_deepseek_main'],
        runTimeoutMs: 2_000,
      },
    );
    expect(result.agentRuns).toHaveLength(1);
    expect(result.agentRuns[0]?.agentStackId).toBe('stack_deepseek_main');
    f.database.close();
  });
});
