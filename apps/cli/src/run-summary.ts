import type { AgentRun } from '@qa/schemas';

function boundedRunFailureMessage(message: string): string {
  return message
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

export function summarizeRunStartAgents(
  agentRuns: ReadonlyArray<
    Pick<AgentRun, 'agentStackId' | 'status'> & { readonly failure?: AgentRun['failure'] }
  >,
) {
  return {
    configured: agentRuns.length,
    completed: agentRuns.filter((agent) => agent.status === 'completed').length,
    failed: agentRuns.filter((agent) => agent.status === 'failed').length,
    timedOut: agentRuns.filter((agent) => agent.status === 'timed_out').length,
    interrupted: agentRuns.filter((agent) => agent.status === 'interrupted').length,
    cancelled: agentRuns.filter((agent) => agent.status === 'cancelled').length,
    runs: agentRuns.map((agent) => ({
      agentStackId: agent.agentStackId,
      status: agent.status,
      ...(agent.failure === undefined
        ? {}
        : {
            failure: {
              code: agent.failure.code,
              message: boundedRunFailureMessage(agent.failure.message),
              retryable: agent.failure.retryable,
            },
          }),
    })),
  };
}
