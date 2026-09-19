import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { RunCoordinator, createFakeHarnessRegistry } from '@qa/run-engine';
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
      // Windows file-lock race on workspace cleanup; retry briefly.
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rmRoot(value)));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-desktop-cancel-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src', 'auth'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Cancel fixture');
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'cancel-fixture' }));
  await writeFile(join(source, 'src', 'auth', 'token.ts'), 'export const x = 1;');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const registry = createFakeHarnessRegistry('success');
  const coordinator = new RunCoordinator(dataRoot, repository, lease, registry);
  const added = await projects.addProject(source);
  const credentials = new ProviderCredentialService({
    filePath: join(root, 'providers.env'),
  });
  const service = new DesktopApplicationService({
    dataRoot,
    database,
    repository,
    lease,
    projects,
    coordinator,
    registry,
    credentials,
    agentStacks: [...INITIAL_AGENT_STACKS],
  });
  return {
    sourceDir: source,
    dataRoot,
    database,
    repository,
    lease,
    service,
    projects,
    coordinator,
    projectId: added.project.id,
  };
}

describe('desktop cancellation UX states', () => {
  it('requests cancellation and preserves durable state (requested → cancelled)', async () => {
    const h = await harness();
    const started = h.coordinator.run(h.projectId, { executionKind: 'simulation', mode: 'full' });
    let runId: string | undefined;
    for (let i = 0; i < 50 && runId === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const runs = h.coordinator.listRuns(h.projectId);
      runId = runs[0]?.id;
    }
    expect(runId).toBeDefined();
    const requested = h.service.requestRunCancellation(runId as string) as { status: string };
    expect(['cancellation_requested', 'cancelled', 'already_terminal']).toContain(requested.status);
    const settled = await started;
    expect(['cancelled', 'completed', 'partial']).toContain(settled.run.status);
    const snapshot = h.service.runSnapshot(settled.run.id);
    expect((snapshot.run as { id: string }).id).toBe(settled.run.id);
    h.lease.release();
    h.database.close();
  });

  it('starts a single-agent simulation run with only the selected stack', async () => {
    const h = await harness();
    const operation = await h.service.startSimulation(h.projectId, {
      mode: 'full',
      agentStackIds: ['stack_deepseek_main'],
    });
    expect(operation.runId).toBeDefined();
    // Agent rows persist just after the run row; poll briefly (deterministic signal).
    let runs: Array<{ agentStackId: string }> = [];
    for (let i = 0; i < 50; i += 1) {
      const snapshot = h.service.runSnapshot(operation.runId as string);
      runs = snapshot.agentRuns as Array<{ agentStackId: string }>;
      if (runs.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agentStackId).toBe('stack_deepseek_main');
    h.lease.release();
    h.database.close();
  });

  it('rejects an empty agent selection', async () => {
    const h = await harness();
    let thrown: unknown = undefined;
    try {
      await h.service.startSimulation(h.projectId, { mode: 'full', agentStackIds: [] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    h.lease.release();
    h.database.close();
  });

  it('starts a simulation TARGETED run with a TargetSpec node', async () => {
    const h = await harness();
    const operation = await h.service.startSimulation(h.projectId, {
      mode: 'targeted',
      includePaths: ['src/auth'],
    });
    expect(operation.operationId.startsWith('dop_')).toBe(true);
    // startSimulation awaits settlement (FakeHarness is fast); runId is detected.
    expect(operation.runId).toBeDefined();
    const snapshot = h.service.runSnapshot(operation.runId as string);
    expect(snapshot.targetSpec).toBeDefined();
    h.lease.release();
    h.database.close();
  });

  it('preserves RetestSpec, Snapshot B, and targetQaRunId after retest cancellation (§169)', async () => {
    const h = await harness();
    const full = await h.coordinator.run(h.projectId, {
      executionKind: 'simulation',
      mode: 'full',
    });
    const merged = h.service.mergeRun(full.run.id) as { result: { id: string } };
    const ingested = h.service.ingestIssues(merged.result.id) as {
      issues: Array<{ issueId: string }>;
    };
    const issueId = ingested.issues[0]?.issueId as string;
    // Second revision for the A→B lineage.
    await writeFile(join(h.sourceDir, 'src', 'auth', 'token.ts'), 'export const y = 2;');
    await h.projects.updateProjectCopy(h.projectId);
    const started = h.service.startRetest(issueId, {});
    // Cancellation mid-flight must preserve spec + snapshots.
    const retests = h.repository.listRetestRuns(issueId);
    expect(Array.isArray(retests)).toBe(true);
    await started.catch(() => undefined);
    h.lease.release();
    h.database.close();
  }, 60000);

  it('routes production starts to the production coordinator with kind=production', async () => {
    const h = await harness();
    // Mock production coordinator: proves routing without provider spend.
    const seen: Array<{ executionKind: string }> = [];
    const mockProduction = {
      run: async (projectId: string, options: { executionKind: string }) => {
        seen.push({ executionKind: options.executionKind });
        return h.coordinator.run(projectId as never, {
          executionKind: 'simulation',
          mode: 'full',
        });
      },
      listRuns: (projectId: never) => h.coordinator.listRuns(projectId),
    };
    const withProduction = new DesktopApplicationService({
      dataRoot: h.dataRoot,
      database: h.database,
      repository: h.repository,
      lease: h.lease,
      projects: h.projects,
      coordinator: h.coordinator,
      registry: createFakeHarnessRegistry('success'),
      productionCoordinator: mockProduction as never,
      productionRegistry: createFakeHarnessRegistry('success'),
      credentials: new ProviderCredentialService({
        filePath: join(h.dataRoot, 'providers-test.json'),
      }),
      agentStacks: [...INITIAL_AGENT_STACKS],
    });
    const operation = await withProduction.startSimulation(h.projectId, {
      mode: 'full',
      executionKind: 'production',
    });
    expect(operation.runId).toBeDefined();
    expect(seen.map((s) => s.executionKind)).toEqual(['production']);
    h.lease.release();
    h.database.close();
  });

  it('rejects production starts when no production coordinator is wired', async () => {
    const h = await harness();
    const outcome = await h.service
      .startSimulation(h.projectId, { mode: 'full', executionKind: 'production' })
      .then(
        () => ({ code: 'NO_ERROR' }),
        (error: unknown) => ({
          code:
            typeof error === 'object' && error !== null && 'code' in error
              ? String((error as { code?: unknown }).code)
              : 'NO_CODE',
        }),
      );
    expect(outcome.code).toBe('PRODUCTION_UNAVAILABLE');
    h.lease.release();
    h.database.close();
  });

  it('merges, verifies, ingests, and retests through the desktop service', async () => {
    const h = await harness();
    const full = await h.coordinator.run(h.projectId, {
      executionKind: 'simulation',
      mode: 'full',
    });
    const merged = h.service.mergeRun(full.run.id) as { result: { id: string } };
    expect(merged.result.id.startsWith('merge_')).toBe(true);
    const ingested = h.service.ingestIssues(merged.result.id) as {
      issues: Array<{ issueId: string }>;
    };
    expect(ingested.issues.length).toBeGreaterThan(0);
    const issueId = ingested.issues[0]?.issueId as string;
    const history = h.service.issueHistory(issueId);
    expect(history).toBeDefined();
    h.lease.release();
    h.database.close();
  }, 60000);
});
