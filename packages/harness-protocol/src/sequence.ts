import type { AgentRunId, QARunId } from '@qa/shared';
import type { HarnessEvent } from '@qa/schemas';
import { HarnessProtocolError } from './errors.js';
import { IncrementalHarnessEventValidator } from './incremental.js';

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
  if (first === undefined) sequenceError('Harness event sequence must not be empty');
  const validator = new IncrementalHarnessEventValidator(
    context.qaRunId ?? inferQARunId(events),
    context.agentRunId ?? first.agentRunId,
  );
  for (const event of events) validator.accept(event);
  validator.finish();
}

function inferQARunId(events: readonly HarnessEvent[]): QARunId {
  for (const event of events) {
    if (event.type === 'finding.submitted') return event.finding.qaRunId;
    if (event.type === 'evidence.submitted') return event.evidence.qaRunId;
    if (event.type === 'investigation.plan.created') return event.plan.qaRunId;
    if (event.type === 'investigation.hypothesis.discovered') return event.hypothesis.qaRunId;
  }
  return 'run_00000000000000000000000000' as QARunId;
}
