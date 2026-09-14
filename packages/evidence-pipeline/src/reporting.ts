import type { ObservedOperation } from './pipeline.js';

/**
 * Shared reporting-stage protocol (Phase 4.2). All three AgentStacks use
 * these helpers so the frozen ledger format, confidence semantics, and
 * correction behavior are IDENTICAL across harnesses. Harness-specific
 * wording may differ; policy semantics must not.
 */

/** Maximum report attempts per AgentRun: initial + one correction. */
export const MAX_REPORT_ATTEMPTS = 2;

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

/** Bounded correction intro for report-only retries (§34). */
export function buildReportCorrectionIntro(errors: readonly string[]): string {
  const bounded = errors.slice(0, 8).map((error, index) => `${index + 1}. ${error}`);
  return (
    'Your report was rejected. Do not investigate further. Do not use tools. No new operations will be observed.\n' +
    'Correct these report issues:\n' +
    bounded.join('\n') +
    '\nUse ONLY the frozen ledger below. Return the complete corrected report.'
  );
}

/** Bound a raw validation message for correction feedback (redacted upstream). */
export function boundCorrectionMessage(message: string): string {
  return message.length > 500 ? message.slice(0, 500) + '…' : message;
}
