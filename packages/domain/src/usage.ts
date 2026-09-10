import type { AgentRunStatus, AgentUsage } from '@qa/schemas';

export type AgentRunAggregateOutcome = 'completed' | 'partial' | 'failed';

export interface AgentRunOutcomeInput {
  readonly status: AgentRunStatus;
  readonly producedUsableOutput: boolean;
}

/** Aggregate only terminal worker outcomes. Whole-run cancellation is handled by QARun state. */
export function aggregateAgentRunOutcome(
  outcomes: readonly AgentRunOutcomeInput[],
): AgentRunAggregateOutcome {
  const allowed = new Set<AgentRunStatus>(['completed', 'failed', 'timed_out', 'interrupted']);
  if (outcomes.some(({ status }) => !allowed.has(status))) {
    throw new TypeError('Agent outcome aggregation requires terminal non-cancelled statuses');
  }
  const completed = outcomes.filter(({ status }) => status === 'completed').length;
  if (completed === outcomes.length && outcomes.length > 0) return 'completed';
  if (outcomes.some(({ producedUsableOutput }) => producedUsableOutput)) return 'partial';
  return 'failed';
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'turns'] as const;

export interface AggregatedAgentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly turns?: number;
  readonly aggregateAgentExecutionMs?: number;
}

/** Sum known usage values without inventing zero for wholly unknown metrics. */
export function aggregateAgentUsage(usages: readonly AgentUsage[]): AggregatedAgentUsage {
  const aggregate: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    turns?: number;
    aggregateAgentExecutionMs?: number;
  } = {};
  for (const key of USAGE_KEYS) {
    const known = usages.flatMap((usage) => (usage[key] === undefined ? [] : [usage[key]]));
    if (known.length > 0) aggregate[key] = known.reduce((sum, value) => sum + value, 0);
  }
  const knownDurations = usages.flatMap((usage) =>
    usage.durationMs === undefined ? [] : [usage.durationMs],
  );
  if (knownDurations.length > 0) {
    aggregate.aggregateAgentExecutionMs = knownDurations.reduce((sum, value) => sum + value, 0);
  }
  return aggregate;
}
