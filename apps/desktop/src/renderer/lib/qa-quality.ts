/** Evidence labels describe proof, independently of severity or model confidence. */
export function proofLabel(evidence: readonly { type: string; strength?: string }[]): string {
  if (
    evidence.some(
      (item) =>
        ['command', 'test'].includes(item.type) &&
        ['reproduced_behavior', 'reproduced_failure'].includes(item.strength ?? ''),
    )
  )
    return 'Behavior reproduced';
  if (evidence.some((item) => item.type === 'code_reference')) return 'Source-supported';
  return 'Unconfirmed';
}

export function coverageLabel(
  events: readonly { type: string; code?: string; message?: string }[],
  status: string,
): string {
  const enabled = events.some(
    (event) => event.message === 'QA_DEPTH_V1: independent validation enabled.',
  );
  if (!enabled) return 'Analysis coverage unknown';
  if (['failed', 'cancelled', 'timed_out', 'interrupted'].includes(status))
    return 'Partial analysis';
  if (
    events.some(
      (event) =>
        event.type === 'warning' &&
        [
          'QA_PREPARATION_LIMITED',
          'QA_COVERAGE_PARTIAL',
          'QA_CHALLENGE_NOT_RUN',
          'QA_VALIDATION_INCOMPLETE',
          'QA_INVESTIGATION_INCOMPLETE',
        ].includes(event.code ?? ''),
    )
  )
    return 'Partial analysis';
  return status === 'completed' ? 'Planned checks reported' : 'Analysis in progress';
}
