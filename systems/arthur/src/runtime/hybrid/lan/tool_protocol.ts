/**
 * HR-03E: versioned LAN tool execution protocol (TOOL TRANSPORT ONLY).
 *
 * Additive endpoint on the existing HR-03D LAN runtime:
 *
 *   POST /v1/runtime/tools/{tool_id}/execute
 *
 * Tool identity comes from the URL path; a body field never overrides it.
 * Envelopes carry protocol_version (no silent downgrade) and an opaque
 * per-attempt request_id for transport correlation. The durable SC-03
 * identity (execution_id / attempt_id / attempt_no / deadline_at) travels
 * verbatim in the execution block; the remote host must not mint
 * replacements. request_id is transport correlation only.
 */

import { ARTHUR_LAN_PROTOCOL_VERSION } from "./protocol";

export { ARTHUR_LAN_PROTOCOL_VERSION };

export const LAN_TOOL_EXECUTE_PREFIX = "/v1/runtime/tools/";
export const LAN_TOOL_EXECUTE_SUFFIX = "/execute";

export function lanToolExecutePath(toolId: string): string {
  return LAN_TOOL_EXECUTE_PREFIX + encodeURIComponent(toolId) + LAN_TOOL_EXECUTE_SUFFIX;
}

export interface LanToolExecutionBlock {
  execution_id: string;
  attempt_id: string;
  attempt_no: number;
  deadline_at: string;
  session_id: string;
  turn_id: string;
  trace_id: string;
  mode: string;
  args: Record<string, unknown>;
}

export interface LanToolExecuteRequest {
  protocol_version: number;
  request_id: string;
  tool_version: string;
  tool_definition_hash: string;
  execution: LanToolExecutionBlock;
}

export interface LanToolExecuteResponse {
  protocol_version: number;
  request_id: string;
  result: unknown;
}

export type ToolWireErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "TOOL_EXECUTOR_NOT_FOUND"
  | "TOOL_CONTRACT_MISMATCH"
  | "TOOL_EXECUTOR_FAILED"
  | "TOOL_EXECUTOR_TIMEOUT"
  | "TOOL_EXECUTOR_CANCELLED"
  | "TOOL_OUTPUT_INVALID"
  | "INTERNAL_ERROR";

export const TOOL_WIRE_ERROR_CODES: readonly ToolWireErrorCode[] = [
  "UNAUTHORIZED",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "TOOL_EXECUTOR_NOT_FOUND",
  "TOOL_CONTRACT_MISMATCH",
  "TOOL_EXECUTOR_FAILED",
  "TOOL_EXECUTOR_TIMEOUT",
  "TOOL_EXECUTOR_CANCELLED",
  "TOOL_OUTPUT_INVALID",
  "INTERNAL_ERROR",
];

export function isToolWireErrorCode(value: unknown): value is ToolWireErrorCode {
  return typeof value === "string" && (TOOL_WIRE_ERROR_CODES as readonly string[]).includes(value);
}

export interface LanToolErrorBody {
  protocol_version: number;
  request_id: string;
  error: { code: ToolWireErrorCode; outcome_evidence?: "not_applied" | "unknown" };
}
