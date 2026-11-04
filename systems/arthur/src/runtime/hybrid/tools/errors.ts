/**
 * HR-03E: typed tool-attempt dispatch errors.
 *
 * A dispatch error describes what happened when ONE SC-03 attempt tried to
 * reach exactly one execution target (local private executor or one bound
 * LAN node). It is classified from typed evidence (pre/post dispatch,
 * wire code, transport stage) - never from '.message' text.
 *
 * The SingleAttemptExecutionService gates (validation, permissions, SC-02
 * final approval verification, attempt claim) all run BEFORE the invoker,
 * so a dispatch error can never mean "not authorized": authorization was
 * already granted locally. The failure contract below only tells SC-03 how
 * to persist/retry the attempt outcome.
 */

export type DispatchFailureKind = "transient" | "permanent" | "timeout" | "cancelled" | "protocol";

export type DispatchOutcomeEvidence = "not_applied" | "unknown";

export const DISPATCH_ERROR_CODES = [
  "NO_ELIGIBLE_TOOL_NODE",
  "LOCAL_NODE_MISMATCH",
  "REMOTE_TOOL_BINDING_MISSING",
  "TOOL_EXECUTOR_NOT_FOUND",
  "TOOL_CONTRACT_MISMATCH",
  "TOOL_EXECUTOR_FAILED",
  "TOOL_EXECUTOR_TIMEOUT",
  "TOOL_EXECUTOR_CANCELLED",
  "TOOL_OUTPUT_INVALID",
  "LAN_UNAUTHORIZED",
  "LAN_PROTOCOL",
  "LAN_TRANSPORT",
  "LAN_TIMEOUT",
  "LAN_CANCELLED",
  "INTERNAL_ERROR",
] as const;

export type DispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[number];

export function isDispatchErrorCode(value: unknown): value is DispatchErrorCode {
  return typeof value === "string" && (DISPATCH_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Typed dispatch failure for exactly one SC-03 attempt dispatch.
 *
 * failure_kind: SC-03-level classification hint (maps into
 *   classifyExecutorError without message regexes).
 * outcome_evidence: whether the target provably never started
 *   ("not_applied") or may have started ("unknown"). Mutations with
 *   "unknown" quarantine as OUTCOME_UNKNOWN; "not_applied" keeps the
 *   existing conservative mutation retry policy.
 * code: bounded machine-readable dispatch code.
 */
export class AttemptDispatchError extends Error {
  readonly failureKind: DispatchFailureKind;
  readonly outcomeEvidence: DispatchOutcomeEvidence;
  readonly dispatchCode: DispatchErrorCode;

  constructor(
    failureKind: DispatchFailureKind,
    outcomeEvidence: DispatchOutcomeEvidence,
    code: DispatchErrorCode,
    detail: string,
  ) {
    super("tool dispatch failed: " + code);
    this.name = "AttemptDispatchError";
    this.failureKind = failureKind;
    this.outcomeEvidence = outcomeEvidence;
    this.dispatchCode = code;
    // Keep the human detail out of the message: SC-03 persists summaries
    // with bounds, and messages must never become classification inputs.
    // The generic message above is stable; detail travels as 'cause'.
    (this as { detail?: string }).detail = detail;
    // Compat: SingleAttemptExecutionService copies err.code into the
    // failure record; expose the bounded dispatch code there too.
    (this as unknown as { code: string }).code = code;
  }
}

export function isAttemptDispatchError(value: unknown): value is AttemptDispatchError {
  return value instanceof AttemptDispatchError;
}
