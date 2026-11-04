import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeInstanceLease, SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { HarnessEventSchema, type HarnessEvent, type HarnessRunRequest } from '@qa/schemas';
import { HarnessAdapterRegistry, HarnessProtocolError } from '@qa/harness-protocol';
import {
  createEvidenceId,
  createFindingId,
  createHarnessEventId,
  createOperationId,
  nowIsoTimestamp,
} from '@qa/shared';
import { createFakeHarnessRegistry, RunCoordinator } from '../src/index.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  options: {
    output?: boolean;
    beforeStarted?: boolean;
    completed?: boolean;
    terminal?: boolean;
    protocolError?: boolean;
    shutdownWarning?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'sentry-cancel-stream-'));
  const dataRoot = join(root, 'data');
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'README.md'), '# Cancellation fixture\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const project = await projects.addProject(source);
  const blocked = deferred<HarnessRunRequest>();
  const endStream = deferred();
  const cancelEntered = deferred();
  const finishCancel = deferred();
  const disposeEntered = deferred();
  const finishDispose = deferred();
  const registration = createFakeHarnessRegistry('success').resolve('stack_deepseek_main')!;
  const adapter = {
    getMetadata: async () => ({
      adapterId: 'controlled-cancellation',
      adapterVersion: '1',
      protocolVersion: 1,
      displayName: 'Controlled cancellation fixture',
      capabilities: {},
    }),
    healthCheck: async () => ({
      status: 'healthy' as const,
      checks: [],
      checkedAt: nowIsoTimestamp(),
    }),
    run: vi.fn(async function* (request: HarnessRunRequest) {
      const event = (body: Record<string, unknown>): HarnessEvent =>
        HarnessEventSchema.parse({
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId: request.agentRunId,
          timestamp: nowIsoTimestamp(),
          ...body,
        });
      if (!options.beforeStarted) yield event({ type: 'run.started' });
      if (options.output) {
        const operationId = createOperationId();
        const evidenceId = createEvidenceId();
        yield event({ type: 'tool.started', operationId, tool: { name: 'test' } });
        yield event({ type: 'tool.completed', operationId, tool: { name: 'test', exitCode: 0 } });
        yield event({
          type: 'evidence.submitted',
          evidence: {
            schemaVersion: 1,
            id: evidenceId,
            qaRunId: request.qaRunId,
            agentRunId: request.agentRunId,
            strength: 'reproduced_behavior',
            environmentState: 'baseline',
            type: 'test',
            test: { framework: 'vitest', name: 'accepted before cancellation', status: 'passed' },
            artifactIds: [],
            groundingOperationIds: [operationId],
            createdAt: nowIsoTimestamp(),
          },
        });
        yield event({
          type: 'finding.submitted',
          finding: {
            schemaVersion: 1,
            id: createFindingId(),
            qaRunId: request.qaRunId,
            agentRunId: request.agentRunId,
            sourceAgentStackId: request.agentStackId,
            title: 'Accepted finding',
            category: 'logic',
            severity: 'medium',
            confidence: 'strong',
            description: 'Deterministic accepted output.',
            locations: [{ relativePath: 'README.md' }],
            evidenceIds: [evidenceId],
            reproductionSteps: [],
            createdAt: nowIsoTimestamp(),
          },
        });
      }
      if (options.completed) yield event({ type: 'run.completed' });
      // Resumption after each yield proves the coordinator accepted/persisted it.
      blocked.resolve(request);
      await endStream.promise;
      if (options.protocolError) {
        throw new HarnessProtocolError(
          'AGENT_RUN_MISMATCH',
          'Owned adapter detected foreign output',
        );
      }
      if (options.terminal)
        yield event({ type: 'run.cancelled', reason: 'Owned adapter cancelled' });
    }),
    cancel: vi.fn(async () => {
      cancelEntered.resolve();
      await finishCancel.promise;
      endStream.resolve();
    }),
    dispose: vi.fn(async () => {
      disposeEntered.resolve();
      await finishDispose.promise;
    }),
    getShutdownDiagnostics: () =>
      options.shutdownWarning
        ? [
            {
              severity: 'error' as const,
              code: 'FIXTURE_CLEANUP_DIAGNOSTIC',
              message: 'Owned shutdown diagnostic',
            },
          ]
        : [],
  };
  const registry = new HarnessAdapterRegistry();
  registry.register({
    ...registration,
    runtimeIdentity: {
      ...registration.runtimeIdentity,
      adapterId: 'controlled-cancellation',
      adapterVersion: '1',
    },
    createAdapter: () => adapter,
  });
  const owner = new RunCoordinator(dataRoot, repository, lease, registry);
  const running = owner.run(project.project.id, {
    executionKind: 'production',
    runTimeoutMs: 30_000,
  });
  cleanups.push(async () => {
    finishCancel.resolve();
    endStream.resolve();
    finishDispose.resolve();
    await running;
    lease.release();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    repository,
    projects,
    project,
    adapter,
    owner,
    running,
    blocked,
    cancelEntered,
    finishCancel,
    disposeEntered,
    finishDispose,
    endStream,
  };
}

it.each([false, true])(
  'reconciles owner-cancelled stream and retains accepted output: %s',
  async (output) => {
    const f = await fixture({ output });
    const request = await f.blocked.promise;
    const findings = f.repository.listFindings(request.qaRunId);
    const evidence = f.repository.listEvidence(request.qaRunId);
    expect(findings).toHaveLength(output ? 1 : 0);
    expect(evidence).toHaveLength(output ? 1 : 0);
    f.owner.requestRunCancellation(request.qaRunId);
    f.owner.requestRunCancellation(request.qaRunId);
    await f.cancelEntered.promise;
    expect(f.repository.getRunControlRequest(request.qaRunId)?.acknowledgedAt).toBeDefined();
    expect(f.repository.getRunControlRequest(request.qaRunId)?.completedAt).toBeUndefined();
    expect(f.adapter.dispose).not.toHaveBeenCalled();
    f.finishCancel.resolve();
    await f.disposeEntered.promise;
    expect(f.repository.getRun(request.qaRunId)?.status).toBe('agents_running');
    expect(f.repository.getRunControlRequest(request.qaRunId)?.completedAt).toBeUndefined();
    expect(f.projects.getManagedCopy(f.project.project.id).state).toBe('locked_for_run');
    expect((await stat(request.workspace.runtimePath)).isDirectory()).toBe(true);
    f.finishDispose.resolve();
    const result = await f.running;
    expect(result.run.status).toBe('cancelled');
    expect(result.agentRuns).toHaveLength(1);
    expect(result.agentRuns[0]).toMatchObject({ id: request.agentRunId, status: 'cancelled' });
    expect(result.agentRuns[0]?.failure).toBeUndefined();
    expect(result.activities.filter((activity) => activity.kind === 'agent')).toMatchObject([
      { agentRunId: request.agentRunId, status: 'cancelled', title: 'Agent cancelled' },
    ]);
    expect(result.activities.some((activity) => /protocol|failed/i.test(activity.title))).toBe(
      false,
    );
    expect(
      result.events.filter((event) =>
        ['run.completed', 'run.failed', 'run.cancelled'].includes(event.event.type),
      ),
    ).toEqual([]);
    expect(f.repository.getRunControlRequest(request.qaRunId)?.completedAt).toBeDefined();
    expect(f.adapter.run).toHaveBeenCalledOnce();
    expect(f.adapter.cancel).toHaveBeenCalledOnce();
    expect(f.adapter.dispose).toHaveBeenCalledOnce();
    await expect(stat(request.workspace.runtimePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.projects.getManagedCopy(f.project.project.id).state).toBe('ready');
    expect(result.findings).toEqual(findings);
    expect(result.evidence).toEqual(evidence);
    if (output) {
      expect(findings[0]).toMatchObject({
        agentRunId: request.agentRunId,
        sourceAgentStackId: request.agentStackId,
        evidenceIds: [evidence[0]!.id],
      });
      expect(evidence[0]?.groundingOperationIds).toHaveLength(1);
      expect(
        result.events.some(
          (event) =>
            event.event.type === 'tool.completed' &&
            event.event.operationId === evidence[0]?.groundingOperationIds[0],
        ),
      ).toBe(true);
    }
  },
);

it('allows owner cancellation before the stream emits run.started without fabricating events', async () => {
  const f = await fixture({ beforeStarted: true });
  const request = await f.blocked.promise;
  f.owner.requestRunCancellation(request.qaRunId);
  await f.cancelEntered.promise;
  f.finishCancel.resolve();
  f.finishDispose.resolve();
  const result = await f.running;
  expect(result.agentRuns[0]?.status).toBe('cancelled');
  expect(result.agentRuns[0]?.failure).toBeUndefined();
  expect(result.events).toEqual([]);
  expect(result.activities.filter((activity) => activity.kind === 'agent')).toEqual([]);
});

it('preserves a durable completed worker when cancellation arrives after its terminal event', async () => {
  const f = await fixture({ completed: true });
  const request = await f.blocked.promise;
  const completed = f.repository.getAgentRun(request.agentRunId);
  expect(completed?.status).toBe('completed');
  f.owner.requestRunCancellation(request.qaRunId);
  await f.cancelEntered.promise;
  f.finishCancel.resolve();
  f.finishDispose.resolve();
  const result = await f.running;
  expect(result.agentRuns[0]).toEqual(completed);
  expect(result.activities.filter((activity) => activity.kind === 'agent')).toMatchObject([
    { status: 'completed' },
  ]);
  expect(result.run.status).toBe('cancelled');
});

it('rejects an uncancelled stream ending without a terminal event', async () => {
  const f = await fixture();
  await f.blocked.promise;
  f.endStream.resolve();
  f.finishDispose.resolve();
  const result = await f.running;
  expect(result.run.status).toBe('failed');
  expect(result.agentRuns[0]).toMatchObject({
    status: 'failed',
    failure: {
      code: 'HARNESS_PROTOCOL_VIOLATION',
      message: 'Harness stream closed without a terminal event',
    },
  });
  expect(result.activities.filter((activity) => activity.kind === 'agent')).toMatchObject([
    { status: 'failed' },
  ]);
  expect(f.adapter.cancel).not.toHaveBeenCalled();
});

it('retains a genuine protocol error raised during cancellation and shutdown diagnostics', async () => {
  const f = await fixture({ protocolError: true, shutdownWarning: true });
  const request = await f.blocked.promise;
  f.owner.requestRunCancellation(request.qaRunId);
  await f.cancelEntered.promise;
  f.finishCancel.resolve();
  f.finishDispose.resolve();
  const result = await f.running;
  expect(result.agentRuns[0]).toMatchObject({
    status: 'failed',
    failure: {
      code: 'HARNESS_PROTOCOL_VIOLATION',
      message: 'Owned adapter detected foreign output',
    },
  });
  expect(result.activities.filter((activity) => activity.kind === 'agent')).toMatchObject([
    { status: 'failed' },
  ]);
  expect(result.activities).toContainEqual(
    expect.objectContaining({
      status: 'failed',
      title: 'Shutdown diagnostic (error): FIXTURE_CLEANUP_DIAGNOSTIC',
    }),
  );
  expect(f.projects.getManagedCopy(f.project.project.id).state).toBe('ready');
});

it('accepts a valid adapter-emitted cancellation terminal without an operator request', async () => {
  const f = await fixture({ terminal: true });
  await f.blocked.promise;
  f.endStream.resolve();
  f.finishDispose.resolve();
  const result = await f.running;
  expect(result.run.status).toBe('cancelled');
  expect(result.agentRuns[0]?.status).toBe('cancelled');
  expect(result.activities.filter((activity) => activity.kind === 'agent')).toMatchObject([
    { status: 'cancelled' },
  ]);
  expect(result.events.at(-1)?.event.type).toBe('run.cancelled');
  expect(f.adapter.cancel).not.toHaveBeenCalled();
});

it('keeps durably cancelled activity consistent while exposing an unrelated protocol error', async () => {
  const f = await fixture({ protocolError: true });
  const request = await f.blocked.promise;
  f.owner.requestRunCancellation(request.qaRunId);
  await f.cancelEntered.promise;
  f.owner.acknowledgeRunCancellation(request.qaRunId);
  expect(f.repository.getAgentRun(request.agentRunId)?.status).toBe('cancelled');
  f.finishCancel.resolve();
  f.finishDispose.resolve();
  const result = await f.running;
  expect(result.agentRuns[0]?.status).toBe('cancelled');
  expect(result.activities.filter((activity) => activity.kind === 'agent')).toMatchObject([
    { status: 'cancelled', title: 'Agent cancelled' },
  ]);
  expect(result.activities).toContainEqual(
    expect.objectContaining({
      kind: 'runtime',
      status: 'failed',
      title: 'Agent error after cancellation: HARNESS_PROTOCOL_VIOLATION',
    }),
  );
});
