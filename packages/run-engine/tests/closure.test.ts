/** Finish-pass closure regressions: strict owner identity, request-only
 *  foreign cancellation, owner-driven settlement (no manual ack), lock and
 *  workspace ordering, stale recovery, deterministic resolution. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { HarnessEventSchema } from '@qa/schemas';
import {
  createEvidenceId,
  createFindingId,
  createHarnessEventId,
  createOperationId,
  nowIsoTimestamp,
} from '@qa/shared';
import {
  HarnessAdapterRegistry,
  type HarnessAdapter,
  type HarnessRunRequest,
} from '@qa/harness-protocol';
import { RunCoordinator, resolveRetestTargets } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

/** Deterministic blocking adapter: signals running, blocks until cancel()
 *  is called, records the call, then emits run.cancelled and terminates. */
class BlockingAdapter implements HarnessAdapter {
  started = false;
  cancelCalls = 0;
  private cancelled = false;
  async getMetadata() {
    return {
      adapterId: 'blocking',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'Blocking',
      capabilities: {},
    };
  }
  async healthCheck() {
    return { status: 'healthy' as const, checks: [], checkedAt: nowIsoTimestamp() };
  }
  async *run(request: HarnessRunRequest) {
    const t = nowIsoTimestamp();
    const emit = (event: unknown) => HarnessEventSchema.parse(event);
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: t,
      type: 'run.started',
    });
    this.started = true;
    while (!this.cancelled) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'run.cancelled',
      reason: 'cancel delivered',
    });
  }
  async cancel() {
    this.cancelCalls += 1;
    this.cancelled = true;
  }
  async dispose() {}
}

function blockingRegistry(adapters: BlockingAdapter[]): HarnessAdapterRegistry {
  const registry = new HarnessAdapterRegistry();
  INITIAL_AGENT_STACKS.forEach((stack, index) => {
    const adapter = adapters[index % adapters.length] as BlockingAdapter;
    registry.register({
      stack,
      runtimeIdentity: {
        modelId: stack.model.modelId,
        adapterId: 'blocking',
        adapterVersion: '0.1.0',
      },
      createAdapter: () => adapter as never,
    });
  });
  return registry;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-closure-'));
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
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  return { root, source, dataRoot, database, repository, lease, manager, added };
}

async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describe('finish-pass §54: true cross-process cancel, no manual ack', () => {
  it('owner observes the request and settles everything itself', async () => {
    const f = await fixture();
    const adapters = [new BlockingAdapter()];
    const owner = new RunCoordinator(f.dataRoot, f.repository, f.lease, blockingRegistry(adapters));
    const workspacePaths: string[] = [];
    const runPromise = owner.run(f.added.project.id, {
      executionKind: 'simulation',
      agentStackIds: [INITIAL_AGENT_STACKS[0]?.id as never],
      runTimeoutMs: 120_000,
      onHarnessRequest: (request) => workspacePaths.push(request.workspace.runtimePath),
    });
    await waitFor(() => adapters[0]?.started === true);
    // Second repository + lease sharing the same database file.
    const {
      SentryDatabase: DB2,
      SentryRepository: Repo2,
      RuntimeInstanceLease: Lease2,
    } = await import('@qa/persistence');
    const database2 = new DB2({ dataRoot: f.dataRoot });
    const repository2 = new Repo2(database2);
    const lease2 = new Lease2(repository2, { autoHeartbeat: false });
    lease2.start();
    const { RunCoordinator: RC2 } = await import('../src/index.js');
    const requester = new RC2(
      f.dataRoot,
      repository2,
      lease2,
      blockingRegistry([new BlockingAdapter()]),
    );
    const running = f.repository.listNonterminalRuns();
    expect(running).toHaveLength(1);
    const runId = running[0]?.id as never;
    // §56: freshness is not ownership — B is fresh but not the owner.
    expect(requester.isLocalRunOwner(running[0] as never)).toBe(false);
    expect(owner.isLocalRunOwner(running[0] as never)).toBe(true);
    // Foreign request: request-only, no terminal state yet.
    const requested = requester.requestRunCancellation(runId);
    expect(requested.status).toBe('cancellation_requested');
    expect(requested.ownerAcknowledged).toBe(false);
    expect(f.repository.getRun(runId)?.status).toBe('agents_running');
    // §57: lock still held while the owner works.
    expect(f.repository.getManagedCopy(f.added.project.id)?.state).toBe('locked_for_run');
    // §58: completedAt unset after request only.
    expect(f.repository.getRunControlRequest(runId)?.completedAt).toBeUndefined();
    // Owner-driven: ONLY WAIT — no manual acknowledge call.
    await waitFor(() => (adapters[0]?.cancelCalls ?? 0) > 0);
    const details = await runPromise;
    expect(details.run.status).toBe('cancelled');
    expect(f.repository.getRun(runId)?.status).toBe('cancelled');
    const agents = f.repository.listAgentRuns(runId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('cancelled');
    const request = f.repository.getRunControlRequest(runId);
    expect(request?.acknowledgedAt).toBeDefined();
    expect(request?.completedAt).toBeDefined();
    // §59: every owned workspace removed before completion is claimed;
    // lock released only after settle.
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(workspacePaths.length).toBeGreaterThan(0);
    for (const runtimePath of workspacePaths) {
      expect(existsSync(resolve(f.dataRoot, runtimePath))).toBe(false);
    }
    expect(f.repository.getManagedCopy(f.added.project.id)?.state).toBe('ready');
    database2.close();
    f.database.close();
  }, 120_000);
});

describe('finish-pass §24/§56-§58: multi-agent cancel preserves completed', () => {
  it('A completed, B/C blocked; foreign request; owner settles alone', async () => {
    const f = await fixture();
    const fast = new (class implements HarnessAdapter {
      async getMetadata() {
        return {
          adapterId: 'fast',
          adapterVersion: '0.1.0',
          protocolVersion: 1,
          displayName: 'Fast',
          capabilities: {},
        };
      }
      async healthCheck() {
        return { status: 'healthy' as const, checks: [], checkedAt: nowIsoTimestamp() };
      }
      async *run(request: HarnessRunRequest) {
        const t = nowIsoTimestamp();
        const emit = (event: unknown) => HarnessEventSchema.parse(event);
        yield emit({
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId: request.agentRunId,
          timestamp: t,
          type: 'run.started',
        });
        const operationId = createOperationId();
        const evidenceId = createEvidenceId();
        yield emit({
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId: request.agentRunId,
          timestamp: t,
          type: 'evidence.submitted',
          evidence: {
            schemaVersion: 1,
            id: evidenceId,
            qaRunId: request.qaRunId,
            agentRunId: request.agentRunId,
            strength: 'reproduced_behavior',
            environmentState: 'baseline',
            type: 'test',
            test: { framework: 'vitest', name: 'fast test', status: 'passed' },
            artifactIds: [],
            groundingOperationIds: [operationId],
            createdAt: t,
          },
        });
        yield emit({
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId: request.agentRunId,
          timestamp: t,
          type: 'finding.submitted',
          finding: {
            schemaVersion: 1,
            id: createFindingId(),
            qaRunId: request.qaRunId,
            agentRunId: request.agentRunId,
            sourceAgentStackId: request.agentStackId,
            title: 'Fast finding',
            category: 'logic',
            severity: 'medium',
            confidence: 'strong',
            description: 'Fast deterministic finding.',
            locations: [{ relativePath: 'README.md' }],
            evidenceIds: [evidenceId],
            reproductionSteps: [],
            createdAt: t,
          },
        });
        yield emit({
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId: request.agentRunId,
          timestamp: t,
          type: 'run.completed',
          usage: { inputTokens: 5, outputTokens: 5, turns: 1, durationMs: 10 },
        });
      }
      async cancel() {}
      async dispose() {}
    })();
    const blockers = [new BlockingAdapter(), new BlockingAdapter()];
    const registry = new HarnessAdapterRegistry();
    const stacks = INITIAL_AGENT_STACKS;
    registry.register({
      stack: stacks[0] as never,
      runtimeIdentity: { modelId: (stacks[0] as never).model.modelId },
      createAdapter: () => fast as never,
    });
    registry.register({
      stack: stacks[1] as never,
      runtimeIdentity: { modelId: (stacks[1] as never).model.modelId },
      createAdapter: () => blockers[0] as never,
    });
    registry.register({
      stack: stacks[2] as never,
      runtimeIdentity: { modelId: (stacks[2] as never).model.modelId },
      createAdapter: () => blockers[1] as never,
    });
    const owner = new RunCoordinator(f.dataRoot, f.repository, f.lease, registry);
    const runPromise = owner.run(f.added.project.id, {
      executionKind: 'simulation',
      runTimeoutMs: 120_000,
    });
    await waitFor(() => blockers[0]?.started === true && blockers[1]?.started === true);
    const running = f.repository.listNonterminalRuns();
    expect(running).toHaveLength(1);
    const runId = running[0]?.id as never;
    const {
      SentryDatabase: DB2,
      SentryRepository: Repo2,
      RuntimeInstanceLease: Lease2,
    } = await import('@qa/persistence');
    const database2 = new DB2({ dataRoot: f.dataRoot });
    const repository2 = new Repo2(database2);
    const lease2 = new Lease2(repository2, { autoHeartbeat: false });
    lease2.start();
    const { RunCoordinator: RC2 } = await import('../src/index.js');
    const requester = new RC2(f.dataRoot, repository2, lease2);
    const requested = requester.requestRunCancellation(runId);
    expect(requested.status).toBe('cancellation_requested');
    // Foreign acknowledge is refused outright.
    expect(() => requester.acknowledgeRunCancellation(runId)).toThrowError(/another runtime/);
    // Owner settles alone.
    const details = await runPromise;
    const byStatus = new Map(details.agentRuns.map((agent) => [agent.agentStackId, agent.status]));
    expect(byStatus.get((stacks[0] as never).id)).toBe('completed');
    expect(details.agentRuns.filter((agent) => agent.status === 'cancelled')).toHaveLength(2);
    expect(details.run.status).toBe('cancelled');
    expect(f.repository.listFindings(runId as never)).toHaveLength(1);
    expect(f.repository.getRunControlRequest(runId)?.completedAt).toBeDefined();
    expect(f.repository.getManagedCopy(f.added.project.id)?.state).toBe('ready');
    database2.close();
    f.database.close();
  }, 120_000);
});

describe('finish-pass §25: stale owner recovery is honest', () => {
  it('stale request completes; run interrupts (never fake-cancelled)', async () => {
    const f = await fixture();
    const { createFakeHarnessRegistry } = await import('../src/index.js');
    const completed = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      createFakeHarnessRegistry('success'),
    ).run(f.added.project.id, { executionKind: 'simulation' });
    // Simulate owner death: the run's owner instance is stale (never heartbeats
    // again) while the recovering lease is a different live runtime.
    f.repository.saveRuntimeInstance({
      schemaVersion: 1,
      id: 'runtime_01K7777777777777777777X8W9',
      processId: 999999,
      hostname: 'dead-owner',
      startedAt: '2020-01-01T00:00:00.000Z',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    } as never);
    f.repository.saveRun({
      ...completed.run,
      runtimeInstanceId: 'runtime_01K7777777777777777777X8W9' as never,
      status: 'agents_running',
      completedAt: undefined,
    } as never);
    f.repository.saveRunControlRequest({
      id: 'cancel_probe',
      qaRunId: completed.run.id,
      projectId: completed.run.projectId,
      requestType: 'cancel',
      requestingRuntimeId: 'runtime_stale',
      requestedAt: nowIsoTimestamp(),
    });
    await new RunCoordinator(f.dataRoot, f.repository, f.lease).recover();
    const status = f.repository.getRun(completed.run.id)?.status;
    expect(status).not.toBe('agents_running');
    expect(status).not.toBe('cancelled');
    expect(f.repository.getRunControlRequest(completed.run.id)?.completedAt).toBeDefined();
    f.database.close();
  }, 120_000);
});

describe('resolution: manifest-based, absence never fixed', () => {
  it('deleted file resolves to the nearest existing ancestor', () => {
    const resolved = resolveRetestTargets({
      historicalPaths: ['src/auth/legacy-token.ts'],
      snapshotFiles: new Set(['src/auth/login.ts', 'README.md']),
    });
    expect(resolved.strategy).toBe('nearest_ancestor');
    expect(resolved.resolvedTargetPaths).toEqual(['src/auth']);
  });
  it('all targets gone uses the explicit focused full-snapshot fallback', () => {
    const resolved = resolveRetestTargets({
      historicalPaths: ['src/auth/legacy-token.ts'],
      snapshotFiles: new Set(['README.md']),
    });
    expect(resolved.strategy).toBe('full_snapshot_fallback');
    expect(resolved.limitations.join(' ')).toMatch(/RETEST_HISTORICAL_TARGETS_ABSENT/);
  });
  it('different failure stays inconclusive, never fixed', async () => {
    const { compareRetestSteps, classifyRetest } = await import('@qa/domain');
    const compared = compareRetestSteps({
      sourceSteps: [
        {
          type: 'command_replay',
          expected: { command: 'npm test', cwdRelative: '.', exitCode: '1' },
          outcome: 'matched',
          matchStrength: 'strong_match',
        },
      ],
      targetSteps: [
        {
          type: 'command_replay',
          expected: { command: 'npm test', cwdRelative: '.', exitCode: '2' },
          outcome: 'matched',
          matchStrength: 'strong_match',
        },
      ],
    });
    expect(classifyRetest(compared.input).result).toBe('inconclusive');
  });
});
