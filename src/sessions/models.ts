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
