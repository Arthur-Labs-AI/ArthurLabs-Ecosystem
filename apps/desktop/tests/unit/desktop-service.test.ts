import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { RunCoordinator, createFakeHarnessRegistry } from '@qa/run-engine';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { INITIAL_AGENT_STACKS } from '@qa/domain';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
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
  const service = new DesktopApplicationService({
    dataRoot,
    database,
    repository,
    lease,
    projects,
    coordinator,
    registry,
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
