import type { SentryAgentReportV2 } from '@qa/schemas';
import type { ObservedOperation } from './pipeline.js';

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
  'Report every frozen plannedChecks entry exactly once in checks, using its host-issued short ID when supplied, otherwise its exact name. ' +
  'For not_run or inconclusive give a concrete reason in details. Do not substitute a successful ' +
  'process exit for a successful check. Distinguish a copied-function example from actual-code ' +
  'reproduction and a reachable application failure. Never claim production exposure merely ' +
  'because a malformed internal object triggers a dangerous function. For each passed check set coverage="complete" ' +
  'and operationKeys to the observed successful executable checks covering the WHOLE named check. ' +
  'If only source review, a narrow primitive or part of a broader boundary was checked, set coverage="partial" ' +
  'and status="inconclusive". File reads, grep and counts are not executable coverage.';

/** Short host-owned aliases avoid requiring verbatim repetition of long plan prose. */
function checkIdentities(plan: { plannedChecks: readonly string[] }) {
  let prefix = 'check_';
  while (plan.plannedChecks.some((name) => name.startsWith(prefix))) prefix = '_' + prefix;
  return plan.plannedChecks.map((description, index) => ({
    id: prefix + (index + 1),
    description,
  }));
}
export function reportCheckAliases(plan: { plannedChecks: readonly string[] }): string {
  return (
    'Check identity contract: set checks[].name to the short ID below (or its exact frozen description). Never abbreviate or paraphrase a description. Explain results in details, not name.\n' +
    JSON.stringify(checkIdentities(plan))
  );
}

export function resolveReportChecks<T extends { checks: readonly { name: string }[] }>(
  plan: { plannedChecks: readonly string[] },
  report: T,
): T {
  return {
    ...report,
    checks: report.checks.map((check) => {
      if (plan.plannedChecks.includes(check.name)) return check;
      const name = checkIdentities(plan).find(
        (identity) => identity.id === check.name,
      )?.description;
      return name === undefined ? check : { ...check, name };
    }),
  };
}

/** Conservative grounding: preserve useful findings, downgrade unsupported pass claims. */
export function groundCoverage(
  report: SentryAgentReportV2,
  operations: ReadonlyMap<string, ObservedOperation>,
): SentryAgentReportV2 {
  let downgraded = false;
  const checks = report.checks.map((check) => {
    if (check.status !== 'passed') return check;
    const proof = (check.operationKeys ?? []).map((key) => operations.get(key));
    const executable =
      proof.length > 0 &&
      proof.every(
        (op) =>
          op !== undefined &&
          op.exitCode === 0 &&
          typeof op.commandText === 'string' &&
          op.commandText.trim().length > 0 &&
          // Without a shell AST/individual exit statuses, compound commands are
          // ambiguous even when the last process succeeds. Fail conservatively.
          !/[;&|\r\n`<>]|\$\(/.test(op.commandText) &&
          !/^(read|grep|glob|search|list|view)$/i.test(op.toolName) &&
          !/^\s*["']?(?:[^\s"']*[\\/])?(?:rg|grep|cat|sed|head|tail|find|ls|pwd|wc|echo|printf|which)(?:\.exe)?(?:["']?\s|$)/i.test(
            op.commandText ?? '',
          ),
      );
    if (check.coverage === 'complete' && executable) return check;
    downgraded = true;
    return {
      ...check,
      status: 'inconclusive' as const,
      coverage: 'partial' as const,
      details: ('Complete executable coverage was not established. ' + (check.details ?? '')).slice(
        0,
        5000,
      ),
    };
  });
  return {
    ...report,
    checks,
    limitations: downgraded
      ? [
          ...report.limitations,
          'One or more claimed passes were downgraded: whole-check executable coverage was not established.',
        ].slice(0, 100)
      : report.limitations,
  };
}

export function challengePrompt(plan: { plannedChecks: readonly string[] }): string {
  return [
    'CHALLENGE YOUR OWN INVESTIGATION. Optional bounded review of the checkpoint, not another full investigation. Never bypass sandboxing.',
    'For significant findings check the real caller, input origin, upstream validation and a counterexample. Use a narrow actual-code check only if it changes the conclusion. Remove unsupported findings; environmental restrictions are limitations. Zero findings is valid.',
    'Return exactly {"reportNeedsUpdate":true} if findings, evidence or coverage need changes, otherwise {"reportNeedsUpdate":false}. Do not rewrite unchanged prose or repeat completed checks. No final report in this turn.',
    'Frozen planned checks: ' + JSON.stringify(plan.plannedChecks),
  ].join('\n');
}

/** Invalid/prose responses conservatively require the normal final report. */
export function reviewNeedsUpdate(text: string): boolean {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return !(
      value !== null &&
      typeof value === 'object' &&
      Object.keys(value).length === 1 &&
      value['reportNeedsUpdate'] === false
    );
  } catch {
    return true;
  }
}

/** Optional review never consumes the last five minutes; a valid checkpoint exists first. */
export function validationBudgetMs(deadlineAt: number, now = Date.now()): number {
  return Math.max(0, Math.min(120_000, deadlineAt - now - 300_000));
}

export function canChallenge(deadlineAt: number, now = Date.now()): boolean {
  return validationBudgetMs(deadlineAt, now) >= 30_000;
}

/** Timeout is terminal for the owned client; callers fall back to the validated checkpoint. */
export async function boundedValidation<T>(
  work: () => Promise<T>,
  budgetMs: number,
  stop: () => Promise<void>,
): Promise<T> {
  if (budgetMs <= 0) throw new Error('QA_VALIDATION_TIMEOUT');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: Promise<void> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopped = Promise.resolve()
            .then(stop)
            .catch(() => {
              throw new Error('QA_VALIDATION_CLEANUP_FAILED');
            });
          reject(new Error('QA_VALIDATION_TIMEOUT'));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await stopped;
  }
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
