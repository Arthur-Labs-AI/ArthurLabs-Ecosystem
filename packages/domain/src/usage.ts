import type { AgentRunStatus, AgentUsage } from '@qa/schemas';

export type AgentRunAggregateOutcome = 'completed' | 'partial' | 'failed';

/** Aggregate only terminal worker outcomes. Whole-run cancellation is handled by QARun state. */
export function aggregateAgentRunOutcome(
  statuses: readonly AgentRunStatus[],
): AgentRunAggregateOutcome {
  const allowed = new Set<AgentRunStatus>(['completed', 'failed', 'timed_out', 'interrupted']);
  if (statuses.some((status) => !allowed.has(status))) {
    throw new TypeError('Agent outcome aggregation requires terminal non-cancelled statuses');
  }
  const completed = statuses.filter((status) => status === 'completed').length;
  if (completed === statuses.length && statuses.length > 0) return 'completed';
  if (completed > 0) return 'partial';
  return 'failed';
}

const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'turns',
  'durationMs',
] as const;

/** Sum known usage values without inventing zero for wholly unknown metrics. */
export function aggregateAgentUsage(usages: readonly AgentUsage[]): AgentUsage {
  const aggregate: AgentUsage = {};
  for (const key of USAGE_KEYS) {
    const known = usages.flatMap((usage) => (usage[key] === undefined ? [] : [usage[key]]));
    if (known.length > 0) aggregate[key] = known.reduce((sum, value) => sum + value, 0);
  }
  return aggregate;
}
