/**
 * HR-03E: LAN tool execution client (caller side, one dispatch per attempt).
 *
 * Performs exactly ONE HTTP request per SC-03 attempt: no fetch retry, no
 * redirect retry, no reconnect, no alternate target, no local fallback.
 * The durable SC-03 coordinator is the only retry owner: a typed
 * AttemptDispatchError tells it whether the target provably never started
 * (not_applied) or may have started (unknown -> OUTCOME_UNKNOWN).
 *
 * Cancellation/timeout propagate via the attempt AbortSignal wired to
 * fetch. Caller cancellation is never remapped into a transient failure.
 */

import { randomUUID } from "node:crypto";

import { AttemptDispatchError } from "../tools/errors";
import type { RemoteToolExecutorClient } from "../tools/node_executor_bindings";
import { ARTHUR_LAN_PROTOCOL_VERSION, type LanToolErrorBody } from "./tool_protocol";
import { lanToolExecutePath, isToolWireErrorCode, type ToolWireErrorCode } from "./tool_protocol";
import { LAN_JSON_CONTENT_TYPE } from "./protocol";
import { LAN_MAX_BODY_BYTES } from "./validation";
import { parseLanToolResult } from "./tool_validation";
import { LAN_BEARER_PREFIX } from "./auth";
import { assertLanBaseUrl } from "./client";

export interface LanToolExecutorOptions {
  baseUrl: string;
  authToken: string;
  fetchFn?: typeof fetch;
}

export class LanToolExecutor implements RemoteToolExecutorClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly fetchFn: typeof fetch;
  /** Counts transport dispatches (tests prove exactly-once per attempt). */
  dispatchCount = 0;

  constructor(options: LanToolExecutorOptions) {
    const url = assertLanBaseUrl(options.baseUrl);
    this.baseUrl = url.origin;
    if (typeof options.authToken !== "string" || options.authToken === "") {
      throw new Error("lan tool auth token must be non-empty");
    }
    this.authToken = options.authToken;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async execute(
    toolId: string,
    toolVersion: string,
    toolDefinitionHash: string,
    args: Record<string, unknown>,
    ctx: { session_id: string; turn_id: string; trace_id: string; mode: string },
    attempt: { execution_id: string; attempt_id: string; attempt_no: number; deadline_at: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; summary: string; data?: unknown }> {
    const requestId = randomUUID();
    // Exact args object, JSON boundary only: no trimming, rewriting, or defaults.
    const envelope = JSON.stringify({
      protocol_version: ARTHUR_LAN_PROTOCOL_VERSION,
      request_id: requestId,
      tool_version: toolVersion,
      tool_definition_hash: toolDefinitionHash,
      execution: {
        execution_id: attempt.execution_id,
        attempt_id: attempt.attempt_id,
        attempt_no: attempt.attempt_no,
        deadline_at: attempt.deadline_at,
        session_id: ctx.session_id,
        turn_id: ctx.turn_id,
        trace_id: ctx.trace_id,
        mode: ctx.mode,
        args: JSON.parse(JSON.stringify(args)) as Record<string, unknown>,
      },
    });
    this.dispatchCount += 1;
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + lanToolExecutePath(toolId), {
        method: "POST",
        headers: { authorization: LAN_BEARER_PREFIX + this.authToken, "content-type": LAN_JSON_CONTENT_TYPE },
        body: envelope,
        redirect: "error",
        ...(attempt.signal !== undefined ? { signal: attempt.signal } : {}),
      });
    } catch (err) {
      throw this.mapTransportError(err, attempt.signal);
    }
    const text = await this.readBounded(res);
    if (res.status === 401) {
      // Auth runs before dispatch server-side: provably not applied.
      throw new AttemptDispatchError("permanent", "not_applied", "LAN_UNAUTHORIZED", "lan tool authentication failed");
    }
    if (res.status !== 200) {
      throw this.mapWireError(text, requestId);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A 200 with a malformed body after remote dispatch began: unknown.
      throw new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "lan tool response is not json");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "lan tool response envelope malformed");
    }
    const raw = parsed as Record<string, unknown>;
    if (raw["protocol_version"] !== ARTHUR_LAN_PROTOCOL_VERSION) {
      throw new AttemptDispatchError("protocol", "unknown", "LAN_PROTOCOL", "unsupported lan tool protocol version");
    }
    if (raw["request_id"] !== requestId) {
      throw new AttemptDispatchError("protocol", "unknown", "LAN_PROTOCOL", "lan tool request id mismatch");
    }
    try {
      return parseLanToolResult(raw["result"]);
    } catch {
      throw new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "lan tool result malformed");
    }
  }

  private mapWireError(text: string, requestId: string): AttemptDispatchError {
    let code: ToolWireErrorCode = "INTERNAL_ERROR";
    try {
      const parsed = JSON.parse(text) as LanToolErrorBody;
      const rawCode = (parsed as { error?: { code?: unknown } }).error?.code;
      if (isToolWireErrorCode(rawCode)) code = rawCode;
    } catch {
      return new AttemptDispatchError("protocol", "unknown", "LAN_PROTOCOL", "lan tool error body malformed");
    }
    void requestId;
    // Pre-dispatch server failures: the host tracks whether the raw
    // executor started; not_applied codes never ran it.
    if (code === "TOOL_EXECUTOR_NOT_FOUND" || code === "TOOL_CONTRACT_MISMATCH" || code === "INVALID_REQUEST" || code === "UNSUPPORTED_PROTOCOL_VERSION") {
      return new AttemptDispatchError("permanent", "not_applied", code === "INVALID_REQUEST" || code === "UNSUPPORTED_PROTOCOL_VERSION" ? "LAN_PROTOCOL" : code, "lan tool rejected before dispatch");
    }
    if (code === "UNAUTHORIZED") {
      return new AttemptDispatchError("permanent", "not_applied", "LAN_UNAUTHORIZED", "lan tool authentication failed");
    }
    // Post-dispatch failures: the executor started (or may have), so the
    // outcome is unknown for mutations; the evidence is unknown regardless.
    if (code === "TOOL_EXECUTOR_TIMEOUT") {
      return new AttemptDispatchError("timeout", "unknown", "TOOL_EXECUTOR_TIMEOUT", "lan tool execution timed out");
    }
    if (code === "TOOL_EXECUTOR_CANCELLED") {
      return new AttemptDispatchError("cancelled", "unknown", "TOOL_EXECUTOR_CANCELLED", "lan tool execution cancelled");
    }
    if (code === "TOOL_OUTPUT_INVALID") {
      return new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "lan tool returned invalid output");
    }
    if (code === "TOOL_EXECUTOR_FAILED" || code === "INTERNAL_ERROR") {
      return new AttemptDispatchError("permanent", "unknown", code === "TOOL_EXECUTOR_FAILED" ? "TOOL_EXECUTOR_FAILED" : "INTERNAL_ERROR", "lan tool execution failed");
    }
    return new AttemptDispatchError("protocol", "unknown", "LAN_PROTOCOL", "lan tool request failed");
  }

  private mapTransportError(err: unknown, signal?: AbortSignal): AttemptDispatchError {
    // Caller cancellation is never remapped: preserve cancelled semantics.
    if (signal?.aborted === true) {
      const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "");
      if (/user cancellation|user_cancel|cancel_requested/i.test(reason)) {
        const cancelled = new AttemptDispatchError("cancelled", "unknown", "LAN_CANCELLED", "lan tool execution cancelled");
        return cancelled;
      }
      return new AttemptDispatchError("timeout", "unknown", "LAN_TIMEOUT", "lan tool attempt aborted");
    }
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return new AttemptDispatchError("timeout", "unknown", "LAN_TIMEOUT", "lan tool request aborted");
    }
    // The fetch threw before a response: dispatch may or may not have
    // reached the host. Fail closed as unknown (never claim not_applied
    // without proof - the connection may have died after remote dispatch).
    return new AttemptDispatchError("transient", "unknown", "LAN_TRANSPORT", "lan tool transport failed");
  }

  private async readBounded(res: Response): Promise<string> {
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isInteger(length) || length < 0 || length > LAN_MAX_BODY_BYTES) {
        throw new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "lan tool response exceeds the bound");
      }
    }
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (reader === undefined || reader === null) {
      const text = await res.text();
      if (text.length > LAN_MAX_BODY_BYTES) {
        throw new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "lan tool response exceeds the bound");
      }
      return text;
    }
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > LAN_MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new AttemptDispatchError("protocol", "unknown", "TOOL_OUTPUT_INVALID", "lan tool response exceeds the bound");
      }
    }
    text += decoder.decode();
    return text;
  }
}
