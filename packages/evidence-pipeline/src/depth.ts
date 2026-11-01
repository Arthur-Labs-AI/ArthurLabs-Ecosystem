import type { SentryAgentReportV2 } from '@qa/schemas';
import { DEPENDENCY_INSTALL_COMMAND } from '@qa/shared';
import { investigationDeadline } from './phase-budget.js';
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
  'Install missing dependencies yourself with the project’s own package manager and lockfile (registries only); an install prepares a check but never proves one. If an install fails, a limited preparation permits source review, ' +
  'but unavailable executable checks must remain not_run or inconclusive. Generated dependencies ' +
  'and build outputs are not original snapshot evidence. Keep planned check names unique and at most 500 characters so reporting can preserve them exactly.';

/** Planned checks the investigation time can honestly cover: a check needs real time to execute. */
export const MINUTES_PER_PLANNED_CHECK = 25;
export const MAX_PLANNED_CHECKS = 8;
export const MIN_PLANNED_CHECKS = 2;

/**
 * How many checks to plan for this run. A slow model on a deep project cannot
 * cover eight broad checks in three hours, and checks that never start are
 * worse than fewer checks that do. Without a deadline (legacy runs) the old
 * ceiling stays.
 */
export function maxPlannedChecks(
  context: Readonly<Record<string, unknown>> | undefined,
  now = Date.now(),
): number {
  const depth = depthPolicy(context);
  if (depth === undefined) return MAX_PLANNED_CHECKS;
  const minutes = (investigationDeadline(depth.deadlineAt, now) - now) / 60_000;
  return Math.min(
    MAX_PLANNED_CHECKS,
    Math.max(MIN_PLANNED_CHECKS, Math.floor(minutes / MINUTES_PER_PLANNED_CHECK)),
  );
}

/** The legacy plan schema allows longer names than the report schema. */
export function reportableDepthPlan<T extends { plannedChecks: readonly string[] }>(
  plan: T,
  enabled: boolean,
  maxChecks?: number,
): T {
  if (
    enabled &&
    (plan.plannedChecks.some((name) => name.length > 500) ||
      new Set(plan.plannedChecks).size !== plan.plannedChecks.length)
  )
    throw new Error('Planned check names must be unique and at most 500 characters.');
  // The plan is risk-ordered, so the first checks are the ones worth the time.
  if (enabled && maxChecks !== undefined && plan.plannedChecks.length > maxChecks)
    return { ...plan, plannedChecks: plan.plannedChecks.slice(0, maxChecks) };
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

/**
 * Output handling that cannot change a command's exit status: stderr
 * redirects always, and a trailing `| tail`/`| head` filter only when the
 * host ran the command under pipefail (otherwise the pipeline's exit code is
 * the filter's, which would certify a failed run).
 */
function withoutHarmlessOutputHandling(command: string, pipefail: boolean): string {
  let text = command.trim();
  if (pipefail) text = text.replace(/\s*\|\s*(?:tail|head)(?:\s+-(?:[nc]\s*)?\+?\d+)?\s*$/, '');
  return text.replace(/\s+2>\s*&1(?=\s|$)/g, '').replace(/\s+2>\s*\/dev\/null(?=\s|$)/g, '');
}

/** One operation certifies executable proof: ran, succeeded, unambiguous. */
export function isExecutableProofOperation(op: ObservedOperation): boolean {
  return (
    op.exitCode === 0 &&
    typeof op.commandText === 'string' &&
    op.commandText.trim().length > 0 &&
    // Without a shell AST/individual exit statuses, compound commands are
    // ambiguous even when the last process succeeds. Fail conservatively.
    !/[;&|\r\n`<>]|\$\(/.test(
      withoutHarmlessOutputHandling(op.commandText, op.pipefail === true),
    ) &&
    !READ_ONLY_TOOL.test(op.toolName) &&
    !DEPENDENCY_INSTALL_COMMAND.test(op.commandText) &&
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

/**
 * Identity of a command for retry counting: the same run is the same run
 * whatever output trimming (`| tail -70` vs `| tail -120`) or stderr
 * redirect the agent appends, so varying them cannot hide a retry loop.
 */
export function retryKey(command: string): string {
  return withoutHarmlessOutputHandling(command, true).replace(/\s+/g, ' ');
}

/** Shell commands that only look around; they never reproduce a behavior. */
const READ_ONLY_SHELL =
  /^\s*["']?(?:[^\s"']*[\\/])?(?:rg|grep|cat|sed|head|tail|find|ls|pwd|wc|echo|printf|which)(?:\.exe)?(?:["']?\s|$)/i;

/**
 * True when the turn executed something that could reproduce a behavior and
 * reported an exit status, pass or fail. A red probe that demonstrates a
 * defect is an executed reproduction; only read-only turns need a nudge.
 */
export function turnExecutedReproduction(
  beforeKeys: ReadonlySet<string>,
  operations: ReadonlyMap<string, ObservedOperation>,
): boolean {
  for (const [key, op] of operations) {
    if (beforeKeys.has(key) || typeof op.exitCode !== 'number') continue;
    if (READ_ONLY_TOOL.test(op.toolName)) continue;
    const text = op.commandText?.trim() ?? '';
    if (text.length > 0 && !READ_ONLY_SHELL.test(text) && !DEPENDENCY_INSTALL_COMMAND.test(text))
      return true;
  }
  return false;
}

/**
 * Tools that only look. Harnesses name them differently (read, Read, read_file,
 * grep, glob, list_dir, ...), and a spiral hides if any of them goes uncounted.
 */
export const READ_ONLY_TOOL =
  /^(?:read(?:_?file)?|grep(?:_search)?|glob|search|(?:file|codebase)_search|list(?:_?(?:dir|directory|files))?|ls|tree|view|find(?:_files)?)$/i;

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
    const raw = op.commandText?.trim();
    if (raw === undefined || raw.length === 0) continue;
    if (READ_ONLY_TOOL.test(op.toolName)) continue;
    const text = retryKey(raw);
    const count = (failures.get(text) ?? 0) + 1;
    if (count >= RED_RETRY_THRESHOLD) return true;
    failures.set(text, count);
  }
  return false;
}

/**
 * Consecutive read-only operations (read/grep/glob/search/list/view) without
 * any executed or edited operation in between. Behavioural, not temporal: a
 * large project may legitimately take long, and an agent new to a repository
 * orients itself by reading (run_01M6BPH6 was stopped after 15 reads in three
 * of six checks), but reading 30 times without running or changing anything
 * is a source-review spiral on any project.
 */
export const NO_PROGRESS_LIMIT = 30;

/**
 * When the first pass leaves checks undecided and at least this fraction of
 * the investigation window is still unused, the host gives the weakest checks
 * a second pass instead of reporting them inconclusive with hours to spare.
 */
export const SECOND_PASS_MIN_REMAINING_FRACTION = 0.4;
export const MAX_SECOND_PASS_CHECKS = 3;

/**
 * Extension round: when at least this much of the window is still unused after
 * every check has had its turn (and any second pass), the thinnest decided
 * checks are attacked again from new angles.
 */
export const DEEPEN_MIN_REMAINING_FRACTION = 0.5;
export const MAX_DEEPEN_CHECKS = 3;
/** Off-check leads followed up in the extension round, before any deepening. */
export const MAX_LEAD_TURNS = 4;

/**
 * Hazard sweep: after the extension round, source files the host flagged for risky
 * operations (deletes, name rewrites, parsers, hashing) get a probe each while at
 * least this much of the window is unused. It ends early when turns stop producing
 * executable proof.
 */
export const SWEEP_MIN_REMAINING_FRACTION = 0.3;
export const MAX_SWEEP_TURNS = 8;
export const SWEEP_IDLE_TURN_LIMIT = 2;

/**
 * Leads an investigator noted on its "Leads:" line (semicolon separated).
 * Agent-stated and unverified: they only decide what to probe next.
 */
export function extractLeads(statement: string): string[] {
  const match = /^\s*leads:\s*(.+)$/im.exec(statement);
  if (match === null) return [];
  return (match[1] ?? '')
    .split(';')
    .map((lead) => lead.replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter((lead) => lead.length > 3 && !/^(none|n\/a|nothing|-)\.?$/i.test(lead))
    .slice(0, 3);
}

/** Approach changes the host grants one check after its turn was stopped. */
export const MAX_APPROACH_ATTEMPTS = 3;

export type TurnStop =
  | { readonly kind: 'red-retry'; readonly command: string; readonly failures: number }
  | { readonly kind: 'no-progress'; readonly reads: number }
  | { readonly kind: 'over-budget'; readonly minutes: number };

/** Stops that earn a different-approach attempt; running out of time does not. */
export type RetryStop = Exclude<TurnStop, { readonly kind: 'over-budget' }>;

/**
 * Soft per-check time budget, derived from the run itself rather than fixed:
 * a check may use up to this many times its fair share (remaining
 * investigation time divided by the checks still to run). A slow model or a
 * deep project stretches every share equally; one check cannot starve the
 * rest.
 */
export const SOFT_BUDGET_FACTOR = 2;
/** A check is never cut below this, unless less than this is left. */
export const MIN_SOFT_BUDGET_MS = 8 * 60_000;
/** The short, tool-free-in-spirit turn that records a cut-off check's conclusion. */
export const WRAP_UP_MS = 4 * 60_000;

export function checkSoftBudgetMs(remainingMs: number, checksLeft: number): number {
  const share = Math.max(0, remainingMs) / Math.max(1, checksLeft);
  return Math.min(
    Math.max(0, remainingMs),
    Math.max(MIN_SOFT_BUDGET_MS, share * SOFT_BUDGET_FACTOR),
  );
}

export interface FailedAttempt {
  readonly command: string;
  readonly exitCode: number;
  readonly times: number;
}

/** Distinct failing commands of the turn, for the approach-change brief. */
export function failedCommandsSince(
  beforeKeys: ReadonlySet<string>,
  operations: ReadonlyMap<string, ObservedOperation>,
): FailedAttempt[] {
  const failed = new Map<string, { exitCode: number; times: number }>();
  for (const [key, op] of operations) {
    if (beforeKeys.has(key)) continue;
    if (typeof op.exitCode !== 'number' || op.exitCode === 0) continue;
    const raw = op.commandText?.trim();
    if (raw === undefined || raw.length === 0 || READ_ONLY_TOOL.test(op.toolName)) continue;
    const text = retryKey(raw);
    const entry = failed.get(text) ?? { exitCode: op.exitCode, times: 0 };
    entry.times += 1;
    entry.exitCode = op.exitCode;
    failed.set(text, entry);
  }
  return [...failed].map(([command, { exitCode, times }]) => ({
    command: command.slice(0, 300),
    exitCode,
    times,
  }));
}

/**
 * Live watchdog over ONE check turn: a stop is warranted when the same
 * command failed RED_RETRY_THRESHOLD times (retry-until-green) or the turn
 * is stuck reading (NO_PROGRESS_LIMIT read-only operations in a row).
 */
export function turnWatchdogStop(
  beforeKeys: ReadonlySet<string>,
  operations: ReadonlyMap<string, ObservedOperation>,
): TurnStop | undefined {
  const failures = new Map<string, number>();
  let reads = 0;
  for (const [key, op] of operations) {
    if (beforeKeys.has(key)) continue;
    if (READ_ONLY_TOOL.test(op.toolName)) {
      reads += 1;
      continue;
    }
    reads = 0;
    const raw = op.commandText?.trim();
    if (typeof op.exitCode !== 'number' || op.exitCode === 0) continue;
    if (raw === undefined || raw.length === 0) continue;
    const text = retryKey(raw);
    const count = (failures.get(text) ?? 0) + 1;
    if (count >= RED_RETRY_THRESHOLD) return { kind: 'red-retry', command: text, failures: count };
    failures.set(text, count);
  }
  return reads >= NO_PROGRESS_LIMIT ? { kind: 'no-progress', reads } : undefined;
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

/**
 * Last-resort report when the reporting stage cannot finish (deadline or
 * repeated invalid output) but investigation already banked work. The host
 * asserts NO findings and NO passes: every check is inconclusive (or not_run
 * when the agent never concluded it) and carries the agent's own closing
 * conclusion, labelled unverified, so the banked work is not thrown away
 * with a failed run.
 */
export function composeHostFallbackReport(
  plan: { plannedChecks: readonly string[] },
  operations: ReadonlyMap<string, ObservedOperation>,
  conclusions: readonly (string | undefined)[],
  reason: string,
): SentryAgentReportV2 {
  let executed = 0;
  let failed = 0;
  for (const op of operations.values()) {
    if (READ_ONLY_TOOL.test(op.toolName) || (op.commandText ?? '').length === 0) continue;
    executed += 1;
    if (typeof op.exitCode === 'number' && op.exitCode !== 0) failed += 1;
  }
  const concluded = plan.plannedChecks.filter((_, i) => (conclusions[i] ?? '').trim().length > 0);
  return {
    schemaVersion: 2,
    summary:
      'Host-composed partial report: ' +
      reason +
      ' The agent’s findings could not be serialized, so none are asserted here. ' +
      executed +
      ' command(s) ran (' +
      failed +
      ' non-zero); ' +
      concluded.length +
      ' of ' +
      plan.plannedChecks.length +
      ' planned check(s) reached a stated conclusion, shown below as unverified agent statements.',
    checks: plan.plannedChecks.map((name, i) => {
      const conclusion = (conclusions[i] ?? '').trim();
      return conclusion.length === 0
        ? {
            name,
            status: 'not_run' as const,
            details: 'Host: this check never reached a conclusion before the report stage failed.',
          }
        : {
            name,
            status: 'inconclusive' as const,
            coverage: 'partial' as const,
            details: (
              'Unverified agent conclusion (the report stage did not validate it): ' + conclusion
            ).slice(0, 5000),
          };
    }),
    hypotheses: [],
    evidence: [],
    findings: [],
    limitations: [
      'Host fallback: ' +
        reason +
        ' Any defect the agent may have found is described only in the per-check conclusions and is not a validated finding.',
    ],
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
    // Every cited key must exist in the host ledger (no invented citations), and at least
    // one must certify executable proof. Context the agent also cited (a source read, an
    // early probe that failed on a fixture error) neither adds to nor removes that proof.
    const executable =
      proof.length > 0 &&
      proof.every((op) => op !== undefined) &&
      proof.some((op) => op !== undefined && isExecutableProofOperation(op));
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
