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
import { FakeHarnessAdapter, HarnessAdapterRegistry } from '@qa/harness-protocol';
import {
  createAgentRunId,
  createHarnessEventId,
  createQARunId,
  createRunActivityId,
  nowIsoTimestamp,
} from '@qa/shared';
import {
  createFakeHarnessRegistry,
  RunCoordinator,
  RunExporter,
  type SimulateRunOptions,
} from '../src/index.js';

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

function coordinator(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    simulate: (projectId: typeof f.added.project.id, options: SimulateRunOptions = {}) => {
      const { scenario = 'success', ...runOptions } = options;
      return new RunCoordinator(
        f.dataRoot,
        f.repository,
        f.lease,
        createFakeHarnessRegistry(scenario),
      ).run(projectId, { ...runOptions, executionKind: 'simulation' });
    },
    getRunStatus: (runId: Parameters<RunCoordinator['getRunStatus']>[0]) =>
      new RunCoordinator(f.dataRoot, f.repository).getRunStatus(runId),
  };
}

describe('fake end-to-end run engine', () => {
  it.each([1, 2])('retains attributed output for %i selected agents', async (count) => {
    const f = await fixture();
    try {
      const selected = createFakeHarnessRegistry('success')
        .list()
        .slice(0, count)
        .map((item) => item.stack.id);
      const result = await coordinator(f).simulate(f.added.project.id, { agentStackIds: selected });
      expect(result.run.status).toBe('completed');
      expect(result.agentRuns).toHaveLength(count);
      expect(new Set(result.agentRuns.map((agent) => agent.agentStackId))).toEqual(
        new Set(selected),
      );
      expect(result.agentRuns.every((agent) => agent.status === 'completed')).toBe(true);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.evidence.length).toBeGreaterThan(0);
      for (const finding of result.findings) {
        const owner = result.agentRuns.find((agent) => agent.id === finding.agentRunId);
        expect(owner?.agentStackId).toBe(finding.sourceAgentStackId);
        expect(
          finding.evidenceIds.every((id) =>
            result.evidence.some(
              (evidence) => evidence.id === id && evidence.agentRunId === owner?.id,
            ),
          ),
        ).toBe(true);
      }
    } finally {
      f.lease.release();
      f.database.close();
    }
  });

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
      expect(serialized).not.toContain(f.source);
      expect(request.task.prompt).toContain('Feature X behavior is intentional.');
      expect(request.projectContextSnapshotId).toBe(result.run.projectContextSnapshotId);
      expect(request.task.context).toMatchObject({
        project: { id: f.added.project.id, name: f.added.project.name },
        revision: { id: f.added.revision.id, contentHash: f.added.revision.contentHash },
        snapshot: { id: result.run.snapshotId },
        projectContext: { id: result.run.projectContextSnapshotId },
        runInstructions: { message: 'Feature X behavior is intentional.' },
        qaPolicy: { id: 'qa-standard', version: 1 },
      });
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

  it('routes production through the same coordinator without fake export labels or merger stages', async () => {
    const f = await fixture();
    const result = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      createFakeHarnessRegistry('success'),
    ).run(f.added.project.id, {
      executionKind: 'production',
      agentStackIds: ['stack_deepseek_main'],
      runTimeoutMs: 2_000,
    });
    expect(result.run.executionKind).toBe('production');
    expect(result.agentRuns).toHaveLength(1);
    expect(result.activities.some((activity) => activity.kind === 'merger')).toBe(false);
    expect(result.activities.some((activity) => activity.kind === 'verification')).toBe(false);
    const exported = result.exports.find((item) => item.format === 'json');
    expect(exported).toBeDefined();
    if (exported !== undefined) {
      const artifact = f.repository.getArtifact(exported.artifactId);
      expect(artifact).toBeDefined();
      if (artifact !== undefined) {
        const contents = await readFile(
          resolveInside(f.dataRoot, artifact.relativeStoragePath),
          'utf8',
        );
        expect(contents).toContain('"exportKind":"sentry.agent-run"');
        expect(contents).not.toContain('sentry.fake-run');
      }
    }
    f.database.close();
  });

  it('stops a production adapter before cleanup and contains its workspace writes', async () => {
    const f = await fixture();
    const originalBefore = await scanTree(f.source);
    const managedPath = projectDataPaths(f.dataRoot, f.added.project.id).workingCopy;
    const managedBefore = await scanTree(managedPath);
    const base = createFakeHarnessRegistry('success').resolve('stack_deepseek_main');
    expect(base).toBeDefined();
    if (base === undefined) throw new Error('DeepSeek fixture registration missing');
    const delegate = new FakeHarnessAdapter({ scenario: 'success' });
    let workspacePath: string | undefined;
    const lifecycle: string[] = [];
    const registry = new HarnessAdapterRegistry().register({
      stack: base.stack,
      createAdapter: () => ({
        getMetadata: () => delegate.getMetadata(),
        healthCheck: () => delegate.healthCheck(),
        run: async function* (request) {
          workspacePath = request.workspace.runtimePath;
          await writeFile(join(workspacePath, 'src', 'value.txt'), 'WORKSPACE ONLY');
          lifecycle.push('workspace-write');
          yield* delegate.run(request);
        },
        cancel: (runId) => delegate.cancel(runId),
        dispose: async () => {
          if (workspacePath === undefined) throw new Error('Workspace path was not captured');
          await stat(workspacePath);
          lifecycle.push('disposed-before-cleanup');
          await delegate.dispose();
        },
      }),
    });
    const result = await new RunCoordinator(f.dataRoot, f.repository, f.lease, registry).run(
      f.added.project.id,
      {
        executionKind: 'production',
        agentStackIds: ['stack_deepseek_main'],
        runTimeoutMs: 2_000,
      },
    );
    expect(result.run.status).toBe('completed');
    expect(lifecycle).toEqual(['workspace-write', 'disposed-before-cleanup']);
    expect((await scanTree(f.source)).contentHash).toBe(originalBefore.contentHash);
    expect((await scanTree(managedPath)).contentHash).toBe(managedBefore.contentHash);
    expect(workspacePath).toBeDefined();
    if (workspacePath !== undefined) await expect(stat(workspacePath)).rejects.toThrow();
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

  it('kills on event silence but lets steady output earn more time', async () => {
    const f = await fixture();
    const { HarnessEventSchema } = await import('@qa/schemas');
    const { createHarnessEventId: mkEvt } = await import('@qa/shared');
    const drip = (count: number, gapMs: number) => ({
      stack: {
        id: 'stack_deepseek_main',
        displayName: 'drip',
        enabled: true,
        model: { provider: 'fake', modelId: 'fake-drip' },
        harness: { adapterId: 'fake', expectedProtocolVersion: 1 },
        execution: { supportsLocalExecution: true },
        policy: { id: 'qa-standard', version: 1 },
      },
      runtimeIdentity: { modelId: 'fake-drip', adapterId: 'fake', adapterVersion: '0.1.0' },
      createAdapter: () => ({
        getMetadata: async () => ({
          adapterId: 'fake',
          adapterVersion: '0.1.0',
          protocolVersion: 1,
          displayName: 'drip',
          capabilities: {},
        }),
        healthCheck: async () => ({ status: 'healthy' as const, checks: [], checkedAt: 't' }),
        run: async function* (request: { agentRunId: string; qaRunId: string }) {
          yield HarnessEventSchema.parse({
            schemaVersion: 1,
            eventId: mkEvt(),
            agentRunId: request.agentRunId,
            timestamp: new Date().toISOString(),
            type: 'run.started',
          });
          for (let i = 0; i < count; i += 1) {
            await new Promise((r) => setTimeout(r, gapMs));
            yield HarnessEventSchema.parse({
              schemaVersion: 1,
              eventId: mkEvt(),
              agentRunId: request.agentRunId,
              timestamp: new Date().toISOString(),
              type: 'agent.message',
              message: 'drip ' + i,
            });
          }
          yield HarnessEventSchema.parse({
            schemaVersion: 1,
            eventId: mkEvt(),
            agentRunId: request.agentRunId,
            timestamp: new Date().toISOString(),
            type: 'run.completed',
          });
        },
        cancel: async () => undefined,
        dispose: async () => undefined,
      }),
    });
    const { HarnessAdapterRegistry } = await import('@qa/harness-protocol');
    const silentRegistry = new HarnessAdapterRegistry();
    // Silent worker: no events at all → dies at the silence window.
    silentRegistry.register({
      stack: {
        id: 'stack_deepseek_main',
        displayName: 'silent',
        enabled: true,
        model: { provider: 'fake', modelId: 'fake-silent' },
        harness: { adapterId: 'fake', expectedProtocolVersion: 1 },
        execution: { supportsLocalExecution: true },
        policy: { id: 'qa-standard', version: 1 },
      },
      runtimeIdentity: { modelId: 'fake-silent', adapterId: 'fake', adapterVersion: '0.1.0' },
      createAdapter: () => ({
        getMetadata: async () => ({
          adapterId: 'fake',
          adapterVersion: '0.1.0',
          protocolVersion: 1,
          displayName: 'silent',
          capabilities: {},
        }),
        healthCheck: async () => ({ status: 'healthy' as const, checks: [], checkedAt: 't' }),
        run: async function* () {
          await new Promise(() => undefined);
          yield HarnessEventSchema.parse({
            schemaVersion: 1,
            eventId: mkEvt(),
            agentRunId: 'x',
            timestamp: new Date().toISOString(),
            type: 'run.completed',
          });
        },
        cancel: async () => undefined,
        dispose: async () => undefined,
      }),
    });
    const silentResult = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      silentRegistry,
    ).run(f.added.project.id, {
      executionKind: 'simulation',
      agentStackIds: ['stack_deepseek_main'],
      runTimeoutMs: 120,
    });
    const silentAgent = silentResult.agentRuns[0];
    expect(silentAgent?.status).toBe('timed_out');
    expect(silentAgent?.failure?.message).toContain('no events');
    // Steady worker: 9 events 40ms apart (360ms span) with a 300ms silence
    // window — a flat clock would kill it at 300ms; sliding survives.
    // Narrower windows flaked under Windows load (100ms failed repeatedly;
    // 200ms failed once under full-package concurrency). The property is
    // unchanged — only scheduling headroom grows. Production timeouts are
    // untouched.
    const dripRegistry = new HarnessAdapterRegistry();
    dripRegistry.register(drip(9, 40) as never);
    const dripResult = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      dripRegistry,
    ).run(f.added.project.id, {
      executionKind: 'simulation',
      agentStackIds: ['stack_deepseek_main'],
      runTimeoutMs: 300,
    });
    // The drip stream spans 360ms against a 300ms silence window: sliding
    // lets it finish the stream (no RUN_TIMEOUT); the minimal fake lacks
    // plan/evidence for coordinator completion, which is out of scope here.
    expect(dripResult.agentRuns[0]?.status).toBe('completed');
    expect(dripResult.agentRuns[0]?.failure).toBeUndefined();
    expect(
      dripResult.events.filter(
        (e) => e.event.type === 'agent.message' && String(e.event.message ?? '').startsWith('drip'),
      ),
    ).toHaveLength(9);
    f.database.close();
  });

  it('cleans up workspaces, releases the lock, and keeps partial events after a timeout', async () => {
    const f = await fixture();
    const result = await coordinator(f).simulate(f.added.project.id, {
      scenario: 'timeout',
      agentStackIds: ['stack_deepseek_main'],
      runTimeoutMs: 25,
    });
    const timedOut = result.agentRuns.find((item) => item.status === 'timed_out');
    expect(timedOut).toBeDefined();
    // Workspace cleanup ran for the timed-out worker.
    if (timedOut !== undefined) {
      const workspacePath = agentWorkspacePath(
        f.dataRoot,
        f.added.project.id,
        result.run.id,
        timedOut.id,
      );
      await expect(stat(workspacePath)).rejects.toThrow();
    }
    // Project lock released back to ready.
    expect(f.manager.getManagedCopy(f.added.project.id)?.state).toBe('ready');
    // Partial valid events (plan, tool activity) remain persisted.
    expect(result.events.some((item) => item.event.type === 'investigation.plan.created')).toBe(
      true,
    );
    f.database.close();
  });

  it('never enters a provider stream when cancellation lands during adapter creation', async () => {
    const f = await fixture();
    const delegate = new FakeHarnessAdapter({ scenario: 'success' });
    const stream = vi.spyOn(delegate, 'run');
    const cancel = vi.spyOn(delegate, 'cancel');
    let finishCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    let cancelling!: () => void;
    const cancelEntered = new Promise<void>((resolve) => {
      cancelling = resolve;
    });
    cancel.mockImplementation(async () => {
      cancelling();
      await cancelGate;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const registration = createFakeHarnessRegistry('success').resolve('stack_deepseek_main')!;
    const registry = new HarnessAdapterRegistry();
    registry.register({
      ...registration,
      createAdapter: async () => {
        entered();
        await gate;
        return delegate;
      },
    });
    const owner = new RunCoordinator(f.dataRoot, f.repository, f.lease, registry);
    const running = owner.run(f.added.project.id, { executionKind: 'production' });
    try {
      await creating;
      const row = f.repository.listRuns(f.added.project.id)[0]!;
      owner.requestRunCancellation(row.id);
      owner.requestRunCancellation(row.id);
      expect(f.repository.getRunControlRequest(row.id)?.completedAt).toBeUndefined();
      release();
      await cancelEntered;
      expect(stream).not.toHaveBeenCalled();
      expect(f.repository.getRunControlRequest(row.id)?.acknowledgedAt).toBeDefined();
      expect(f.repository.getRunControlRequest(row.id)?.completedAt).toBeUndefined();
      expect(f.repository.getRun(row.id)?.status).toBe('agents_running');
      finishCancel();
      const result = await running;
      expect(stream).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(result.run.status).toBe('cancelled');
      expect(result.agentRuns.map((agent) => agent.status)).toEqual(['cancelled']);
      expect(f.repository.getRunControlRequest(row.id)?.completedAt).toBeDefined();
      expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    } finally {
      release();
      finishCancel();
      await running;
      f.lease.release();
      f.database.close();
      vi.restoreAllMocks();
    }
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
      agentStackIds: ['stack_deepseek_main'],
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
        agentStackId: 'stack_deepseek_main',
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
    await new RunCoordinator(f.dataRoot, f.repository, recoveryLease).recover();
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
      agentStackIds: ['stack_deepseek_main'],
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
        agentStackId: 'stack_deepseek_main',
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
    const observerCoordinator = new RunCoordinator(f.dataRoot, repositoryB, observer);
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
      agentStackIds: ['stack_deepseek_main'],
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
      agentStackIds: ['stack_deepseek_main'],
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

describe('revision-targeted runs', () => {
  it('runs against an older revision snapshot without moving the working copy', async () => {
    const f = await fixture();
    try {
      const firstRevision = f.added.revision.id;
      await writeFile(join(f.source, 'src', 'value.txt'), 'B');
      const updated = await f.manager.updateProjectCopy(f.added.project.id);
      expect(updated.revision.id).not.toBe(firstRevision);
      const result = await coordinator(f).simulate(f.added.project.id, {
        revisionId: firstRevision,
      });
      expect(result.run.status).toBe('completed');
      expect(f.repository.getSnapshot(result.run.snapshotId)?.projectRevisionId).toBe(
        firstRevision,
      );
      // The working copy still tracks the current revision; the old tree
      // reached the agents only through the frozen snapshot.
      expect(f.manager.getProject(f.added.project.id)?.revision.id).toBe(updated.revision.id);
      expect(
        await readFile(
          join(projectDataPaths(f.dataRoot, f.added.project.id).workingCopy, 'src', 'value.txt'),
          'utf8',
        ),
      ).toBe('B');
    } finally {
      f.lease.release();
      f.database.close();
    }
  });

  it('rejects malformed, foreign, and unknown revisions', async () => {
    const f = await fixture();
    try {
      const c = coordinator(f);
      await expect(c.simulate(f.added.project.id, { revisionId: 'nope' })).rejects.toMatchObject({
        code: 'INVALID_TARGET',
      });
      await expect(
        c.simulate(f.added.project.id, { revisionId: 'rev_11111111111111111111111111' }),
      ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
      const otherSource = join(f.root, 'other');
      await mkdir(join(otherSource, 'src'), { recursive: true });
      await writeFile(join(otherSource, 'src', 'value.txt'), 'other');
      const other = await f.manager.addProject(otherSource);
      await expect(
        c.simulate(f.added.project.id, { revisionId: other.revision.id }),
      ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    } finally {
      f.lease.release();
      f.database.close();
    }
  });
});
