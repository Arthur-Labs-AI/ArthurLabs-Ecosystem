/**
 * Persistence record shapes (spec section 9; audit MEDIUM 6 / HIGH 3-4).
 */

import type { ArthurMode } from "../core/modes/mode";
import type { ToolRisk } from "../tools/contracts";

export interface SessionRecord {
  id: string;
  mode: ArthurMode;
  created_at: string;
  updated_at: string;
  status: string;
}

export type TurnRole = "user" | "assistant" | "system" | "tool";

export interface TurnRecord {
  id: string;
  session_id: string;
  role: TurnRole;
  text: string;
  created_at: string;
  trace_id: string;
  status: string;
  /** Mode active when the turn was created; used for mode-partitioned history. */
  mode: ArthurMode;
}

export interface ModelCallRecord {
  id: string;
  turn_id: string;
  provider: string;
  model: string;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  status: string;
  provider_request_id?: string;
  created_at: string;
}

export type ToolCallStatus =
  | "completed"
  | "pending_approval"
  | "rejected"
  | "failed"
  | "executing"
  | "cancelled"
  | "timed_out"
  | "outcome_unknown";

export interface ToolCallRecord {
  id: string;
  turn_id: string;
  tool_name: string;
  arguments_json: string;
  risk_level: ToolRisk;
  status: ToolCallStatus;
  result_summary?: string;
  created_at: string;
  updated_at: string;
  /** SC-06 §15-18: model-provider protocol correlation id. Distinct from the
   * server-generated durable `id` (ARTHUR tool_call_id). NULL on pre-SC-06
   * rows. Never authority for execution/approval — correlation only. */
  provider_call_id?: string | null;
  /** SC-06 §9/§92: 1-based model round that proposed this call. */
  round_no?: number | null;
  /** SC-06 §9/§92: 1-based sequence within its round (model order). */
  sequence_no?: number | null;
  /**
   * Increment 3.1 exact semantic invocation identity: SHA-256 over JCS of
   * {tool_name, exact JSON-safe proposal arguments} — computed BEFORE any
   * sanitization/redaction. NULL on pre-3.1 rows. Correlation/dedupe key
   * only; never authorization.
   */
  invocation_fingerprint?: string | null;
}

/** SC-06 §7 durable loop states (subset needed for Increment 2). */
export type ConversationLoopState =
  | "CREATED"
  | "MODEL_RUNNING"
  | "ROUND_READY"
  | "TOOL_EXECUTING"
  | "WAITING_APPROVAL"
  | "RESUMING"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "LIMIT_REACHED";

/**
 * SC-06 §90-91 durable loop journal row. Canonical record of one user turn's
 * model/tool decision sequence. Stores ONLY operational continuation
 * metadata — never chain-of-thought, provider reasoning, full prompts, or
 * raw unbounded tool payloads (§93-94).
 */
export interface ConversationLoopRecord {
  id: string;
  turn_id: string;
  session_id: string;
  mode: ArthurMode;
  state: ConversationLoopState;
  current_round: number;
  model_calls_used: number;
  tool_calls_used: number;
  active_runtime_ms: number;
  waiting_approval_id?: string | null;
  last_batch_fingerprint?: string | null;
  /** §6/§14: frozen turn identity for resume validation. */
  trace_id: string;
  client_request_id: string;
  /** §60-61 remaining budgets snapshot (authoritative numbers, not config). */
  budgets_json: string;
  /** §15: bounded tool-schema snapshot identity for drift detection. */
  tool_schema_fingerprint?: string | null;
  /** §16: bounded compact transcript (operational entries only). */
  transcript_json?: string | null;
  /** Increment 3 §50-51: bounded JSON array of rejected invocation fingerprints. */
  rejected_fingerprints?: string | null;
  /** Increment 3 §57-58: consecutive identical-batch repeat count. */
  consecutive_repeats?: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * SC-06 §95-96 compact transcript entry: operational continuation metadata
 * only (protocol entries, names, canonical args, statuses, bounded safe
 * summaries, round grouping). No rich file contents / patches / reasoning.
 */
export interface LoopTranscriptEntry {
  round_no: number;
  sequence_no: number;
  provider_call_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments_json: string;
  status: string;
  result_summary?: string;
  /** Increment 3 absorption kind (absent for executed calls). */
  note?: "already_completed" | "previously_rejected" | "deferred_by_approval";
}

export type ApprovalStatus =
  | "pending"
  | "executing"
  | "approved"
  | "rejected"
  | "failed"
  | "expired"
  | "invalidated";

export type ApprovalDecisionChannel = "cli" | "voice" | "web" | "desktop" | "mobile" | "api";

export interface ApprovalRecord {
  id: string;
  turn_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments_json: string;
  arguments_hash: string;
  risk_level: ToolRisk;
  status: ApprovalStatus;
  expires_at: string;
  created_at: string;
  /** ISO timestamp set when the approval atomically transitions pending -> executing. */
  claimed_at?: string;
  /** SC-03 section 13: set exactly once when the approval is atomically consumed
   * and bound to its single execution. NULL = never consumed. */
  consumed_at?: string | null;
  resolved_at?: string;
  /** SC-02 Approval Binding v2 fields (nullable on pre-v2 rows). */
  binding_version?: number;
  mode?: string;
  tool_version?: string;
  tool_definition_hash?: string;
  presentation_json?: string;
  presentation_hash?: string;
  authorization_digest?: string;
  signing_key_id?: string;
  invalidated_reason?: string;
  decision_channel?: string;
}

export type ExecutionRecordStatus =
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

export interface ToolExecutionRow {
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
  state: ExecutionRecordStatus;
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
  reconciliation_required: number;
  /** SC-03 section 79: validated bounded structured result (bounded_json tools
   * only; NULL for summary_only). Sanitized, JSON-safe, size-bounded. */
  result_data_json?: string | null;
}

export type AttemptRecordStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "outcome_unknown";

export interface ToolExecutionAttemptRow {
  id: string;
  execution_id: string;
  attempt_no: number;
  runtime_instance_id: string;
  started_at: string;
  finished_at?: string | null;
  state: AttemptRecordStatus;
  failure_kind?: string | null;
  effect_outcome?: string | null;
  error_code?: string | null;
  error_summary?: string | null;
}

export type IdempotencyStatus = "in_progress" | "completed" | "failed";

export interface IdempotencyRecord {
  client_request_id: string;
  request_hash: string;
  session_id?: string;
  turn_id?: string;
  status: IdempotencyStatus;
  response_json?: string;
  created_at: string;
  updated_at: string;
}
