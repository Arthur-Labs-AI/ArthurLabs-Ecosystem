import type { AgentRunId, QARunId } from '@qa/shared';
import type { HarnessEvent } from '@qa/schemas';
import { HarnessProtocolError } from './errors.js';

const TERMINAL_TYPES = new Set<HarnessEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export class IncrementalHarnessEventValidator {
  private readonly seenOperations = new Set<string>();
  private readonly openOperations = new Map<string, string>();
  private started = false;
  private terminal = false;
  private eventIndex = 0;

  constructor(
    private readonly qaRunId: QARunId,
    private readonly agentRunId: AgentRunId,
  ) {}

  accept(event: HarnessEvent): void {
    const index = this.eventIndex;
    if (this.terminal) this.fail('No event is allowed after a terminal event', index);
    if (event.agentRunId !== this.agentRunId) {
      throw new HarnessProtocolError(
        'AGENT_RUN_MISMATCH',
        'Harness event belongs to a different AgentRun',
        { eventIndex: index },
      );
    }
    if (!this.started && event.type !== 'run.started') {
      this.fail('run.started must be the first event', index);
    }
    if (event.type === 'run.started') {
      if (this.started) this.fail('run.started may only occur once', index);
      this.started = true;
    }

    if (event.type === 'tool.started') {
      if (this.seenOperations.has(event.operationId)) {
        this.fail('A tool operationId cannot be reused during an AgentRun', index);
      }
      this.seenOperations.add(event.operationId);
      this.openOperations.set(event.operationId, event.tool.name);
    } else if (event.type === 'tool.completed') {
      const toolName = this.openOperations.get(event.operationId);
      if (toolName === undefined) {
        this.fail('tool.completed requires a matching tool.started operationId', index);
      }
      if (toolName !== event.tool.name) {
        this.fail('Correlated tool events must name the same tool', index);
      }
      this.openOperations.delete(event.operationId);
    }

    if (event.type === 'finding.submitted') {
      this.assertOwned(event.finding.qaRunId, event.finding.agentRunId, index, 'Finding');
    } else if (event.type === 'evidence.submitted') {
      this.assertOwned(event.evidence.qaRunId, event.evidence.agentRunId, index, 'Evidence');
    } else if (event.type === 'investigation.plan.created') {
      this.assertOwned(event.plan.qaRunId, event.plan.agentRunId, index, 'Investigation plan');
    } else if (event.type === 'investigation.hypothesis.discovered') {
      this.assertOwned(
        event.hypothesis.qaRunId,
        event.hypothesis.agentRunId,
        index,
        'Emergent hypothesis',
      );
    }

    if (TERMINAL_TYPES.has(event.type)) {
      if (this.openOperations.size > 0) {
        this.fail('Terminal event cannot leave tool operations open', index);
      }
      this.terminal = true;
    }
    this.eventIndex += 1;
  }

  finish(): void {
    if (!this.started) this.fail('Harness event sequence must not be empty');
    if (!this.terminal) this.fail('Harness stream closed without a terminal event');
    if (this.openOperations.size > 0) {
      this.fail('Every tool.started operation must have a matching tool.completed event');
    }
  }

  hasTerminalEvent(): boolean {
    return this.terminal;
  }

  private assertOwned(
    qaRunId: QARunId,
    agentRunId: AgentRunId | undefined,
    eventIndex: number,
    label: string,
  ): void {
    if (qaRunId !== this.qaRunId) {
      throw new HarnessProtocolError('QA_RUN_MISMATCH', label + ' belongs to another QARun', {
        eventIndex,
      });
    }
    if (agentRunId !== undefined && agentRunId !== this.agentRunId) {
      throw new HarnessProtocolError('AGENT_RUN_MISMATCH', label + ' belongs to another AgentRun', {
        eventIndex,
      });
    }
  }

  private fail(message: string, eventIndex?: number): never {
    throw new HarnessProtocolError(
      'INVALID_EVENT_SEQUENCE',
      message,
      eventIndex === undefined ? undefined : { eventIndex },
    );
  }
}
