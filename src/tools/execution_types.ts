/**
 * Durable execution record shapes + trusted failure contract (SC-03 sections
 * 15-21, 27-31, 74-77). Raw secrets are never persisted; only bounded safe
 * summaries and result metadata cross the persistence boundary.
 */

export type ExecutionState =
  | "ready"
  | "running"
  | "retry_wait"
  | "cancel_requested"
  | "reconciling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "outcome_unknown";

export type AttemptState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "outcome_unknown";

export type ExecutionFailureKind =
  | "transient"
  | "permanent"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "output_invalid";

export type EffectOutcome = "not_applied" | "applied" | "unknown";

export interface ExecutionFailure {
  kind: ExecutionFailureKind;
  effect_outcome: EffectOutcome;
  retry_hint: boolean;
  code: string;
  summary: string;
}

export interface ToolExecutionRecord {
  id: string;
  tool_call_id: string;
  approval_id?: string | null;
  session_id: string;
  turn_id: string;
  mode: string;
  tool_name: string;
  tool_version: string;
  tool_definition_hash: string;
  arguments_hash: string;
  state: ExecutionState;
  attempt_count: number;
  max_attempts: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  deadline_at: string;
  next_attempt_at?: string | null;
  cancel_requested_at?: string | null;
  result_summary?: string | null;
  last_error_code?: string | null;
  last_error_summary?: string | null;
  runtime_instance_id?: string | null;
  reconciliation_required: boolean;
}

export interface ToolExecutionAttemptRecord {
  id: string;
  execution_id: string;
  attempt_no: number;
  runtime_instance_id: string;
  started_at: string;
  finished_at?: string | null;
  state: AttemptState;
  failure_kind?: ExecutionFailureKind | null;
  effect_outcome?: EffectOutcome | null;
  error_code?: string | null;
  error_summary?: string | null;
}

export type ToolReconcileVerdict = "succeeded" | "failed" | "still_running" | "not_applied" | "unknown";

/**
 * Read-only reconciler (SC-03 sections 53-55): asks what happened to operation
 * executionId, never mutates. The interface exposes ONLY the query: no executor
 * handle, no store/DB access, no mutation API crosses this boundary, so a
 * reconciler cannot repeat the mutation, start a replacement job, or repair
 * state externally even adversarially (doing so would be a new execution).
 * The coordinator additionally never invokes executors during reconcile().
 */
export interface ToolReconciler {
  reconcile(executionId: string): Promise<ToolReconcileVerdict>;
}

export const EXECUTION_TERMINAL_STATES: readonly ExecutionState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

export function isTerminalExecutionState(state: ExecutionState): boolean {
  return (EXECUTION_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Trusted classification of an executor boundary failure. Unknown JS errors
 * are non-retryable by default (SC-03 section 26); only side-effect-free
 * operations with an explicit transient policy may safely retry.
 */
export function classifyExecutorError(err: unknown, effects: "none" | "mutation"): ExecutionFailure {
  const raw = err instanceof Error ? err.message : String(err ?? "tool execution failed");
  const summary = raw.length > 500 ? raw.slice(0, 500) + "\u2026(truncated)" : raw;
  const code = (err as { code?: unknown } | null) !== null && typeof (err as { code?: unknown }).code === "string"
    ? String((err as { code?: string }).code)
    : "TOOL_EXECUTION_FAILED";
  const lowered = raw.toLowerCase();
  if (/\bcancel/i.test(raw) || /abort/i.test(raw)) {
    return { kind: "cancelled", effect_outcome: effects === "mutation" ? "unknown" : "not_applied", retry_hint: false, code: "TOOL_CANCELLED", summary };
  }
  if (/\btimeout\b|\btimed out\b|deadline/i.test(lowered)) {
    return { kind: "timeout", effect_outcome: effects === "mutation" ? "unknown" : "not_applied", retry_hint: effects !== "mutation", code: "TOOL_TIMEOUT", summary };
  }
  if (/tool_output_invalid|output_schema|invalid output/i.test(raw)) {
    return {
      kind: "output_invalid",
      effect_outcome: effects === "mutation" ? "unknown" : "not_applied",
      retry_hint: false,
      code: "TOOL_OUTPUT_INVALID",
      summary,
    };
  }
  if (/econn|etimedout|enotfound|eai_again|socket hang up|network|503|502|429|temporar|transient|unavailable/i.test(lowered)) {
    return {
      kind: "transient",
      effect_outcome: effects === "mutation" ? "unknown" : "not_applied",
      retry_hint: effects !== "mutation",
      code: "TOOL_EXECUTION_FAILED",
      summary,
    };
  }
  if (/tool_argument_invalid|tool_permission_denied|approval|invalid|not found|not permitted|forbidden|rejected/i.test(raw)) {
    return { kind: "permanent", effect_outcome: "not_applied", retry_hint: false, code, summary };
  }
  return { kind: "permanent", effect_outcome: effects === "mutation" ? "unknown" : "not_applied", retry_hint: false, code, summary };
}

/** Safe execution status view (SC-03 section 71): never secrets, keys, env, or stacks. */
export interface ExecutionStatusView {
  execution_id: string;
  tool_call_id: string;
  tool: { name: string; version: string };
  state: string;
  attempt_count: number;
  created_at: string;
  started_at?: string | null;
  deadline_at: string;
  can_cancel: boolean;
  reconciliation_required: boolean;
}
