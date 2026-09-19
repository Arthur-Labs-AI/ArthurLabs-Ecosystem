import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  HarnessEventSchema,
  IssueEventSchema,
  IssueOccurrenceSchema,
  IssueSchema,
  issueIngestKey,
} from '@qa/schemas';
import {
  createHarnessEventId,
  createIssueEventId,
  createIssueId,
  createIssueOccurrenceId,
  nowIsoTimestamp,
} from '@qa/shared';
import { HarnessAdapterRegistry, type HarnessAdapter } from '@qa/harness-protocol';
import { RunCoordinator, createFakeHarnessRegistry, mergeRun } from '@qa/run-engine';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';

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

/** Slow adapter: emits run.started, then blocks until released (proves early return). */
class SlowAdapter implements HarnessAdapter {
  private released = false;
  release(): void {
    this.released = true;
  }
  async getMetadata() {
    return {
      adapterId: 'slow',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'Slow',
      capabilities: {},
    };
  }
  async healthCheck() {
    return { status: 'healthy' as const, checks: [], checkedAt: nowIsoTimestamp() };
  }
  async *run(request: { agentRunId: string }) {
    const emit = (event: unknown) => HarnessEventSchema.parse(event);
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'run.started',
    });
    while (!this.released) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'run.completed',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }
  async cancel() {
    this.released = true;
  }
  async dispose() {}
}

describe('live retest start', () => {
  it('startRetest returns retestRunId before the workflow settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-retest-live-'));
    roots.push(root);
    const source = join(root, 'source');
    const dataRoot = join(root, 'data');
    await mkdir(join(source, 'src', 'auth'), { recursive: true });
    await writeFile(join(source, 'README.md'), '# Fixture\n');
    await writeFile(join(source, 'src', 'auth', 'login.ts'), 'export const login = 1;\n');
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
    lease.start();
    const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
    const added = await projects.addProject(source);
    const seedCoordinator = new RunCoordinator(
      dataRoot,
      repository,
      lease,
      createFakeHarnessRegistry('success'),
    );
    const runA = await seedCoordinator.run(added.project.id, {
      executionKind: 'simulation',
      runTimeoutMs: 60_000,
    });
    const { result: mergeA } = mergeRun(repository, runA.run.id);
    expect(mergeA.clusters.length).toBeGreaterThan(0);
    const clusterA = mergeA.clusters[0];
    if (clusterA === undefined) throw new Error('no cluster');
    const t = nowIsoTimestamp();
    const issueId = createIssueId();
    const occurrenceId = createIssueOccurrenceId();
    const revision = repository.listRevisions(added.project.id)[0];
    if (revision === undefined) throw new Error('revision missing');
    repository.transaction(() => {
      repository.saveIssue(
        IssueSchema.parse({
          schemaVersion: 1,
          id: issueId,
          projectId: added.project.id,
          title: 'Live start fixture',
          category: 'logic',
          severity: 'high',
          createdAt: t,
          updatedAt: t,
        }),
      );
      repository.saveIssueOccurrence(
        IssueOccurrenceSchema.parse({
          schemaVersion: 1,
          id: occurrenceId,
          issueId,
          projectId: added.project.id,
          projectRevisionId: revision.id,
          projectSnapshotId: runA.run.snapshotId,
          qaRunId: runA.run.id,
          mergeResultId: mergeA.id,
          findingClusterId: clusterA.id,
          createdAt: t,
        }),
      );
      repository.saveIngestKey(
        issueIngestKey({ mergeResultId: mergeA.id, findingClusterId: clusterA.id }),
        issueId,
        occurrenceId,
      );
      repository.appendIssueEvent(
        IssueEventSchema.parse({
          schemaVersion: 1,
          id: createIssueEventId(),
          issueId,
          projectId: added.project.id,
          kind: 'created',
          toState: 'open',
          occurrenceId,
          message: 'first occurrence',
          createdAt: t,
        }),
      );
    });
    await writeFile(join(source, 'src', 'auth', 'login.ts'), 'export const login = 2;\n');
    await projects.updateProjectCopy(added.project.id);
    // Slow registry: one stack, adapter blocks until released.
    const slow = new SlowAdapter();
    const slowRegistry = new HarnessAdapterRegistry();
    slowRegistry.register({
      stack: INITIAL_AGENT_STACKS[0] as never,
      runtimeIdentity: { modelId: (INITIAL_AGENT_STACKS[0] as never).model.modelId },
      createAdapter: () => slow as never,
    });
    const coordinator = new RunCoordinator(dataRoot, repository, lease, slowRegistry);
    const service = new DesktopApplicationService({
      dataRoot,
      database,
      repository,
      lease,
      projects,
      coordinator,
      registry: slowRegistry,
      credentials: new ProviderCredentialService({ filePath: join(root, 'providers.json') }),
      agentStacks: [...INITIAL_AGENT_STACKS],
    });
    const started = service.startRetest(issueId, {});
    const operation = await started;
    expect(operation.retestRunId).toBeDefined();
    // RetestRun row exists immediately, before the workflow settles.
    const snapshot = service.retestSnapshot(operation.retestRunId as string);
    expect((snapshot.retestRun as { id: string }).id).toBe(operation.retestRunId);
    // Nested DTO: targetRun.run.id (never flattened).
    if (snapshot.targetRun !== undefined) {
      expect(typeof (snapshot.targetRun as { run: { id: string } }).run.id).toBe('string');
    }
    slow.release();
    await started.catch(() => undefined);
    lease.release();
    database.close();
  }, 120000);
});
