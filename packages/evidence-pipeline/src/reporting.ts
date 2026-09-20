import type { ObservedOperation } from './pipeline.js';

/**
 * Shared reporting-stage protocol (Phase 4.2). All three AgentStacks use
 * these helpers so the frozen ledger format, confidence semantics, and
 * correction behavior are IDENTICAL across harnesses. Harness-specific
 * wording may differ; policy semantics must not.
 */

/** Maximum report attempts per AgentRun: initial + one correction. */
export const MAX_REPORT_ATTEMPTS = 2;

/** Maximum planning attempts per AgentRun: initial + one correction.
 *  Planning suffers the same prose-first variance as reporting; a failed
 *  plan parse retries once in the same session with bounded feedback.
 *  Safe: the ledger is not frozen yet and planning ops stay valid. */
export const MAX_PLANNING_ATTEMPTS = 2;

/** Bounded planning-correction prompt: schema/parse errors plus the
 *  output contract reminder. Same session; investigation not started. */
export function buildPlanningCorrectionIntro(errors: readonly string[]): string {
  const bounded = errors.slice(0, 8).map((error, index) => `${index + 1}. ${error}`);
  return (
    'Your plan was rejected. Return ONLY the JSON investigation plan, using the schema already given.\n' +
    'Correct these plan issues:\n' +
    bounded.join('\n') +
    '\nNo Markdown. No code fences. No preamble or commentary. ' +
    'The first character is { and the last character is }.'
  );
}

/**
 * Phase-scoped model-turn options (same shape for every harness session).
 * `tools: 'none'` marks a tool-free reporting turn; harnesses without a
 * native empty-tools mechanism enforce it with an adapter-side firewall.
 */
export interface ReportTurnOptions {
  readonly phase: 'planning' | 'investigation' | 'reporting';
  readonly tools: 'normal' | 'none';
  /** Provider structured-output schema hint (GLM `--json-schema`); undefined when unsupported. */
  readonly outputSchema?: Record<string, unknown>;
}

/** Render the frozen post-investigation ledger (§8 format). */
export function renderFrozenLedger(operations: ReadonlyMap<string, ObservedOperation>): string {
  if (operations.size === 0) return '(no operations observed)';
  return [...operations.values()]
    .map(
      (op) =>
        `${op.operationKey}\n` +
        `tool: ${op.toolName}\n` +
        `target: ${op.commandText ?? op.argsText ?? '(no target)'}\n` +
        `exit: ${op.exitCode === undefined ? 'unknown' : op.exitCode}\n` +
        `testOperation: ${op.isTestOperation}`,
    )
    .join('\n\n');
}

/** Uniform confidence semantics for every reporting prompt (§32). */
export const REPORT_CONFIDENCE_CALIBRATION =
  'Calibrate confidence with identical semantics: confirmed requires genuinely reproduced or operation-grounded proof; ' +
  'strong requires grounded source or operation evidence; probable means credible evidence exists but not enough for strong; ' +
  'speculative means a plausible concern with weak or manual evidence. ' +
  'You may downgrade your own confidence or remove an unsupported finding. ' +
  'Code references and manual reasoning alone support strong at most, never confirmed.';

/** Uniform ledger-authority rules for every reporting prompt (§9). */
export const REPORT_LEDGER_RULES =
  'The ledger below is the ONLY authoritative source of Sentry operation keys and observed command exit codes. ' +
  'Never invent operation keys. Never guess exit codes. Never reconstruct numbering from memory. ' +
  'Never combine several commands into a mega-command unless that exact command exists in the ledger. ' +
  'If exit is unknown, it is unknown: do not use an unknown-code operation as reproduced command or test proof requiring a known outcome. ' +
  'If adequate operation proof does not exist, use code_reference or manual evidence and calibrate confidence accordingly.';

/** Compact report-envelope schema for reporting prompts: checks,
 *  hypotheses, findings, and limitations shapes the evidence contract
 *  does not cover. Rendered from the same ReportV2 source the parser
 *  validates (field names fixed; bounds match the Zod schema). */
export const REPORT_ENVELOPE_SCHEMA =
  'Report envelope (exact shapes; copy names exactly): ' +
  '{"schemaVersion":2,"summary":string,"checks":[{"name":string,"status":"passed|failed|inconclusive|not_run","details"?:string}],' +
  '"hypotheses":[{"title":string,"rationale":string,"relatedPaths":string[],"plannedChecks":string[at least one]}],' +
  '"evidence":[<see Evidence variants above>],' +
  '"findings":[{"title":string,"category":string,"categoryDetail"?:string,"severity":"critical|high|medium|low|info",' +
  '"confidence":"confirmed|strong|probable|speculative","description":string,' +
  '"expectedBehavior"?:string,"actualBehavior"?:string,' +
  '"locations":[{"relativePath":string,"lineStart"?:number,"lineEnd"?:number,"symbol"?:string}][at least one],' +
  '"evidenceKeys":string[at least one],"reproductionSteps":string[] (always include, [] allowed),' +
  '"rootCause"?:string,"recommendedFix"?:string}],"limitations":string[]}. ' +
  'Every evidence relativePath and findings[].locations[].relativePath MUST identify an existing regular file inside the workspace; ' +
  'never a directory, glob, or missing path. If investigation identified only a directory, cite a concrete file actually inspected inside it, ' +
  'or omit unsupported evidence and findings rather than inventing a path.';

/** Evidence strength/type compatibility matrix: a strength label must
 *  never manufacture provenance. Appended to the correction intro when
 *  the rejection concerns strength, so a weaker model gets the rule
 *  instead of just the violation. */
export const REPORT_STRENGTH_COMPATIBILITY =
  'Evidence strength/type compatibility (exact rule): ' +
  "manual evidence (your own reasoning notes) allows ONLY 'weak' or 'speculative' strength; " +
  "code_reference evidence allows 'weak', 'speculative', or 'strong_code_evidence' (never reproduced_*); " +
  "'reproduced_failure'/'reproduced_behavior' require a tool/test operation from the frozen ledger; " +
  "'tool_diagnostic' requires a ledger operation with a known outcome. " +
  'When in doubt, downgrade the strength or drop the evidence item — a weaker honest report passes; an overclaimed one is rejected.';

/** Bounded correction intro for report-only retries (§34). */
export function buildReportCorrectionIntro(errors: readonly string[]): string {
  const bounded = errors.slice(0, 8).map((error, index) => `${index + 1}. ${error}`);
  const needsMatrix = errors.some((error) => /strength/i.test(error));
  return (
    'Your report was rejected. Do not investigate further. Do not use tools. No new operations will be observed.\n' +
    'Correct these report issues:\n' +
    bounded.join('\n') +
    (needsMatrix ? '\n' + REPORT_STRENGTH_COMPATIBILITY : '') +
    '\nUse ONLY the frozen ledger below. Return the complete corrected report.'
  );
}

/** Bound a raw validation message for correction feedback (redacted upstream). */
export function boundCorrectionMessage(message: string): string {
  return message.length > 500 ? message.slice(0, 500) + '…' : message;
}
