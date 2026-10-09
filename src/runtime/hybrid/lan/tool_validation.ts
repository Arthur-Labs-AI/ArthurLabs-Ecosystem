/**
 * HR-03E: structural validation for the LAN tool transport.
 *
 * Network payload is untrusted structurally. These validators protect the
 * transport/adapter only: bounded ids, exact protocol version, safe
 * integers, valid ISO timestamps, plain-JSON args, and a structurally
 * sound ToolResult shape. They NEVER perform ToolRegistry JSON-schema
 * authorization validation - the caller's registry already validated the
 * exact snapshot, and the caller re-validates the result contract +
 * output_schema after remote execution.
 */

import { isArthurMode } from "../../../core/modes/mode";
import { LAN_MAX_BODY_BYTES, LAN_MAX_IDENTIFIER_CHARS } from "./validation";

export { LAN_MAX_BODY_BYTES };

export const LAN_TOOL_MAX_REQUEST_ID_CHARS = 128;
export const LAN_TOOL_MAX_VERSION_CHARS = 64;
export const LAN_TOOL_MAX_ID_CHARS = 256;
export const LAN_TOOL_MAX_SUMMARY_CHARS = 2000;
export const LAN_TOOL_MAX_DEPTH = 32;
export const LAN_TOOL_MAX_KEYS = 1024;

export interface ParsedToolExecuteRequest {
  requestId: string;
  toolVersion: string;
  toolDefinitionHash: string;
  executionId: string;
  attemptId: string;
  attemptNo: number;
  deadlineAt: string;
  sessionId: string;
  turnId: string;
  traceId: string;
  mode: string;
  args: Record<string, unknown>;
}

function bad(message: string): never {
  throw new Error("invalid tool request: " + message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertBoundedId(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value === "") bad(what + " must be a non-empty string");
  const text = value as string;
  if (text.length > max) bad(what + " exceeds the bound");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(text)) bad(what + " contains control characters");
  return text;
}

function assertJsonValue(value: unknown, what: string, depth: number): void {
  if (depth > LAN_TOOL_MAX_DEPTH) bad(what + " is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    if (value.length > LAN_TOOL_MAX_KEYS) bad(what + " array exceeds the bound");
    for (const item of value) assertJsonValue(item, what, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > LAN_TOOL_MAX_KEYS) bad(what + " object exceeds the bound");
    for (const key of keys) {
      if (key.length > LAN_MAX_IDENTIFIER_CHARS) bad(what + " key exceeds the bound");
      assertJsonValue((value as Record<string, unknown>)[key], what, depth + 1);
    }
    return;
  }
  bad(what + " must be JSON-compatible");
}

/** Parse + structurally validate the tool execute envelope (path id binds identity). */
export function parseLanToolExecuteRequest(raw: unknown): ParsedToolExecuteRequest {
  if (!isPlainObject(raw)) bad("envelope must be an object");
  if (raw["protocol_version"] !== 1) bad("unsupported protocol version");
  const requestId = assertBoundedId(raw["request_id"], "request_id", LAN_TOOL_MAX_REQUEST_ID_CHARS);
  const toolVersion = assertBoundedId(raw["tool_version"], "tool_version", LAN_TOOL_MAX_VERSION_CHARS);
  const toolDefinitionHash = raw["tool_definition_hash"];
  if (typeof toolDefinitionHash !== "string" || !/^[0-9a-f]{64}$/.test(toolDefinitionHash)) {
    bad("tool_definition_hash must be a 64-char hex digest");
  }
  const execution = raw["execution"];
  if (!isPlainObject(execution)) bad("execution must be an object");
  const executionId = assertBoundedId(execution["execution_id"], "execution_id", LAN_TOOL_MAX_REQUEST_ID_CHARS);
  const attemptId = assertBoundedId(execution["attempt_id"], "attempt_id", LAN_TOOL_MAX_REQUEST_ID_CHARS);
  const attemptNo = execution["attempt_no"];
  if (typeof attemptNo !== "number" || !Number.isSafeInteger(attemptNo) || attemptNo <= 0) {
    bad("attempt_no must be a positive safe integer");
  }
  const deadlineAt = execution["deadline_at"];
  if (typeof deadlineAt !== "string" || !Number.isFinite(Date.parse(deadlineAt))) bad("deadline_at must be a valid ISO timestamp");
  if ((deadlineAt as string).length > 64) bad("deadline_at exceeds the bound");
  const sessionId = assertBoundedId(execution["session_id"], "session_id", LAN_TOOL_MAX_REQUEST_ID_CHARS);
  const turnId = assertBoundedId(execution["turn_id"], "turn_id", LAN_TOOL_MAX_REQUEST_ID_CHARS);
  const traceId = assertBoundedId(execution["trace_id"], "trace_id", LAN_TOOL_MAX_REQUEST_ID_CHARS);
  const mode = execution["mode"];
  if (!isArthurMode(mode)) bad("mode must be a known Arthur mode");
  const args = execution["args"];
  if (!isPlainObject(args)) bad("args must be a plain JSON object");
  assertJsonValue(args, "args", 0);
  // Forbid security capability fields if a confused caller ever embeds them.
  for (const forbidden of ["authorization", "approvalToken", "approved", "approval_id", "signature"]) {
    if (Object.prototype.hasOwnProperty.call(execution, forbidden)) bad("execution carries a forbidden field");
    if (Object.prototype.hasOwnProperty.call(args, forbidden) && forbidden !== "approved") {
      // args values are domain data; only transport-level capability
      // objects are rejected here - an arg NAMED like a capability is
      // still domain data and passes (no semantic inspection).
      void forbidden;
    }
  }
  return {
    requestId,
    toolVersion: toolVersion as string,
    toolDefinitionHash: toolDefinitionHash as string,
    executionId,
    attemptId,
    attemptNo: attemptNo as number,
    deadlineAt: deadlineAt as string,
    sessionId,
    turnId,
    traceId,
    mode: mode as string,
    args: args as Record<string, unknown>,
  };
}

export interface ParsedToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** Structural defense for the remote ToolResult (caller re-validates fully). */
export function parseLanToolResult(raw: unknown): ParsedToolResult {
  if (!isPlainObject(raw)) bad("result must be a plain object");
  if (typeof raw["ok"] !== "boolean") bad("result.ok must be a boolean");
  if (typeof raw["summary"] !== "string") bad("result.summary must be a string");
  if ((raw["summary"] as string).length > LAN_TOOL_MAX_SUMMARY_CHARS) bad("result.summary exceeds the bound");
  if (raw["data"] !== undefined) assertJsonValue(raw["data"], "result.data", 0);
  const out: ParsedToolResult = { ok: raw["ok"] as boolean, summary: raw["summary"] as string };
  if (raw["data"] !== undefined) out.data = raw["data"];
  return out;
}
