/** Versioned per-run policy, passed by the coordinator, never by project files. */
export function depthPolicy(
  context: Readonly<Record<string, unknown>> | undefined,
): { version: 1; deadlineAt: number } | undefined {
  const value = context?.['qaDepth'] as Record<string, unknown> | undefined;
  if (
    value?.['version'] !== 1 ||
    typeof value['deadlineAt'] !== 'number' ||
    !Number.isFinite(value['deadlineAt'])
  )
    return undefined;
  return { version: 1, deadlineAt: value['deadlineAt'] };
}

export const DEPTH_PREPARATION_GUIDANCE =
  'Sentry has prepared this private workspace. Read workspacePreparation in mission context. ' +
  'Do not install or download dependencies yourself. A limited preparation permits source review, ' +
  'but unavailable executable checks must remain not_run or inconclusive. Generated dependencies ' +
  'and build outputs are not original snapshot evidence. Keep planned check names unique and at most 500 characters so reporting can preserve them exactly.';

/** The legacy plan schema allows longer names than the report schema. */
export function reportableDepthPlan<T extends { plannedChecks: readonly string[] }>(
  plan: T,
  enabled: boolean,
): T {
  if (
    enabled &&
    (plan.plannedChecks.some((name) => name.length > 500) ||
      new Set(plan.plannedChecks).size !== plan.plannedChecks.length)
  )
    throw new Error('Planned check names must be unique and at most 500 characters.');
  return plan;
}

export const DEPTH_COVERAGE_GUIDANCE =
  'Report every frozen plannedChecks entry exactly once in checks, preserving its exact name. ' +
  'For not_run or inconclusive give a concrete reason in details. Do not substitute a successful ' +
  'process exit for a successful check. Distinguish a copied-function example from actual-code ' +
  'reproduction and a reachable application failure. Never claim production exposure merely ' +
  'because a malformed internal object triggers a dangerous function.';

export function challengePrompt(plan: { plannedChecks: readonly string[] }): string {
  return [
    'CHALLENGE YOUR OWN INVESTIGATION. This is one bounded validation pass in the same private workspace.',
    'Do not access the original project, other agents, their workspaces, findings or plans. Never bypass sandboxing.',
    'Do not install dependencies, commit, push or fix product code. Temporary focused tests inside this workspace are allowed.',
    'For each significant candidate trace the real caller, input origin and upstream validation; seek a counterexample that refutes the bug.',
    'When safe and feasible reproduce through the real implementation. Copied logic proves only that example, not a reachable application defect.',
    'Check whether the behavior is intentional under documented contracts. Remove unsupported candidates or lower confidence and severity; state conditional triggers explicitly.',
    'If no candidates remain, revisit the most important unchecked risk from your own plan. Zero findings is valid; never invent a defect.',
    'Finish outstanding applicable checks or record specific limitations. Do not manufacture evidence or run unsafe destructive reproductions.',
    DEPTH_COVERAGE_GUIDANCE,
    'Do not produce the final JSON report. Finish with a short validation-complete message. Reporting follows with the authoritative ledger.',
    'Frozen planned checks: ' + JSON.stringify(plan.plannedChecks),
  ].join('\n');
}

/** Reserve the final minute for serialization; no artificial minimum work time. */
export function canChallenge(deadlineAt: number, now = Date.now()): boolean {
  return deadlineAt - now > 60_000;
}

export function coverageErrors(
  plan: { plannedChecks: readonly string[] },
  report: { checks: readonly { name: string; status: string; details?: string | undefined }[] },
): string[] {
  const errors: string[] = [];
  for (const name of new Set(plan.plannedChecks)) {
    const matches = report.checks.filter((check) => check.name === name);
    if (matches.length !== 1) errors.push('Report frozen check exactly once: ' + name);
    else if (
      ['not_run', 'inconclusive'].includes(matches[0]!.status) &&
      !matches[0]!.details?.trim()
    )
      errors.push('Explain the limitation for: ' + name);
  }
  return errors;
}
