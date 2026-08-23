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

export type ToolCallStatus = "completed" | "pending_approval" | "rejected" | "failed" | "executing";

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

export type ApprovalStatus = "pending" | "executing" | "approved" | "rejected" | "failed" | "expired";

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
  resolved_at?: string;
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
