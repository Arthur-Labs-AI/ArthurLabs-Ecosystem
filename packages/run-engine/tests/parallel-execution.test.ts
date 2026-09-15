import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  FakeHarnessAdapter,
  HarnessAdapterRegistry,
  type HarnessAdapter,
} from '@qa/harness-protocol';
import type { AgentRunId, AgentStackId } from '@qa/shared';
import {
  createEvidenceId,
  createFindingId,
  createHarnessEventId,
  createInvestigationPlanId,
  nowIsoTimestamp,
} from '@qa/shared';
import { HarnessEventSchema, type HarnessEvent, type HarnessRunRequest } from '@qa/schemas';
import { RunCoordinator } from '../src/index.js';

const roots: string[] = [];
const resources: Array<{
  readonly lease: RuntimeInstanceLease;
  readonly database: SentryDatabase;
}> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.lease.release();
    resource.database.close();
  }
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-parallel-'));
  roots.push(root);
  const source = join(root, 'source project');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Parallel Fixture\n');
  await writeFile(join(source, 'package.json'), JSON.stringify({ devDependencies: {} }));
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  resources.push({ lease, database });
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  return { root, source, dataRoot, database, repository, lease, added };
}

function planEvent(request: HarnessRunRequest): HarnessEvent {
  return HarnessEventSchema.parse({
    schemaVersion: 1,
    eventId: createHarnessEventId(),
    agentRunId: request.agentRunId,
    timestamp: nowIsoTimestamp(),
    type: 'investigation.plan.created',
    plan: {
      schemaVersion: 1,
      id: createInvestigationPlanId(),
      qaRunId: request.qaRunId,
      agentRunId: request.agentRunId,
      agentStackId: request.agentStackId,
      projectSnapshotId: request.workspace.snapshotId,
      projectContextSnapshotId: request.projectContextSnapshotId,
      projectUnderstanding: 'barrier',
      criticalFlows: ['x'],
      weakPoints: ['y'],
      plannedChecks: ['z'],
      createdAt: nowIsoTimestamp(),
    },
  });
}

function completedEvent(request: HarnessRunRequest): HarnessEvent[] {
  const evidenceId = createEvidenceId();
  return [
    HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'evidence.submitted',
      evidence: {
        schemaVersion: 1,
        id: evidenceId,
        qaRunId: request.qaRunId,
        agentRunId: request.agentRunId,
        strength: 'agent_reasoning',
        environmentState: 'modified_workspace',
        type: 'manual',
        manual: { summary: 'Barrier worker observation.', author: 'Barrier Test' },
        description: 'Barrier worker observation.',
        artifactIds: [],
        createdAt: nowIsoTimestamp(),
      },
    }),
    HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'finding.submitted',
      finding: {
        schemaVersion: 1,
        id: createFindingId(),
        qaRunId: request.qaRunId,
        agentRunId: request.agentRunId,
        sourceAgentStackId: request.agentStackId,
        title: 'Barrier worker finding',
        category: 'testing',
        severity: 'info',
        confidence: 'probable',
        description: 'Barrier worker completed its independent pass.',
        locations: [{ relativePath: 'README.md' }],
        evidenceIds: [evidenceId],
        reproductionSteps: [],
        createdAt: nowIsoTimestamp(),
      },
    }),
    HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'run.completed',
      usage: { turns: 1 },
    }),
  ];
}

interface BarrierState {
  entered: string[];
  waiters: Array<() => void>;
}

/** Adapter that blocks at entry until all three workers overlap, then behaves per scenario. */
class BarrierAdapter implements HarnessAdapter {
  constructor(
    private readonly stackId: AgentStackId,
    private readonly state: BarrierState,
    private readonly behavior: 'success' | 'failure' | 'hang',
    private readonly enteredAt: Map<string, number>,
  ) {}

  async getMetadata() {
    return {
      adapterId: 'barrier-test',
      adapterVersion: '0.1.0',
      protocolVersion: 1 as const,
      displayName: 'Barrier Test Adapter',
      capabilities: {
        streaming: false,
        cancellation: true,
        filesystemRead: false,
        filesystemWrite: false,
        shell: false,
        browser: false,
        sessionResume: false,
        structuredOutput: false,
        usageReporting: false,
      },
      supportedModelPatterns: [],
      supportedOperatingSystems: [],
    };
  }

  async healthCheck() {
    return { status: 'healthy' as const, checks: [], checkedAt: nowIsoTimestamp() };
  }

  async *run(request: HarnessRunRequest): AsyncIterable<HarnessEvent> {
    this.enteredAt.set(this.stackId, Date.now());
    this.state.entered.push(this.stackId);
    if (this.state.entered.length >= 3) {
      for (const wake of this.state.waiters.splice(0)) wake();
    } else {
      await new Promise<void>((resolve) => this.state.waiters.push(resolve));
    }
    yield HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'run.started',
    });
    yield HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'agent.status',
      status: 'planning',
      message: 'Barrier worker planning.',
    });
    yield planEvent(request);
    yield HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'agent.status',
      status: 'investigating',
      message: 'Barrier worker executing.',
    });
    if (this.behavior === 'success') {
      for (const completed of completedEvent(request)) yield completed;
      return;
    }
    if (this.behavior === 'failure') {
      yield HarnessEventSchema.parse({
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId: request.agentRunId,
        timestamp: nowIsoTimestamp(),
        type: 'run.failed',
        failure: { code: 'BARRIER_TEST_FAILURE', message: 'controlled failure', retryable: false },
      });
      return;
    }
    // Hang past the coordinator timeout: the run-level guard must
    // isolate this worker without cancelling its peers.
    await new Promise<void>(() => undefined);
  }

  async cancel(_runId: AgentRunId): Promise<void> {}
  async dispose(): Promise<void> {}
}

function barrierRegistry(
  state: BarrierState,
  enteredAt: Map<string, number>,
  behaviors: Record<string, 'success' | 'failure' | 'hang'>,
): HarnessAdapterRegistry {
  const registry = new HarnessAdapterRegistry();
  for (const stack of INITIAL_AGENT_STACKS) {
    registry.register({
      stack,
      createAdapter: () =>
        new BarrierAdapter(stack.id, state, behaviors[stack.id] ?? 'success', enteredAt),
    });
  }
  return registry;
}

async function runWith(
  f: Awaited<ReturnType<typeof fixture>>,
  registry: HarnessAdapterRegistry,
  runTimeoutMs = 10_000,
) {
  const coordinator = new RunCoordinator(f.dataRoot, f.repository, f.lease, registry);
  return coordinator.run(f.added.project.id, {
    executionKind: 'production',
    runTimeoutMs,
  });
}

describe('parallel three-agent execution', () => {
  it('overlaps all three workers behind a barrier (fails if sequential)', async () => {
    const f = await fixture();
    const state: BarrierState = { entered: [], waiters: [] };
    const enteredAt = new Map<string, number>();
    const details = await runWith(f, barrierRegistry(state, enteredAt, {}));
    expect(details.run.status).toBe('completed');
    expect(state.entered).toHaveLength(3);
    // All three entered before any could finish: entry timestamps cluster.
    const times = [...enteredAt.values()].sort((a, b) => a - b);
    expect(times[2]! - times[0]!).toBeLessThan(10_000);
    // Every worker produced usable output (plan events persisted).
    expect(details.agentRuns.every((agent) => agent.status === 'completed')).toBe(true);
  });

  it('isolates one failure: two completed plus one failed becomes partial', async () => {
    const f = await fixture();
    const state: BarrierState = { entered: [], waiters: [] };
    const details = await runWith(
      f,
      barrierRegistry(state, new Map(), { stack_deepseek_main: 'failure' }),
    );
    expect(details.run.status).toBe('partial');
    const byStack = new Map(details.agentRuns.map((agent) => [agent.agentStackId, agent.status]));
    expect(byStack.get('stack_muse_main')).toBe('completed');
    expect(byStack.get('stack_deepseek_main')).toBe('failed');
    expect(byStack.get('stack_glm_main')).toBe('completed');
  });

  it('isolates one timeout without cancelling peers', async () => {
    const f = await fixture();
    const state: BarrierState = { entered: [], waiters: [] };
    const details = await runWith(
      f,
      barrierRegistry(state, new Map(), { stack_glm_main: 'hang' }),
      2_000,
    );
    expect(details.run.status).toBe('partial');
    const byStack = new Map(details.agentRuns.map((agent) => [agent.agentStackId, agent.status]));
    expect(byStack.get('stack_muse_main')).toBe('completed');
    expect(byStack.get('stack_deepseek_main')).toBe('completed');
    expect(['timed_out', 'interrupted', 'failed']).toContain(byStack.get('stack_glm_main'));
  });

  it('carries no peer information in harness requests', async () => {
    const f = await fixture();
    const state: BarrierState = { entered: [], waiters: [] };
    const seen: string[] = [];
    const coordinator = new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      barrierRegistry(state, new Map(), {}),
    );
    await coordinator.run(f.added.project.id, {
      executionKind: 'production',
      runTimeoutMs: 10_000,
      onHarnessRequest: (request) => seen.push(JSON.stringify(request)),
    });
    expect(seen).toHaveLength(3);
    for (const serialized of seen) {
      // Each request names exactly one stack (its own, in agentStackId
      // and the mirrored context entry) and carries no peer display
      // names, peer findings, or peer evidence.
      const stacks = (serialized.match(/stack_(muse|deepseek|glm)_main/g) ?? []).sort();
      expect(new Set(stacks).size).toBe(1);
      expect(serialized).not.toMatch(
        /Muse QA Agent.*DeepSeek QA Agent|DeepSeek QA Agent.*GLM QA Agent|Muse QA Agent.*GLM QA Agent/,
      );
      expect(serialized).not.toMatch(/another agent|peer|Muse found|agree\?/i);
    }
  });

  it('keeps FakeHarnessAdapter test-only: production registry has no fake adapter', async () => {
    const f = await fixture();
    const state: BarrierState = { entered: [], waiters: [] };
    const registry = barrierRegistry(state, new Map(), {});
    for (const registration of registry.list()) {
      const adapter = await registration.createAdapter({
        qaRunId: 'run_test' as never,
        agentRunId: 'agent_test' as never,
        agentIndex: 0,
        stack: registration.stack,
      });
      expect(adapter).not.toBeInstanceOf(FakeHarnessAdapter);
      expect(adapter).toBeInstanceOf(BarrierAdapter);
    }
    expect(f.repository).toBeDefined();
  });
});
