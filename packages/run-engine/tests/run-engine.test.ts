import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  FilesystemArtifactStore,
  agentWorkspacePath,
  projectDataPaths,
  resolveInside,
  scanTree,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { AgentRunSchema, QARunSchema, RunActivitySchema } from '@qa/schemas';
import type { HarnessRunRequest } from '@qa/schemas';
import {
  createAgentRunId,
  createHarnessEventId,
  createQARunId,
  createRunActivityId,
  nowIsoTimestamp,
} from '@qa/shared';
import { FakeRunCoordinator, RunExporter } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-run-engine-'));
  roots.push(root);
  const source = join(root, 'source project');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Runtime Fixture\n\nA factual runtime fixture.');
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ devDependencies: { vitest: '2' } }),
  );
  await writeFile(join(source, 'src', 'value.txt'), 'A');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  return { root, source, dataRoot, database, repository, lease, manager, added };
}

function coordinator(f: Awaited<ReturnType<typeof fixture>>): FakeRunCoordinator {
  return new FakeRunCoordinator(f.dataRoot, f.repository, f.lease);
}

describe('fake end-to-end run engine', () => {
  it('persists a successful multi-agent run, exports it, cleans workspaces, and updates revisions', async () => {
    const f = await fixture();
    const originalBefore = await scanTree(f.source);
    const runCoordinator = coordinator(f);
    const requests: HarnessRunRequest[] = [];
    const liveStatuses: string[] = [];
    const result = await runCoordinator.simulate(f.added.project.id, {
      scenario: 'success',
      instructions: 'Feature X behavior is intentional.',
      onHarnessRequest: (request) => requests.push(request),
      onHarnessEventPersisted: (_event, agentRun) => {
        liveStatuses.push(f.repository.getAgentRun(agentRun.id)?.status ?? 'missing');
      },
    });
    expect(result.run.status).toBe('completed');
    expect(result.agentRuns).toHaveLength(3);
    expect(result.agentRuns.every((agent) => agent.status === 'completed')).toBe(true);
    expect(liveStatuses).toContain('planning');
    expect(liveStatuses).toContain('running');
    expect(result.findings).toHaveLength(3);
    expect(result.evidence).toHaveLength(3);
    expect(result.events.length).toBeGreaterThan(20);
    expect(
      result.activities.some(
        (activity) => activity.kind === 'tool' && activity.status === 'completed',
      ),
    ).toBe(true);
    expect(result.exports.map((item) => item.format).sort()).toEqual(['json', 'log']);
    expect(result.run.configuration.instructions?.message).toBe(
      'Feature X behavior is intentional.',
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const serialized = JSON.stringify(request);
      expect(
        requests
          .filter((peer) => peer.agentRunId !== request.agentRunId)
          .every((peer) => !serialized.includes(peer.agentRunId)),
      ).toBe(true);
      expect(serialized).not.toContain('peer');
      expect(request.task.prompt).toContain('Feature X behavior is intentional.');
      expect(request.projectContextSnapshotId).toBe(result.run.projectContextSnapshotId);
    }
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    for (const agent of result.agentRuns) {
      await expect(
        stat(agentWorkspacePath(f.dataRoot, f.added.project.id, result.run.id, agent.id)),
      ).rejects.toThrow();
    }
    const jsonExport = result.exports.find((item) => item.format === 'json');
    expect(jsonExport).toBeDefined();
    if (jsonExport !== undefined) {
      const artifact = f.repository.getArtifact(jsonExport.artifactId);
      expect(artifact).toBeDefined();
      if (artifact !== undefined) {
        const parsed = JSON.parse(
          await readFile(resolveInside(f.dataRoot, artifact.relativeStoragePath), 'utf8'),
        ) as { qaRun: { id: string } };
        expect(parsed.qaRun.id).toBe(result.run.id);
      }
    }
    expect((await scanTree(f.source)).contentHash).toBe(originalBefore.contentHash);

    for (const name of ['listRunEvents', 'listEvidence', 'listActivities'] as const) {
      vi.spyOn(f.repository, name).mockImplementation(() => {
        throw new Error('Run status must not materialize ' + name);
      });
    }
    expect(runCoordinator.getRunStatus(result.run.id)).toMatchObject({
      runId: result.run.id,
      agents: { configured: 3, completed: 3 },
      findings: { total: 3 },
      tokens: { inputTokens: 303, outputTokens: 120, totalTokens: 423 },
    });
    vi.restoreAllMocks();

    const oldRevision = f.added.revision.id;
    await writeFile(join(f.source, 'src', 'value.txt'), 'V2');
    const updated = await f.manager.updateProjectCopy(f.added.project.id);
    expect(updated.revision.id).not.toBe(oldRevision);
    expect(f.repository.getSnapshot(result.run.snapshotId)?.projectRevisionId).toBe(oldRevision);
    expect(f.repository.getRun(result.run.id)?.id).toBe(result.run.id);
    expect(
      await readFile(
        join(projectDataPaths(f.dataRoot, f.added.project.id).workingCopy, 'src', 'value.txt'),
        'utf8',
      ),
    ).toBe('V2');
    expect(updated.context?.projectRevisionId).toBe(updated.revision.id);
    await f.manager.deleteProject(f.added.project.id);
    expect(f.repository.getProject(f.added.project.id)).toBeUndefined();
    expect(await readFile(join(f.source, 'src', 'value.txt'), 'utf8')).toBe('V2');
    if (jsonExport !== undefined) {
      expect(f.repository.getArtifact(jsonExport.artifactId)).toBeUndefined();
    }
    f.database.close();
  });

  it('isolates transport loss, keeps pre-crash output durable, and finalizes the run partial', async () => {
    const f = await fixture();
    const result = await coordinator(f).simulate(f.added.project.id, { scenario: 'partial' });
    expect(result.run.status).toBe('partial');
    expect(result.agentRuns.map((item) => item.status).sort()).toEqual([
      'completed',
      'completed',
      'interrupted',
    ]);
    const interrupted = result.agentRuns.find((item) => item.status === 'interrupted');
    expect(interrupted?.failure?.code).toBe('WORKER_DISCONNECTED');
    expect(result.findings).toHaveLength(3);
    expect(result.evidence).toHaveLength(3);
    expect(result.exports).toHaveLength(2);
    const runId = result.run.id;
    const interruptedId = interrupted?.id;
    f.database.close();

    const reopened = new SentryDatabase({ dataRoot: f.dataRoot });
    const repository = new SentryRepository(reopened);
    expect(repository.getRun(runId)?.status).toBe('partial');
    expect(
      interruptedId === undefined ? [] : repository.listAgentEvents(interruptedId).length,
    ).toBeGreaterThan(1);
    expect(repository.listFindings(runId)).toHaveLength(3);
    reopened.close();
  });

  it('times out one worker without cancelling peers', async () => {
    const f = await fixture();
    const result = await coordinator(f).simulate(f.added.project.id, {
      scenario: 'timeout',
      runTimeoutMs: 25,
    });
    expect(result.run.status).toBe('partial');
    expect(
      result.agentRuns.some(
        (item) => item.status === 'timed_out' && item.failure?.code === 'RUN_TIMEOUT',
      ),
    ).toBe(true);
    expect(result.agentRuns.filter((item) => item.status === 'completed')).toHaveLength(2);
    f.database.close();
  });

  it('marks an all-fail run failed when no worker produced usable output', async () => {
    const f = await fixture();
    const result = await coordinator(f).simulate(f.added.project.id, { scenario: 'all-fail' });
    expect(result.run.status).toBe('failed');
    expect(result.agentRuns.every((item) => item.status === 'failed')).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    f.database.close();
  });

  it('recovers nonterminal persisted state and unlocks the managed copy', async () => {
    const f = await fixture();
    const snapshotRun = await coordinator(f).simulate(f.added.project.id, {
      agentStackIds: ['stack_muse_main'],
    });
    const runId = createQARunId();
    const timestamp = nowIsoTimestamp();
    f.repository.saveRun(
      QARunSchema.parse({
        ...snapshotRun.run,
        id: runId,
        status: 'agents_running',
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: undefined,
        summary: undefined,
      }),
    );
    const agentRunId = createAgentRunId();
    f.repository.saveAgentRun(
      AgentRunSchema.parse({
        schemaVersion: 1,
        id: agentRunId,
        qaRunId: runId,
        agentStackId: 'stack_muse_main',
        taskType: 'qa',
        status: 'running',
        startedAt: timestamp,
      }),
    );
    f.manager.lockProjectForRun(f.added.project.id, runId);
    const rootActivity = RunActivitySchema.parse({
      schemaVersion: 1,
      id: createRunActivityId(),
      qaRunId: runId,
      source: 'sentry',
      kind: 'run',
      status: 'running',
      title: 'Full QA',
      startedAt: timestamp,
      artifactIds: [],
    });
    const activeActivity = RunActivitySchema.parse({
      schemaVersion: 1,
      id: createRunActivityId(),
      qaRunId: runId,
      agentRunId,
      parentActivityId: rootActivity.id,
      source: 'agent',
      kind: 'agent',
      status: 'running',
      title: 'Agent started',
      startedAt: timestamp,
      artifactIds: [],
    });
    const toolActivity = RunActivitySchema.parse({
      schemaVersion: 1,
      id: createRunActivityId(),
      qaRunId: runId,
      agentRunId,
      parentActivityId: activeActivity.id,
      source: 'agent',
      kind: 'tool',
      status: 'running',
      title: 'Tool started: shell',
      startedAt: timestamp,
      artifactIds: [],
    });
    f.repository.saveActivity(rootActivity);
    f.repository.saveActivity(activeActivity);
    f.repository.saveActivity(toolActivity);
    f.lease.release();
    const recoveryLease = new RuntimeInstanceLease(f.repository, { autoHeartbeat: false });
    recoveryLease.start();
    await new FakeRunCoordinator(f.dataRoot, f.repository, recoveryLease).recover();
    expect(f.repository.getAgentRun(agentRunId)).toMatchObject({
      status: 'interrupted',
      failure: { code: 'APP_INTERRUPTED' },
    });
    expect(f.repository.getRun(runId)?.status).toBe('failed');
    for (const activityId of [rootActivity.id, activeActivity.id, toolActivity.id]) {
      expect(f.repository.listActivities(runId)).toContainEqual(
        expect.objectContaining({
          id: activityId,
          status: 'failed',
          completedAt: expect.any(String),
        }),
      );
    }
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    recoveryLease.release();
    f.database.close();
  });

  it('does not recover state owned by a fresh runtime, then recovers it after release', async () => {
    const f = await fixture();
    const completed = await coordinator(f).simulate(f.added.project.id, {
      agentStackIds: ['stack_muse_main'],
    });
    const runId = createQARunId();
    const timestamp = nowIsoTimestamp();
    f.repository.saveRun(
      QARunSchema.parse({
        ...completed.run,
        id: runId,
        runtimeInstanceId: f.lease.instanceId,
        status: 'agents_running',
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: undefined,
        summary: undefined,
      }),
    );
    f.repository.saveAgentRun(
      AgentRunSchema.parse({
        schemaVersion: 1,
        id: createAgentRunId(),
        qaRunId: runId,
        agentStackId: 'stack_muse_main',
        taskType: 'qa',
        status: 'running',
        startedAt: timestamp,
      }),
    );
    f.manager.lockProjectForRun(f.added.project.id, runId);
    const databaseB = new SentryDatabase({ dataRoot: f.dataRoot });
    const repositoryB = new SentryRepository(databaseB);
    expect(repositoryB.getRun(runId)?.status).toBe('agents_running');
    expect(repositoryB.getManagedCopy(f.added.project.id)?.state).toBe('locked_for_run');
    const observer = new RuntimeInstanceLease(repositoryB, { autoHeartbeat: false });
    observer.start();
    const observerCoordinator = new FakeRunCoordinator(f.dataRoot, repositoryB, observer);
    await observerCoordinator.recover();
    expect(f.repository.getRun(runId)?.status).toBe('agents_running');
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('locked_for_run');
    f.lease.release();
    await observerCoordinator.recover();
    expect(f.repository.getRun(runId)?.status).toBe('failed');
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    observer.release();
    databaseB.close();
    f.database.close();
  });

  it('rejects cross-run protocol output while preserving earlier valid events', async () => {
    const f = await fixture();
    const result = await coordinator(f).simulate(f.added.project.id, {
      scenario: 'protocol-error',
      agentStackIds: ['stack_muse_main'],
    });
    expect(result.run.status).toBe('failed');
    expect(result.agentRuns[0]).toMatchObject({
      status: 'failed',
      failure: { code: 'HARNESS_PROTOCOL_VIOLATION', retryable: false },
    });
    expect(result.events.map((stored) => stored.event.type)).toEqual([
      'run.started',
      'agent.status',
    ]);
    expect(result.findings).toHaveLength(0);
    f.lease.release();
    f.database.close();
  });

  it('isolates a protocol failure to one agent while peers complete', async () => {
    const f = await fixture();
    const result = await coordinator(f).simulate(f.added.project.id, {
      scenario: 'protocol-error',
    });
    expect(result.run.status).toBe('partial');
    expect(result.agentRuns.filter((agent) => agent.status === 'completed')).toHaveLength(2);
    expect(
      result.agentRuns.filter(
        (agent) =>
          agent.status === 'failed' && agent.failure?.code === 'HARNESS_PROTOCOL_VIOLATION',
      ),
    ).toHaveLength(1);
    f.lease.release();
    f.database.close();
  });

  it('streams large exports through repository iterators without list materialization', async () => {
    const f = await fixture();
    const result = await coordinator(f).simulate(f.added.project.id, {
      agentStackIds: ['stack_muse_main'],
    });
    const agentRunId = result.agentRuns[0]?.id;
    expect(agentRunId).toBeDefined();
    if (agentRunId === undefined) throw new Error('Fixture agent run missing');
    f.repository.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        f.repository.appendHarnessEventWithinTransaction(result.run.id, {
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId,
          timestamp: nowIsoTimestamp(),
          type: 'warning',
          message: 'streaming-export-record-' + index,
        });
      }
    });
    const oldExports = f.repository.listExports(result.run.id);
    f.database.connection.prepare('DELETE FROM run_exports WHERE qa_run_id=?').run(result.run.id);
    const artifacts = new FilesystemArtifactStore(f.dataRoot, f.repository);
    for (const item of oldExports) {
      const artifact = f.repository.getArtifact(item.artifactId);
      if (artifact !== undefined) await artifacts.delete(artifact);
    }
    for (const name of [
      'listAgentRuns',
      'listPlans',
      'listHypotheses',
      'listActivities',
      'listRunEvents',
      'listFindings',
      'listEvidence',
      'listArtifacts',
    ] as const) {
      vi.spyOn(f.repository, name).mockImplementation(() => {
        throw new Error('Exporter must use iterator API: ' + name);
      });
    }
    const exporter = new RunExporter(f.dataRoot, f.repository);
    const logManifest = await exporter.export(result.run.id, 'log');
    const jsonManifest = await exporter.export(result.run.id, 'json');
    const logArtifact = f.repository.getArtifact(logManifest.artifactId);
    const jsonArtifact = f.repository.getArtifact(jsonManifest.artifactId);
    expect(logArtifact).toBeDefined();
    expect(jsonArtifact).toBeDefined();
    if (logArtifact === undefined || jsonArtifact === undefined) throw new Error('Export missing');
    const log = await readFile(resolveInside(f.dataRoot, logArtifact.relativeStoragePath), 'utf8');
    const json = JSON.parse(
      await readFile(resolveInside(f.dataRoot, jsonArtifact.relativeStoragePath), 'utf8'),
    ) as { harnessEvents: unknown[] };
    expect(log).toContain('streaming-export-record-1999');
    expect(json.harnessEvents).toHaveLength(result.events.length + 2_000);
    f.lease.release();
    f.database.close();
  });
});
