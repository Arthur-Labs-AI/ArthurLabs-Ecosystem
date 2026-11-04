/**
 * Conversation domain objects (spec sections 6.2, 6.3, 9).
 */

import type { ArthurMode } from "../modes/mode";

export type ClientType = "cli" | "desktop" | "mobile" | "web" | "voice";

export interface TurnRequest {
  session_id?: string;
  mode: ArthurMode;
  message: string;
  client_request_id: string;
  metadata?: {
    client_type?: ClientType;
  };
}

export type TurnStatus = "completed" | "needs_approval" | "failed" | "interrupted";

export interface ToolCallSummary {
  tool_call_id: string;
  name: string;
  risk: string;
  status: "completed" | "pending_approval" | "rejected" | "failed" | "cancelled" | "timed_out" | "outcome_unknown";
  result_summary?: string;
  approval_id?: string;
  /** SC-03 durable execution identity (present once an execution exists). */
  execution_id?: string;
  /** SC-06 loop round/sequence for observability/client debugging (§116). */
  round?: number;
  sequence?: number;
  /**
   * Increment 3 loop note (additive): how a non-dispatched call was
   * absorbed pre-execution — already_completed (F24), previously_rejected
   * (F23 anti-nag), deferred_by_approval (F19). Status union stays frozen;
   * absorbed calls reuse completed/rejected with the note attached.
   */
  note?: "already_completed" | "previously_rejected" | "deferred_by_approval";
}

export interface TurnResponseModel {
  provider: string;
  model: string;
  /** SC-06 §117-118: total active latency across all model rounds in the turn. */
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  /** SC-06 §117-118: number of model calls aggregated into this turn total. */
  calls?: number;
}

export interface TurnResponse {
  session_id: string;
  turn_id: string;
  trace_id: string;
  mode: ArthurMode;
  speech_text: string;
  display_text: string;
  status: TurnStatus;
  tool_calls: ToolCallSummary[];
  model: TurnResponseModel;
}

export interface SessionTurnView {
  id: string;
  role: string;
  text: string;
  created_at: string;
  status: string;
  /** Mode active when the turn was created (mode-partitioned history). */
  mode: ArthurMode;
}

export interface SessionSummary {
  id: string;
  mode: ArthurMode;
  created_at: string;
  updated_at: string;
  status: string;
  turns: SessionTurnView[];
}

export interface ModeChangeResult {
  session_id: string;
  from: ArthurMode;
  to: ArthurMode;
}

export interface ApprovalOutcome {
  approval_id: string;
  tool_name: string;
  status: "approved" | "rejected" | "already_resolved";
  tool_call_id?: string;
  result_summary?: string;
  /** SC-03: the durable execution bound to this approval (when created). */
  execution_id?: string;
  /**
   * SC-06 §8 resume continuation (present only when a journaled loop won the
   * single-flight resume and ran post-decision model rounds). The resumed
   * assistant text + status persist as a NEW assistant turn; tool_calls
   * aggregates ALL turn rounds (pre- + post-decision).
   */
  resumed?: boolean;
  loop_id?: string;
  continuation_text?: string;
  continuation_status?: TurnStatus;
  continuation_tool_calls?: ToolCallSummary[];
}