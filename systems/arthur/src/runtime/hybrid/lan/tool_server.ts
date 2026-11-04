/**
 * HR-03E: LAN tool execution host support (remote side).
 *
 * The LAN runtime authenticates the CALLING ARTHUR CORE and then checks
 * only: protocol validity, exact hosted capability identity, exact
 * contract identity (tool_id + version + definition hash), and structural
 * request validity. Then it executes the bound adapter. It never
 * re-authorizes: no PermissionService, no approvals, no SC-02/SC-03 state.
 *
 * Pre-dispatch failures (auth, malformed, unknown tool, contract
 * mismatch) carry outcome_evidence not_applied - the raw executor never
 * started. Once the raw executor starts, every later failure (throw,
 * timeout, cancel, malformed result, lost response) is unknown.
 */

import type { ToolExecutionContext, ToolResult } from "../../../tools/contracts";
import { ARTHUR_LAN_PROTOCOL_VERSION, LAN_TOOL_EXECUTE_PREFIX, LAN_TOOL_EXECUTE_SUFFIX, type LanToolErrorBody, type ToolWireErrorCode } from "./tool_protocol";
import { LAN_JSON_CONTENT_TYPE } from "./protocol";
import { LAN_MAX_BODY_BYTES } from "./validation";
import { parseLanToolExecuteRequest, parseLanToolResult } from "./tool_validation";
import type { ToolExecutorBindings } from "./tool_bindings";
import type { LanHttpRequest, LanHttpResponse } from "./server";

export function matchToolRoute(path: string): { toolId: string } | undefined {
  const clean = path.split("?", 1)[0] as string;
  if (!clean.startsWith(LAN_TOOL_EXECUTE_PREFIX) || !clean.endsWith(LAN_TOOL_EXECUTE_SUFFIX)) return undefined;
  const encoded = clean.slice(LAN_TOOL_EXECUTE_PREFIX.length, clean.length - LAN_TOOL_EXECUTE_SUFFIX.length);
  if (encoded === "") return undefined;
  let toolId: string;
  try {
    toolId = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (toolId === "" || toolId.includes("/")) return undefined;
  return { toolId };
}

export function toolStatusFor(code: ToolWireErrorCode): number {
  if (code === "UNAUTHORIZED") return 401;
  if (code === "TOOL_EXECUTOR_NOT_FOUND") return 404;
  if (code === "INVALID_REQUEST" || code === "UNSUPPORTED_PROTOCOL_VERSION" || code === "TOOL_CONTRACT_MISMATCH") return 400;
  if (code === "TOOL_EXECUTOR_TIMEOUT") return 504;
  if (code === "TOOL_EXECUTOR_CANCELLED") return 499;
  if (code === "TOOL_OUTPUT_INVALID" || code === "TOOL_EXECUTOR_FAILED") return 502;
  return 500;
}

export function toolErrorBody(requestId: string, code: ToolWireErrorCode, outcome: "not_applied" | "unknown"): LanToolErrorBody {
  return { protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: requestId, error: { code, outcome_evidence: outcome } };
}

function readBoundedBody(body: AsyncIterable<Uint8Array>, limit: number): Promise<{ ok: true; bytes: Buffer } | { ok: false }> {
  return (async () => {
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      total += buf.length;
      if (total > limit) return { ok: false as const };
      parts.push(buf);
    }
    return { ok: true as const, bytes: Buffer.concat(parts) };
  })();
}

function jsonResponse(res: LanHttpResponse, status: number, body: unknown): void {
  if (res.ended) return;
  res.writeHead(status, { "content-type": LAN_JSON_CONTENT_TYPE });
  res.end(JSON.stringify(body));
}

function preDispatchError(res: LanHttpResponse, requestId: string, code: ToolWireErrorCode): void {
  jsonResponse(res, toolStatusFor(code), toolErrorBody(requestId, code, "not_applied"));
}

function postDispatchError(res: LanHttpResponse, requestId: string, code: ToolWireErrorCode): void {
  jsonResponse(res, toolStatusFor(code), toolErrorBody(requestId, code, "unknown"));
}

export interface ToolHostOptions {
  bindings: ToolExecutorBindings;
}

/**
 * Handle one authenticated tool execute request. Auth is already verified
 * by the caller (LAN bearer check); this handler performs structural +
 * contract checks, executes the bound adapter with a MINIMAL context,
 * and frames the result. The peer-abort signal propagates into the
 * hosted executor via ctx.signal / attempt.signal.
 */
export async function handleToolExecute(
  route: { toolId: string },
  incoming: LanHttpRequest,
  outgoing: LanHttpResponse,
  options: ToolHostOptions,
): Promise<void> {
  const contentTypeRaw = incoming.headers["content-type"];
  const contentType = (Array.isArray(contentTypeRaw) ? contentTypeRaw[0] : contentTypeRaw) ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    preDispatchError(outgoing, "none", "INVALID_REQUEST");
    return;
  }
  const buffered = await readBoundedBody(incoming.body, LAN_MAX_BODY_BYTES);
  if (!buffered.ok) {
    preDispatchError(outgoing, "none", "INVALID_REQUEST");
    return;
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(buffered.bytes.toString("utf8"));
  } catch {
    preDispatchError(outgoing, "none", "INVALID_REQUEST");
    return;
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    preDispatchError(outgoing, "none", "INVALID_REQUEST");
    return;
  }
  const rawVersion = (envelope as Record<string, unknown>)["protocol_version"];
  const rawRequestId = (envelope as Record<string, unknown>)["request_id"];
  if (rawVersion !== ARTHUR_LAN_PROTOCOL_VERSION) {
    preDispatchError(outgoing, typeof rawRequestId === "string" ? (rawRequestId as string) : "none", "UNSUPPORTED_PROTOCOL_VERSION");
    return;
  }
  if (typeof rawRequestId !== "string" || rawRequestId === "" || rawRequestId.length > 128) {
    preDispatchError(outgoing, "none", "INVALID_REQUEST");
    return;
  }
  const requestId = rawRequestId;
  let parsed;
  try {
    parsed = parseLanToolExecuteRequest(envelope);
  } catch {
    preDispatchError(outgoing, requestId, "INVALID_REQUEST");
    return;
  }
  // Tool identity comes from the URL path: the body never overrides it.
  const bound = options.bindings.get(route.toolId);
  if (bound === undefined) {
    preDispatchError(outgoing, requestId, "TOOL_EXECUTOR_NOT_FOUND");
    return;
  }
  if (bound.version !== parsed.toolVersion || bound.hash !== parsed.toolDefinitionHash) {
    // Contract mismatch: executor invocation count stays 0.
    preDispatchError(outgoing, requestId, "TOOL_CONTRACT_MISMATCH");
    return;
  }
  // Minimal remote context: identity + attempt scope only. 'approved' is
  // false/informational; authorization is NEVER reconstructed.
  const controller = new AbortController();
  let settled = false;
  const onPeerAbort = (): void => {
    if (settled) return;
    try { controller.abort(); } catch { /* best effort */ }
  };
  incoming.onAborted(onPeerAbort);
  if (incoming.aborted) {
    try { controller.abort(); } catch { /* best effort */ }
  }
  const remoteSignal = controller.signal;
  const ctx: ToolExecutionContext = {
    session_id: parsed.sessionId,
    turn_id: parsed.turnId,
    trace_id: parsed.traceId,
    mode: parsed.mode as ToolExecutionContext["mode"],
    approved: false,
    execution_id: parsed.executionId,
    attempt_id: parsed.attemptId,
    attempt_no: parsed.attemptNo,
    deadline_at: parsed.deadlineAt,
    signal: remoteSignal,
  };
  const attempt = {
    execution_id: parsed.executionId,
    attempt_id: parsed.attemptId,
    attempt_no: parsed.attemptNo,
    deadline_at: parsed.deadlineAt,
    signal: remoteSignal,
  };
  // The executor invocation starts HERE: everything after is post-dispatch
  // (unknown outcome on failure). Execute EXACTLY the caller args object.
  let raw: ToolResult;
  try {
    const started = controller.signal.aborted
    // eslint-disable-next-line no-mixed-operators
      ? Promise.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }))
      : Promise.resolve().then(() => bound.executor(JSON.parse(JSON.stringify(parsed.args)) as Record<string, unknown>, ctx, attempt));
    raw = await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
      }),
    ]);
  } catch (err) {
    settled = true;
    if (err instanceof Error && (err.name === "AbortError" || /cancel/i.test(err.message))) {
      postDispatchError(outgoing, requestId, "TOOL_EXECUTOR_CANCELLED");
      return;
    }
    if (err instanceof Error && /timed out|timeout|deadline/i.test(err.message)) {
      postDispatchError(outgoing, requestId, "TOOL_EXECUTOR_TIMEOUT");
      return;
    }
    postDispatchError(outgoing, requestId, "TOOL_EXECUTOR_FAILED");
    return;
  }
  // Basic structural defense on the host; the caller performs the final
  // trusted contract + output_schema validation.
  try {
    parseLanToolResult(raw);
  } catch {
    settled = true;
    postDispatchError(outgoing, requestId, "TOOL_OUTPUT_INVALID");
    return;
  }
  settled = true;
  if (outgoing.ended || incoming.aborted) {
    // Response cannot be confirmed after peer disconnect: the caller maps
    // the transport failure to unknown; the host reports nothing further.
    return;
  }
  jsonResponse(outgoing, 200, { protocol_version: ARTHUR_LAN_PROTOCOL_VERSION, request_id: requestId, result: raw });
}
