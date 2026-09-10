import type { AgentRunId, QARunId } from '@qa/shared';
import type { HarnessEvent } from '@qa/schemas';
import { HarnessProtocolError } from './errors.js';

const TERMINAL_EVENT_TYPES = new Set<HarnessEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export interface HarnessEventSequenceContext {
  readonly agentRunId?: AgentRunId;
  readonly qaRunId?: QARunId;
}

function sequenceError(message: string, eventIndex?: number): never {
  throw new HarnessProtocolError(
    'INVALID_EVENT_SEQUENCE',
    message,
    eventIndex === undefined ? undefined : { eventIndex },
  );
}

/** Validate cross-event lifecycle and identity invariants after individual event parsing. */
export function validateHarnessEventSequence(
  events: readonly HarnessEvent[],
  context: HarnessEventSequenceContext = {},
): void {
  if (events.length === 0) sequenceError('Harness event sequence must not be empty');

  const first = events[0];
  if (first === undefined || first.type !== 'run.started') {
    sequenceError('run.started must be the first event', 0);
  }

  const agentRunId = context.agentRunId ?? first.agentRunId;
  let startedCount = 0;
  let terminalCount = 0;
  let terminalIndex = -1;

  events.forEach((event, eventIndex) => {
    if (event.agentRunId !== agentRunId) {
      throw new HarnessProtocolError(
        'AGENT_RUN_MISMATCH',
        'All harness events must belong to one AgentRun',
        { eventIndex },
      );
    }
    if (event.type === 'run.started') startedCount += 1;
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      terminalCount += 1;
      terminalIndex = eventIndex;
    }

    if (event.type === 'finding.submitted' && event.finding.agentRunId !== event.agentRunId) {
      throw new HarnessProtocolError(
        'AGENT_RUN_MISMATCH',
        'Submitted Finding must belong to the event AgentRun',
        { eventIndex },
      );
    }
    if (
      event.type === 'evidence.submitted' &&
      event.evidence.agentRunId !== undefined &&
      event.evidence.agentRunId !== event.agentRunId
    ) {
      throw new HarnessProtocolError(
        'AGENT_RUN_MISMATCH',
        'Submitted Evidence must belong to the event AgentRun when agentRunId is present',
        { eventIndex },
      );
    }
    if (
      context.qaRunId !== undefined &&
      ((event.type === 'finding.submitted' && event.finding.qaRunId !== context.qaRunId) ||
        (event.type === 'evidence.submitted' && event.evidence.qaRunId !== context.qaRunId))
    ) {
      throw new HarnessProtocolError(
        'QA_RUN_MISMATCH',
        'Submitted Finding or Evidence must belong to the requested QARun',
        { eventIndex },
      );
    }
  });

  if (startedCount !== 1)
    sequenceError('Harness event sequence must contain exactly one run.started');
  if (terminalCount !== 1) {
    sequenceError('Harness event sequence must contain exactly one terminal event');
  }
  if (terminalIndex !== events.length - 1) {
    sequenceError('The terminal event must be last', terminalIndex + 1);
  }
}
