/**
 * Conversation domain objects (spec sections 6.2, 6.3, 9).
 */

import type { ArthurMode } from "../modes/mode";

export type ClientType = "cli" | "desktop" | "mobile" | "web";

export interface TurnRequest {
  session_id?: string;
  mode: ArthurMode;
  message: string;
  client_request_id: string;
  metadata?: {
    client_type?: ClientType;
  };
}

export type TurnStatus = "completed" | "needs_approval" | "failed";

export interface ToolCallSummary {
  tool_call_id: string;
  name: string;
  risk: string;
  status: "completed" | "pending_approval" | "rejected";
  result_summary?: string;
  approval_id?: string;
}

export interface TurnResponseModel {
  provider: string;
  model: string;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
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
}
