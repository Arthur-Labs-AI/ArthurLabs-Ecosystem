/**
 * FakeHarnessAdapter: deterministic, no-AI implementation of
 * HarnessAdapter for tests (and Phase 2 development). Scenarios:
 * success | failure | cancellation | finding | evidence | transport-loss | timeout | protocol-error.
 */
import type { AgentRunId } from '@qa/shared';
import { createHarnessEventId, createInvestigationPlanId, createOperationId } from '@qa/shared';
import {
  HarnessEventSchema,
  type AgentUsage,
  type EmergentHypothesis,
  type Evidence,
  type Finding,
} from '@qa/schemas';
import type { HarnessEvent } from '@qa/schemas';
import type { HarnessAdapter } from './adapter.js';
import type { HarnessHealthResult, HarnessMetadata } from './metadata.js';
import type { HarnessRunRequest } from './requests.js';
import { FAKE_ADAPTER_CAPABILITIES } from './capabilities.js';

export type FakeScenario =
  | 'success'
  | 'failure'
  | 'cancellation'
  | 'finding'
  | 'evidence'
  | 'transport-loss'
  | 'timeout'
  | 'protocol-error';

export interface FakeAdapterOptions {
  readonly scenario?: FakeScenario;
  readonly finding?: Finding;
  readonly evidence?: Evidence;
  readonly hypothesis?: EmergentHypothesis;
  readonly usage?: AgentUsage;
}

function ts(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function validatedEvent(event: unknown): HarnessEvent {
  return HarnessEventSchema.parse(event);
}

export class FakeHarnessAdapter implements HarnessAdapter {
  private readonly scenario: FakeScenario;
  private readonly finding?: Finding | undefined;
  private readonly evidence?: Evidence | undefined;
  private readonly hypothesis?: EmergentHypothesis | undefined;
  private readonly usage: AgentUsage;
  private readonly cancelledRunIds = new Set<AgentRunId>();
  private disposed = false;

  constructor(options: FakeAdapterOptions = {}) {
    this.scenario = options.scenario ?? 'success';
    this.finding = options.finding;
    this.evidence = options.evidence;
    this.hypothesis = options.hypothesis;
    this.usage = options.usage ?? {
      inputTokens: 120,
      outputTokens: 45,
      turns: 2,
      durationMs: 1500,
    };
  }

  async getMetadata(): Promise<HarnessMetadata> {
    return {
      adapterId: 'fake-harness',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'Fake Harness Adapter',
      capabilities: { ...FAKE_ADAPTER_CAPABILITIES },
    };
  }

  async healthCheck(): Promise<HarnessHealthResult> {
    return {
      status: 'healthy',
      checks: [{ name: 'fake-adapter', status: 'pass', message: 'Fake adapter always healthy' }],
      checkedAt: ts(0) as HarnessHealthResult['checkedAt'],
    };
  }

  async *run(request: HarnessRunRequest): AsyncIterable<HarnessEvent> {
    const agentRunId = request.agentRunId;
    const t = (ms: number) => ts(ms) as HarnessEvent['timestamp'];
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(0),
      type: 'run.started',
    });
    if (this.cancelledRunIds.has(agentRunId) || this.scenario === 'cancellation') {
      yield validatedEvent({
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(10),
        type: 'run.cancelled',
        reason: 'Cancelled by fake scenario',
      });
      return;
    }
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(20),
      type: 'agent.status',
      status: 'planning',
      message: 'Building an independent investigation plan',
    });
    if (this.scenario === 'protocol-error' && this.finding !== undefined) {
      yield validatedEvent({
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(22),
        type: 'finding.submitted',
        finding: {
          ...this.finding,
          qaRunId: 'run_01K7777777777777777777A8W3',
        },
      });
      return;
    }
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(25),
      type: 'investigation.plan.created',
      plan: {
        schemaVersion: 1,
        id: createInvestigationPlanId(),
        qaRunId: request.qaRunId,
        agentRunId,
        agentStackId: request.agentStackId,
        projectSnapshotId: request.workspace.snapshotId,
        projectContextSnapshotId: request.projectContextSnapshotId,
        projectUnderstanding: 'A deterministic fake project understanding.',
        criticalFlows: ['Primary application flow'],
        weakPoints: ['Boundary validation'],
        plannedChecks: ['Run the deterministic fake test command'],
        createdAt: t(25),
      },
    });
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(28),
      type: 'agent.status',
      status: 'investigating',
      message: 'Executing the independent investigation plan',
    });
    const operationId = createOperationId();
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(30),
      type: 'tool.started',
      operationId,
      tool: { name: 'shell', inputSummary: 'npm test' },
    });
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(40),
      type: 'tool.completed',
      operationId,
      tool: { name: 'shell', exitCode: 0, durationMs: 120 },
    });
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(45),
      type: 'test.result',
      operationId,
      suite: 'fake-suite',
      passed: 1,
      failed: 0,
    });
    if (this.hypothesis !== undefined) {
      yield validatedEvent({
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(48),
        type: 'investigation.hypothesis.discovered',
        hypothesis: this.hypothesis,
      });
    }
    if (
      (this.scenario === 'evidence' ||
        this.scenario === 'finding' ||
        this.scenario === 'success' ||
        this.scenario === 'transport-loss' ||
        this.scenario === 'timeout') &&
      this.evidence !== undefined
    ) {
      yield validatedEvent({
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(50),
        type: 'evidence.submitted',
        evidence: this.evidence,
      });
    }
    if (
      (this.scenario === 'finding' ||
        this.scenario === 'success' ||
        this.scenario === 'transport-loss' ||
        this.scenario === 'timeout') &&
      this.finding !== undefined
    ) {
      yield validatedEvent({
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(60),
        type: 'finding.submitted',
        finding: this.finding,
      });
    }
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(70),
      type: 'usage.updated',
      usage: this.usage,
    });
    if (this.scenario === 'failure') {
      yield validatedEvent({
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(80),
        type: 'run.failed',
        failure: {
          code: 'HARNESS_PROCESS_CRASHED',
          message: 'Fake harness process exited unexpectedly',
          retryable: true,
        },
      });
      return;
    }
    if (this.scenario === 'transport-loss') {
      throw new Error('Fake harness transport disconnected before a terminal event');
    }
    if (this.scenario === 'timeout') {
      while (!this.cancelledRunIds.has(agentRunId)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      return;
    }
    yield validatedEvent({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(90),
      type: 'run.completed',
      usage: this.usage,
    });
  }

  async cancel(runId: AgentRunId): Promise<void> {
    this.cancelledRunIds.add(runId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
