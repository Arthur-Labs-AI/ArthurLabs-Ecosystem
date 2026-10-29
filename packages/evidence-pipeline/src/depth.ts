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
  'In every check details, name the concrete breaks attempted and their outcomes; a passed claim with no attempted break, ' +
  'or with only source review, a narrow primitive or part of a broader boundary checked, must set coverage="partial" ' +
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
export function reportCheckAlias(
  plan: { plannedChecks: readonly string[] },
  index: number,
): string {
  return checkIdentities(plan)[index]?.id ?? 'check_' + (index + 1);
}

/**
 * Host-side truth the model cannot overrule: a check whose investigation
 * turn failed before completion is inconclusive, whatever a later report
 * claims. Applied after coverage grounding, before validation.
 */
export function applyBlockedChecks<T extends SentryAgentReportV2>(
  report: T,
  blockedDescriptions: readonly string[],
): T {
  if (blockedDescriptions.length === 0) return report;
  const blocked = new Set(blockedDescriptions);
  return {
    ...report,
    checks: report.checks.map((check) =>
      blocked.has(check.name)
        ? {
            ...check,
            status: 'inconclusive' as const,
            coverage: 'partial' as const,
            details:
              'Host: the investigation turn for this check ended before completion. ' +
              (check.details ?? ''),
          }
        : check,
    ),
    limitations: [
      ...report.limitations,
      'Host ended ' +
        blockedDescriptions.length +
        ' planned check turn(s) early; those checks are inconclusive, not passed.',
    ].slice(0, 100),
  };
}

/** One operation certifies executable proof: ran, succeeded, unambiguous. */
export function isExecutableProofOperation(op: ObservedOperation): boolean {
  return (
    op.exitCode === 0 &&
    typeof op.commandText === 'string' &&
    op.commandText.trim().length > 0 &&
    // Without a shell AST/individual exit statuses, compound commands are
    // ambiguous even when the last process succeeds. Fail conservatively.
    !/[;&|\r\n`<>]|\$\(/.test(op.commandText) &&
    !/^(read|grep|glob|search|list|view)$/i.test(op.toolName) &&
    !/^\s*["']?(?:[^\s"']*[\\/])?(?:rg|grep|cat|sed|head|tail|find|ls|pwd|wc|echo|printf|which)(?:\.exe)?(?:["']?\s|$)/i.test(
      op.commandText ?? '',
    )
  );
}

/**
 * Per-check closure truth: a check turn proves itself only with executable
 * proof produced DURING that turn. Operations banked by earlier checks (or
 * by planning) cannot certify a later check.
 */
export function turnProducedProof(
  beforeKeys: ReadonlySet<string>,
  operations: ReadonlyMap<string, ObservedOperation>,
): boolean {
  for (const [key, op] of operations) {
    if (!beforeKeys.has(key) && isExecutableProofOperation(op)) return true;
  }
  return false;
}

/** Same proof command failing this many times in one turn is a retry-until-green loop. */
export const RED_RETRY_THRESHOLD = 3;

/**
 * True when a check turn re-ran the same executable proof command and it
 * failed (non-zero exit) at least RED_RETRY_THRESHOLD times. The model then
 * edits the repro until green (fixture-fix framing) and every red run that
 * might have been a product defect is explained away; the pass cannot be
 * certified.
 */
export function turnRepeatedRedProof(
  beforeKeys: ReadonlySet<string>,
  operations: ReadonlyMap<string, ObservedOperation>,
): boolean {
  const failures = new Map<string, number>();
  for (const [key, op] of operations) {
    if (beforeKeys.has(key)) continue;
    if (typeof op.exitCode !== 'number' || op.exitCode === 0) continue;
    const text = op.commandText?.trim();
    if (text === undefined || text.length === 0) continue;
    if (/^(read|grep|glob|search|list|view)$/i.test(op.toolName)) continue;
    const count = (failures.get(text) ?? 0) + 1;
    if (count >= RED_RETRY_THRESHOLD) return true;
    failures.set(text, count);
  }
  return false;
}

/**
 * True when the check turn's closing text explicitly classifies the red runs
 * (fixture/probe/test error, or "not a product defect"). The host cannot
 * verify the claim, but silent edit-to-green is what the gate exists to stop:
 * an agent that names the cause has done the triage the prompt demands, and
 * its pass stays visible with the stated reasoning.
 */
export function closingTriagesFailures(text: string | undefined): boolean {
  if (text === undefined) return false;
  return /\b(fixture|probe|test|harness)\s+(error|bug|issue|mistake|problem|quirk)s?\b|\bnot a product (defect|bug)|\b(triaged|classified)\b[^.]{0,80}\b(fixture|probe|not a product)/i.test(
    text,
  );
}

/**
 * Host-side truth the model cannot overrule: a check claimed passed whose
 * own turn produced no successful executable reproduction (or whose proof
 * run failed repeatedly before being edited to pass) is inconclusive.
 * Checks that produced findings (failed) are never rewritten here.
 */
export function applyUnprovenChecks<T extends SentryAgentReportV2>(
  report: T,
  unprovenDescriptions: readonly string[],
  redRetryDescriptions: readonly string[] = [],
): T {
  if (unprovenDescriptions.length === 0 && redRetryDescriptions.length === 0) return report;
  const unproven = new Set(unprovenDescriptions);
  const redRetry = new Set(redRetryDescriptions);
  let forced = 0;
  let redForced = 0;
  const checks = report.checks.map((check) => {
    if (check.status !== 'passed') return check;
    if (!unproven.has(check.name) && redRetry.has(check.name)) {
      redForced += 1;
      return {
        ...check,
        status: 'inconclusive' as const,
        coverage: 'partial' as const,
        details:
          'Host: the same proof command failed ' +
          RED_RETRY_THRESHOLD +
          '+ times in this check turn before the pass; each red run must be triaged as a product defect or a proven fixture error, not edited away. ' +
          (check.details ?? ''),
      };
    }
    if (!unproven.has(check.name)) return check;
    forced += 1;
    return {
      ...check,
      status: 'inconclusive' as const,
      coverage: 'partial' as const,
      details:
        'Host: no successful executable reproduction was observed during this check turn. ' +
        (check.details ?? ''),
    };
  });
  if (forced === 0 && redForced === 0) return report;
  return {
    ...report,
    checks,
    limitations: [
      ...report.limitations,
      ...(forced === 0
        ? []
        : [
            'Host: ' +
              forced +
              ' check(s) had no successful executable reproduction in their own turn; a check cannot pass on source review alone.',
          ]),
      ...(redForced === 0
        ? []
        : [
            'Host: ' +
              redForced +
              ' check(s) re-ran a failing proof command repeatedly before passing; the failures were not triaged, so those passes are unverified.',
          ]),
    ].slice(0, 100),
  };
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
      proof.length > 0 && proof.every((op) => op !== undefined && isExecutableProofOperation(op));
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
