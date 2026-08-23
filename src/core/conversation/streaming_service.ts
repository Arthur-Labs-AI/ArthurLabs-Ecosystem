/**
 * Streaming conversation extension (Phase 3 spec sections 15, 16, 30).
 *
 * NOT a second conversation core: this module defines the streaming turn
 * event vocabulary and a thin adapter used by the voice controller. The
 * authoritative ConversationService.streamTurn() performs the same
 * validation, session/mode checks, sanitization, tool orchestration and
 * persistence as the text path - voice text enters the SAME service.
 */

import type { ArthurMode } from "../modes/mode";
import type { ProposedToolCall } from "../../models/contracts";
import type { TokenUsage } from "../../observability/usage";
import type { ToolCallSummary, TurnStatus } from "./models";

export type StreamingTurnEvent =
  | {
      type: "turn_started";
      session_id: string;
      turn_id: string;
      trace_id: string;
      mode: ArthurMode;
    }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ProposedToolCall }
  | {
      type: "approval_required";
      approvals: Array<{ approval_id: string; tool_name: string }>;
    }
  | { type: "usage"; usage: TokenUsage }
  | {
      type: "turn_completed";
      session_id: string;
      turn_id: string;
      trace_id: string;
      mode: ArthurMode;
      status: TurnStatus;
      display_text: string;
      tool_calls: ToolCallSummary[];
      usage?: TokenUsage;
    }
  | {
      type: "turn_interrupted";
      session_id: string;
      turn_id: string;
      trace_id: string;
      mode: ArthurMode;
      partial_text: string;
    }
  | {
      type: "turn_failed";
      session_id: string;
      turn_id: string;
      trace_id: string;
      mode: ArthurMode;
      code: string;
      message: string;
    };
