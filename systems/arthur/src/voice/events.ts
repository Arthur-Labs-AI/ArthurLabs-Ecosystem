/**
 * Voice events (Phase 3 spec section 23).
 *
 * ARTHUR -> Client events mirror the realtime protocol exactly. Controller
 * internal events are the same union - the realtime channel forwards them
 * verbatim, so there is one event vocabulary everywhere.
 */

import type { ArthurMode } from "../core/modes/mode";
import { VoiceErrorCode, VoiceSession, VoiceState } from "./contracts";

/** ARTHUR -> client events (realtime protocol, spec section 23). */
export type VoiceClientEvent =
  | { type: "voice.state"; state: VoiceState; reason?: string; session_id: string; ts: string }
  | { type: "voice.session"; session: VoiceSession; ts: string }
  | { type: "wake.detected"; provider: string; latency_ms?: number; ts: string }
  | { type: "stt.partial"; utterance_id: string; text: string; ts: string }
  | { type: "stt.final"; utterance_id: string; text: string; confidence?: number; ts: string }
  | { type: "assistant.text.delta"; turn_id: string; text: string; ts: string }
  | { type: "assistant.speech.started"; turn_id: string; ts: string }
  | { type: "assistant.speech.ended"; turn_id: string; ts: string }
  | { type: "assistant.turn.completed"; turn_id: string; status: string; ts: string }
  | {
      type: "approval.required";
      approval_id: string;
      tool_name: string;
      session_id: string;
      /** Number of currently pending (unambiguous) approvals for this session. */
      pending_count: number;
      ts: string;
    }
  | { type: "approval.ambiguous"; session_id: string; pending_count: number; ts: string }
  | { type: "approval.outcome"; approval_id: string; status: string; result_summary?: string; ts: string }
  | { type: "voice.error"; code: VoiceErrorCode; message: string; component?: string; ts: string };

/** Client -> ARTHUR commands (realtime protocol, spec section 23). */
export type VoiceClientCommand =
  | { type: "voice.enable"; arthur_session_id?: string }
  | { type: "voice.disable" }
  | { type: "voice.ptt.start" }
  | { type: "voice.ptt.stop" }
  | { type: "voice.interrupt" }
  | { type: "voice.set_device"; input_device_id?: string; output_device_id?: string }
  | { type: "voice.set_session"; arthur_session_id: string }
  | { type: "voice.mode"; mode: ArthurMode }
  | { type: "voice.answer_approval"; approve: boolean };

export function voiceEventTs(now: number): string {
  return new Date(now).toISOString();
}
