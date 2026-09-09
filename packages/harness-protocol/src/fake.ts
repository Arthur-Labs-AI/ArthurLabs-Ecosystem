/**
 * FakeHarnessAdapter: deterministic, no-AI implementation of
 * HarnessAdapter for tests (and Phase 2 development). Scenarios:
 * success | failure | cancellation | finding | evidence.
 */
import type { AgentRunId } from '@qa/shared';
import { createHarnessEventId } from '@qa/shared';
import type { AgentUsage, Evidence, Finding, HarnessEvent } from '@qa/schemas';
import type { HarnessAdapter } from './adapter.js';
import type { HarnessHealthResult, HarnessMetadata } from './metadata.js';
import type { HarnessRunRequest } from './requests.js';
import { FAKE_ADAPTER_CAPABILITIES } from './capabilities.js';

export type FakeScenario = 'success' | 'failure' | 'cancellation' | 'finding' | 'evidence';

export interface FakeAdapterOptions {
  readonly scenario?: FakeScenario;
  readonly finding?: Finding;
  readonly evidence?: Evidence;
  readonly usage?: AgentUsage;
}

function ts(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export class FakeHarnessAdapter implements HarnessAdapter {
  private readonly scenario: FakeScenario;
  private readonly finding?: Finding | undefined;
  private readonly evidence?: Evidence | undefined;
  private readonly usage: AgentUsage;
  private cancelled = false;
  private disposed = false;

  constructor(options: FakeAdapterOptions = {}) {
    this.scenario = options.scenario ?? 'success';
    this.finding = options.finding;
    this.evidence = options.evidence;
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
    const agentRunId = request.agentRunId as AgentRunId;
    const t = (ms: number) => ts(ms) as HarnessEvent['timestamp'];
    yield {
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(0),
      type: 'run.started',
    };
    if (this.cancelled || this.scenario === 'cancellation') {
      yield {
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(10),
        type: 'run.cancelled',
        reason: 'Cancelled by fake scenario',
      };
      return;
    }
    yield {
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(20),
      type: 'agent.status',
      status: 'working',
      message: 'Fake analysis running',
    };
    yield {
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(30),
      type: 'tool.started',
      tool: { name: 'shell', inputSummary: 'npm test' },
    };
    yield {
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(40),
      type: 'tool.completed',
      tool: { name: 'shell', exitCode: 0, durationMs: 120 },
    };
    if (
      (this.scenario === 'evidence' ||
        this.scenario === 'finding' ||
        this.scenario === 'success') &&
      this.evidence !== undefined
    ) {
      yield {
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(50),
        type: 'evidence.submitted',
        evidence: this.evidence,
      };
    }
    if (
      (this.scenario === 'finding' || this.scenario === 'success') &&
      this.finding !== undefined
    ) {
      yield {
        schemaVersion: 1,
        eventId: createHarnessEventId(),
        agentRunId,
        timestamp: t(60),
        type: 'finding.submitted',
        finding: this.finding,
      };
    }
    yield {
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(70),
      type: 'usage.updated',
      usage: this.usage,
    };
    if (this.scenario === 'failure') {
      yield {
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
      };
      return;
    }
    yield {
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId,
      timestamp: t(90),
      type: 'run.completed',
      usage: this.usage,
    };
  }

  async cancel(_runId: AgentRunId): Promise<void> {
    this.cancelled = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}
