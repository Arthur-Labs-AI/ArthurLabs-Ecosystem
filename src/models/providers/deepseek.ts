/**
 * DeepSeek provider adapter (spec section 7).
 *
 * The only place in the codebase that knows about the DeepSeek HTTP API. It
 * authenticates with a secret, applies a finite timeout, retries only transient
 * failures with bounded exponential backoff + jitter, maps the ARTHUR reasoning
 * profile, and immediately normalizes the vendor response into `ModelResult`.
 * No SDK object ever leaves this file, and the secret is never logged.
 *
 * Tool name aliasing (TASK-0006): ARTHUR canonical names are dotted
 * (system.echo); DeepSeek requires ^[a-zA-Z0-9_-]+$. This adapter is the ONLY
 * boundary where names are transformed. One ToolNameAliasMap is built per
 * model request from the exact exposed tool set: outbound schemas and message
 * tool identities are encoded (system.echo -> system__echo) and inbound tool
 * calls are resolved back to canonical names (system__echo -> system.echo)
 * BEFORE any result leaves the provider. Unknown inbound names and alias
 * collisions fail closed; nothing downstream ever sees a provider alias.
 */

import { randomUUID } from "node:crypto";
import {
  ChatMessage,
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResult,
  ModelStreamEvent,
  ProposedToolCall,
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ReasoningProfile,
} from "../contracts";
import type { TokenUsage } from "../../observability/usage";
import { redactText } from "../../security/redaction";
import { sanitizeStructured } from "../../security/sanitize";
import {
  ToolNameAliasMap,
  ToolNameAliasUnknownError,
} from "./tool_name_alias";

export interface DeepSeekProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  reasoningProfile: ReasoningProfile;
}

/** Minimal structural diagnostics sink (the app Logger satisfies this). */
export interface ProviderLogSink {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface DeepSeekProviderDeps {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Optional structured diagnostics sink for the streaming path. Fields
   * NEVER contain the API key, authorization headers, prompts, or response
   * bodies - only failure kind, HTTP status, attempt counts, and whether
   * consumer-visible events had already been emitted.
   */
  logger?: ProviderLogSink;
}

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/** Hard cap on the raw response body we are willing to buffer (10 MiB). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_ASSISTANT_TEXT_CHARS = 1_000_000;
export const MAX_TOOL_CALLS = 32;
const MAX_TOOL_IDENTIFIER_CHARS = 256;

/**
 * Read and cap the raw response body so an oversized provider response fails
 * closed instead of being buffered without bound (audit MEDIUM 8).
 */
export async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new ProviderBadResponseError("response body exceeds size limit");
    }
  }
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ProviderBadResponseError("response body exceeds size limit");
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderBadResponseError("response body exceeds size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ---- Reasoning profile mapping (spec section 7 "Reasoning") --------------

export interface ReasoningParams {
  temperature: number;
  max_tokens?: number;
}

export function reasoningParams(profile: ReasoningProfile): ReasoningParams {
  switch (profile) {
    case "fast":
      return { temperature: 0, max_tokens: 512 };
    case "deep":
      return { temperature: 0.7, max_tokens: 8192 };
    case "normal":
    default:
      return { temperature: 0.7 };
  }
}

// ---- Request boundary validation (defense-in-depth) ---------------------

/**
 * Fail LOCALLY (before any network call) when a ModelRequest carries an
 * assistant history message with neither non-empty content nor tool_calls.
 * OpenAI-compatible providers reject such messages with HTTP 400 ("Invalid
 * assistant message: content or tool_calls must be set"), which upstream
 * surfaced as an opaque provider-unavailable error on voice turns. The
 * primary fix is history eligibility at the ContextBuilder; this boundary
 * check converts any future regression into an immediate, local,
 * MODEL_BAD_RESPONSE-classified failure instead of a vendor 400. It is a
 * loud failure, not a silent vendor special-case.
 */
export function assertAssistantHistorySendable(request: ModelRequest): void {
  for (const message of request.history) {
    if (message.role !== "assistant") continue;
    const hasText = typeof message.content === "string" && message.content.trim() !== "";
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!hasText && !hasToolCalls) {
      throw new ProviderBadResponseError(
        "assistant history message has neither content nor tool_calls"
      );
    }
  }
}

// ---- Payload assembly (pure; redaction applied by the caller's logger) ---

function chatMessageToOpenAI(message: ChatMessage, aliasMap: ToolNameAliasMap): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    role: message.role,
    content: message.content === "" ? null : message.content,
  };
  // Tool result messages carry the canonical tool name; DeepSeek treats it as
  // a function name, so it is aliased at the provider boundary like every
  // other outbound tool identity.
  if (message.role === "tool" && message.name) {
    msg.name = aliasMap.canonicalToProvider(message.name);
  } else if (message.name) {
    msg.name = message.name;
  }
  if (message.tool_call_id) msg.tool_call_id = message.tool_call_id;
  if (message.tool_calls && message.tool_calls.length > 0) {
    // Assistant history may reference tools from earlier requests; the
    // deterministic encoding keeps every outbound name provider-safe.
    msg.tool_calls = message.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: aliasMap.canonicalToProvider(tc.name),
        arguments: JSON.stringify(tc.arguments),
      },
    }));
  }
  return msg;
}

export function buildDeepSeekPayload(
  request: ModelRequest,
  model: string,
  profile: ReasoningProfile,
  stream = false,
  aliasMap: ToolNameAliasMap,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  messages.push({ role: "system", content: request.systemContract });
  if (request.modeContract) {
    messages.push({ role: "system", content: request.modeContract });
  }
  for (const historyMessage of request.history) {
    messages.push(chatMessageToOpenAI(historyMessage, aliasMap));
  }
  if (request.userMessage !== "") {
    messages.push({ role: "user", content: request.userMessage });
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream,
    ...reasoningParams(profile),
  };

  if (request.toolSchemas.length > 0) {
    payload.tools = request.toolSchemas.map((schema) => ({
      type: "function",
      function: {
        // Canonical ARTHUR name -> DeepSeek-safe alias (TASK-0006). The map
        // was built from exactly this request's exposed tool set, so every
        // schema name is present and collision-free by construction.
        name: aliasMap.canonicalToProvider(schema.name),
        description: schema.description,
        parameters: schema.parameters,
      },
    }));
  }

  return payload;
}

// ---- Response normalization (pure; strict full-body validation) ----------

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderBadResponseError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function optionalTokenCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderBadResponseError(`usage.${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Core usage counts are REQUIRED whenever the usage object is present. */
function requiredTokenCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderBadResponseError(`usage.${field} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Normalize the DeepSeek usage object. The three core counts are required;
 * every other field (prompt_tokens_details, completion_tokens_details,
 * prompt_cache_hit_tokens, prompt_cache_miss_tokens, future additive
 * metadata) is tolerated and never fails validation.
 */
export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (raw === undefined || raw === null) return undefined;
  const u = requireObject(raw, "usage");
  const usage: TokenUsage = {};
  usage.input_tokens = requiredTokenCount(u.prompt_tokens, "prompt_tokens");
  usage.output_tokens = requiredTokenCount(u.completion_tokens, "completion_tokens");
  usage.total_tokens = requiredTokenCount(u.total_tokens, "total_tokens");
  let cachedRaw = u.prompt_cache_hit_tokens;
  if (u.prompt_tokens_details !== undefined && u.prompt_tokens_details !== null) {
    const details = requireObject(u.prompt_tokens_details, "usage.prompt_tokens_details");
    cachedRaw = details.cached_tokens;
  }
  usage.cached_tokens = optionalTokenCount(cachedRaw, "cached_tokens");
  return usage;
}

function parseToolCalls(raw: unknown): ProposedToolCall[] {
  const out: ProposedToolCall[] = [];
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) {
    throw new ProviderBadResponseError("tool_calls is not an array");
  }
  if (raw.length > MAX_TOOL_CALLS) {
    throw new ProviderBadResponseError("response contains too many tool calls");
  }
  for (const rawTc of raw) {
    const tc = requireObject(rawTc, "tool call");
    if (tc.type !== undefined && tc.type !== "function") {
      throw new ProviderBadResponseError("tool call type is invalid");
    }
    if (tc.id !== undefined && (typeof tc.id !== "string" || tc.id.length === 0 || tc.id.length > MAX_TOOL_IDENTIFIER_CHARS)) {
      throw new ProviderBadResponseError("tool call id is invalid");
    }
    const fn = requireObject(tc.function, "tool call function");
    if (typeof fn.name !== "string" || fn.name.trim() === "" || fn.name.length > MAX_TOOL_IDENTIFIER_CHARS) {
      throw new ProviderBadResponseError("tool call is missing a function name");
    }
    let args: Record<string, unknown> = {};
    const rawArgs = fn.arguments;
    if (typeof rawArgs === "string") {
      if (rawArgs.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawArgs);
        } catch {
          throw new ProviderBadResponseError("tool call arguments are not a JSON object");
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ProviderBadResponseError("tool call arguments are not a JSON object");
        }
        args = parsed as Record<string, unknown>;
      }
    } else if (rawArgs !== undefined && rawArgs !== null) {
      throw new ProviderBadResponseError("tool call arguments must be a string");
    }
    out.push({
      id: typeof tc.id === "string" ? tc.id : randomUUID(),
      name: fn.name,
      arguments: args,
    });
  }
  return out;
}

/**
 * Normalize and validate a DeepSeek (OpenAI-compatible) non-stream completion
 * response.
 *
 * The required subset below is enforced fail-closed; ADDITIVE provider
 * metadata (system_fingerprint, prompt_tokens_details,
 * prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens_details,
 * unknown future fields) is always tolerated and never fails validation.
 *
 * Security invariants:
 * - the final answer comes ONLY from message.content;
 * - message.reasoning_content is reasoning metadata: type-checked but never
 *   surfaced as assistant text and never persisted;
 * - message.content may be null only when tool_calls are present.
 */
export function normalizeDeepSeekResponse(body: unknown, fallbackRequestId?: string): ModelResult {
  try {
    const b = requireObject(body, "response body");

    // Top-level required envelope.
    const rawId = b.id;
    if (typeof rawId !== "string") {
      throw new ProviderBadResponseError("response id is not a string");
    }
    if (typeof b.object !== "string") {
      throw new ProviderBadResponseError("response object is not a string");
    }
    if (typeof b.created !== "number" || !Number.isFinite(b.created)) {
      throw new ProviderBadResponseError("response created is not a number");
    }
    if (typeof b.model !== "string") {
      throw new ProviderBadResponseError("response model is not a string");
    }

    const choices = b.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderBadResponseError("response has no choices");
    }
    const choice = requireObject(choices[0], "choice");
    if (typeof choice.index !== "number" || !Number.isInteger(choice.index) || choice.index < 0) {
      throw new ProviderBadResponseError("choice index is not a non-negative integer");
    }
    const message = requireObject(choice.message, "choice message");
    if (message.role !== "assistant") {
      throw new ProviderBadResponseError("choice message role is not 'assistant'");
    }

    // content: string | null (required). null is only valid alongside tool calls.
    const rawContent = message.content;
    if (rawContent === undefined) {
      throw new ProviderBadResponseError("choice message content is required");
    }
    if (rawContent !== null && typeof rawContent !== "string") {
      throw new ProviderBadResponseError("message content is not a string");
    }
    // reasoning_content: optional string | null. Never surfaced or persisted.
    const reasoningContent = message.reasoning_content;
    if (reasoningContent !== undefined && reasoningContent !== null && typeof reasoningContent !== "string") {
      throw new ProviderBadResponseError("message reasoning_content is not a string");
    }

    // logprobs: object | null | undefined.
    const logprobs = choice.logprobs;
    if (logprobs !== undefined && logprobs !== null && (typeof logprobs !== "object" || Array.isArray(logprobs))) {
      throw new ProviderBadResponseError("choice logprobs is not an object");
    }

    // finish_reason: string | null (required). null maps to "unknown".
    const finishRaw = choice.finish_reason;
    if (finishRaw === undefined) {
      throw new ProviderBadResponseError("choice finish_reason is required");
    }
    if (finishRaw !== null && typeof finishRaw !== "string") {
      throw new ProviderBadResponseError("finish_reason is not a string");
    }
    const finishReason = typeof finishRaw === "string" ? finishRaw : "unknown";

    const assistant_text = rawContent === null ? "" : rawContent;
    if (assistant_text.length > MAX_ASSISTANT_TEXT_CHARS) {
      throw new ProviderBadResponseError("assistant content exceeds size limit");
    }

    const tool_calls = parseToolCalls(message.tool_calls);
    if (assistant_text === "" && tool_calls.length === 0) {
      throw new ProviderBadResponseError("response contains neither text nor tool calls");
    }

    return {
      assistant_text,
      tool_calls,
      usage: normalizeUsage(b.usage),
      finish_reason: finishReason,
      raw_provider_id: rawId,
    };
  } catch (err) {
    if (err instanceof ProviderBadResponseError) throw err;
    throw new ProviderBadResponseError("response could not be normalized");
  }
}


// ---- Retry helpers -------------------------------------------------------

export function isTransientHttpStatus(status?: number): boolean {
  return status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function backoffDelay(attempt: number, baseMs: number): number {
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseMs;
  return Math.round(exp + jitter);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

// ---- Streaming failure diagnostics (TASK-0007 hardening) ----------------

/** Structured failure kinds for the streaming path (never secret-bearing). */
export type StreamFailureKind =
  | "auth"
  | "request_rejected"
  | "provider_bad_response"
  | "malformed_sse"
  | "timeout"
  | "http_status"
  | "network_fetch_failure"
  | "unexpected";

/** SSE data line that is not valid JSON (distinct diagnostic kind). */
export const MALFORMED_SSE_MESSAGE = "SSE line is not valid JSON";

const MAX_DIAGNOSTIC_MESSAGE_CHARS = 200;

/** HTTP status of classified HTTP errors (attached at classify time). */
const errorHttpStatus = new WeakMap<object, number>();

function truncateDiagnostic(message: string): string {
  return message.length > MAX_DIAGNOSTIC_MESSAGE_CHARS
    ? message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS) + " (truncated)"
    : message;
}

export interface StreamFailureDiagnosis {
  kind: StreamFailureKind;
  http_status?: number;
  error_name?: string;
  error_message?: string;
}

/**
 * Map a streaming attempt failure to a safe diagnostic shape. Only error
 * KIND, HTTP status, and our own static/redacted error messages are exposed;
 * network and unexpected failures report the error NAME only. Never contains
 * the API key, authorization headers, prompts, or response bodies.
 */
export function classifyStreamFailure(err: unknown, timedOut: boolean): StreamFailureDiagnosis {
  const nameOf = (e: unknown): string | undefined => (e instanceof Error ? e.name : typeof e);
  if (err instanceof ProviderAuthError) {
    return { kind: "auth", error_name: err.name, error_message: truncateDiagnostic(err.message) };
  }
  if (err instanceof DeepSeekRequestRejectedError) {
    const status = errorHttpStatus.get(err);
    return {
      kind: "request_rejected",
      http_status: status,
      error_name: err.name,
      error_message: truncateDiagnostic(err.message),
    };
  }
  if (err instanceof ProviderBadResponseError) {
    return {
      kind: err.message === MALFORMED_SSE_MESSAGE ? "malformed_sse" : "provider_bad_response",
      error_name: err.name,
      error_message: truncateDiagnostic(err.message),
    };
  }
  if (timedOut) return { kind: "timeout", error_name: nameOf(err) };
  if (err instanceof ProviderUnavailableError) {
    const status = errorHttpStatus.get(err);
    return status !== undefined
      ? { kind: "http_status", http_status: status, error_name: err.name, error_message: truncateDiagnostic(err.message) }
      : { kind: "network_fetch_failure", error_name: nameOf(err) };
  }
  // Every parse/normalize path throws ProviderBadResponseError by design
  // (fail-closed), so a plain non-abort error here escapes from the fetch
  // or body-read layer: a network-level failure, not a provider response
  // problem. ("unexpected" stays reserved for future defensive use.)
  return { kind: "network_fetch_failure", error_name: nameOf(err) };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- HTTP error classification (non-2xx responses) ----------------------

/**
 * A non-transient, non-auth HTTP error from the provider (e.g. 400/404/422):
 * the provider rejected the request or the endpoint is misconfigured. This is
 * NOT a malformed completion response, so it must never surface as
 * MODEL_BAD_RESPONSE; it extends ProviderUnavailableError (=> MODEL_UNAVAILABLE)
 * and is never retried.
 */
export class DeepSeekRequestRejectedError extends ProviderUnavailableError {
  constructor(message = "DeepSeek rejected the request") {
    super(message);
    this.name = "DeepSeekRequestRejectedError";
  }
}

/**
 * Read a bounded HTTP error body and extract a short, sanitized diagnostic
 * (DeepSeek error envelope `{error:{message}}` or plain `{message}`). Never
 * throws: classification is driven by the HTTP status alone, and an unreadable
 * or unparseable error body must not change the classification.
 */
async function readHttpErrorDetail(response: Response, secrets: string[]): Promise<string> {
  try {
    const text = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
    if (text.trim() === "") return "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return redactText(text.slice(0, 500), secrets);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const obj = parsed as Record<string, unknown>;
    const errorObj =
      typeof obj.error === "object" && obj.error !== null && !Array.isArray(obj.error)
        ? (obj.error as Record<string, unknown>)
        : undefined;
    const message =
      typeof errorObj?.message === "string"
        ? errorObj.message
        : typeof obj.message === "string"
          ? obj.message
          : "";
    return redactText(message.slice(0, 500), secrets);
  } catch {
    return "";
  }
}

/**
 * Classify a non-2xx provider response: parse the error body first, then map
 * to the correct provider error. Auth => ProviderAuthError, transient
 * (408/429/5xx) => ProviderUnavailableError (retried by the caller), anything
 * else => DeepSeekRequestRejectedError (never retried, never MODEL_BAD_RESPONSE).
 */
async function classifyHttpError(response: Response, secrets: string[]): Promise<never> {
  const detail = await readHttpErrorDetail(response, secrets);
  const message = `DeepSeek HTTP ${response.status}${detail !== "" ? `: ${detail}` : ""}`;
  let err: Error;
  if (response.status === 401 || response.status === 403) {
    err = new ProviderAuthError(message);
  } else if (isTransientHttpStatus(response.status)) {
    err = new ProviderUnavailableError(message);
  } else {
    err = new DeepSeekRequestRejectedError(message);
  }
  // Attach the status for safe structured diagnostics (never the body).
  errorHttpStatus.set(err, response.status);
  throw err;
}


// ---- Streaming chunk normalization (Phase 3 spec section 15) ------------

export interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
  /** True once an early partial tool_call event was already emitted. */
  partialEmitted: boolean;
}

/**
 * Normalize one SSE data chunk (OpenAI-compatible stream, as used by
 * DeepSeek) into ModelStreamEvents. Returns null for chunks with no
 * speakable or actionable content.
 *
 * Tool-call fragments are accumulated across chunks. On the FIRST fragment
 * of a new tool call an early partial `tool_call` event is emitted (id and
 * name may still be empty) so consumers can hold speech while tool intent
 * is pending; the provider emits the complete finalized call at stream end.
 */
export function parseDeepSeekStreamChunk(
  raw: unknown,
  toolAccumulators: Map<number, ToolCallAccumulator>,
): ModelStreamEvent[] | null {
  const out: ModelStreamEvent[] = [];
  const chunk = requireObject(raw, "stream chunk");
  const rawChoices = chunk.choices;
  if (rawChoices !== undefined && rawChoices !== null) {
    if (!Array.isArray(rawChoices)) throw new ProviderBadResponseError("stream chunk choices is not an array");
    const choice = rawChoices[0];
    if (choice !== undefined) {
      const c = requireObject(choice, "stream choice");
      if (c.finish_reason !== undefined && c.finish_reason !== null) {
        if (typeof c.finish_reason !== "string") throw new ProviderBadResponseError("finish_reason is not a string");
        out.push({ type: "done", finish_reason: c.finish_reason });
      }
      if (c.delta !== undefined && c.delta !== null) {
        const delta = requireObject(c.delta, "stream delta");
        if (delta.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string") throw new ProviderBadResponseError("delta content is not a string");
          if (delta.content !== "") out.push({ type: "text_delta", text: delta.content });
        }
        if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
          if (!Array.isArray(delta.tool_calls)) throw new ProviderBadResponseError("delta tool_calls is not an array");
          for (const rawCall of delta.tool_calls) {
            const call = requireObject(rawCall, "tool call delta");
            const index = call.index === undefined || call.index === null ? 0 : call.index;
            if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
              throw new ProviderBadResponseError("tool call index is invalid");
            }
            const existing = toolAccumulators.get(index);
            const rawId = call.id === undefined || call.id === null ? undefined : call.id;
            if (rawId !== undefined && typeof rawId !== "string") {
              throw new ProviderBadResponseError("tool call id is invalid");
            }
            const fn = call.function === undefined || call.function === null ? undefined : requireObject(call.function, "tool call function delta");
            if (!existing) {
              const acc: ToolCallAccumulator = {
                id: typeof rawId === "string" ? rawId : "",
                name: "",
                argumentsJson: "",
                partialEmitted: false,
              };
              toolAccumulators.set(index, acc);
              if (fn) {
                if (fn.name !== undefined && fn.name !== null) {
                  if (typeof fn.name !== "string") throw new ProviderBadResponseError("tool call name is not a string");
                  acc.name += fn.name;
                }
                if (fn.arguments !== undefined && fn.arguments !== null) {
                  if (typeof fn.arguments !== "string") throw new ProviderBadResponseError("tool call arguments are not a string");
                  acc.argumentsJson += fn.arguments;
                }
              }
              // Early partial signal (advisory; complete call comes at end).
              if (acc.id !== "" || acc.name !== "") {
                acc.partialEmitted = true;
                out.push({
                  type: "tool_call",
                  call: { id: acc.id !== "" ? acc.id : `tc-${index}`, name: acc.name, arguments: {} },
                });
              }
            } else {
              if (fn) {
                if (fn.name !== undefined && fn.name !== null) {
                  if (typeof fn.name !== "string") throw new ProviderBadResponseError("tool call name is not a string");
                  existing.name += fn.name;
                }
                if (fn.arguments !== undefined && fn.arguments !== null) {
                  if (typeof fn.arguments !== "string") throw new ProviderBadResponseError("tool call arguments are not a string");
                  existing.argumentsJson += fn.arguments;
                }
              }
              if (!existing.partialEmitted && (existing.id !== "" || existing.name !== "")) {
                existing.partialEmitted = true;
                out.push({
                  type: "tool_call",
                  call: { id: existing.id !== "" ? existing.id : `tc-${index}`, name: existing.name, arguments: {} },
                });
              }
            }
          }
        }
      }
    }
  }
  if (chunk.usage !== undefined && chunk.usage !== null) {
    const usage = normalizeUsage(chunk.usage);
    if (usage) out.push({ type: "usage", usage });
  }
  return out.length > 0 ? out : null;
}


// ---- Inbound tool-call resolution (TASK-0006) --------------------------

/**
 * Resolve one provider-returned tool name to its canonical ARTHUR name
 * through the exact alias map built for this model request. A name that is
 * regex-valid but was NOT exposed in this request is rejected: the model must
 * never manufacture an internal canonical identity (fail closed).
 */
function resolveInboundToolName(providerName: string, aliasMap: ToolNameAliasMap): string {
  try {
    return aliasMap.providerToCanonical(providerName);
  } catch (err) {
    if (err instanceof ToolNameAliasUnknownError) {
      throw new ProviderBadResponseError(
        `tool call name '${providerName}' was not exposed in this request; refusing to execute`,
      );
    }
    throw err;
  }
}

/**
 * Restore canonical tool names on every normalized model result BEFORE it
 * leaves the provider boundary, so registry lookup, permission evaluation,
 * approval binding, idempotency, audit logging, execution, persistence and
 * Harness dispatch all see canonical names only.
 */
function resolveInboundToolCalls(result: ModelResult, aliasMap: ToolNameAliasMap): ModelResult {
  if (result.tool_calls.length === 0) return result;
  return {
    ...result,
    tool_calls: result.tool_calls.map((call) => ({
      ...call,
      name: resolveInboundToolName(call.name, aliasMap),
    })),
  };
}

export class DeepSeekProvider implements ModelProvider {
  private readonly config: DeepSeekProviderConfig;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly logger: ProviderLogSink | undefined;

  constructor(config: DeepSeekProviderConfig, deps: DeepSeekProviderDeps = {}) {
    this.config = config;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepFn = deps.sleepFn ?? defaultSleep;
    this.logger = deps.logger;
  }

  id(): string {
    return "deepseek";
  }

  capabilities(): ModelCapabilities {
    return {
      id: "deepseek",
      modelName: this.config.model,
      supportsTools: true,
      supportsReasoning: true,
      maxContextTokens: 64000,
      online: true,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResult> {
    const safeRequest = sanitizeStructured(request, [this.config.apiKey]) as ModelRequest;
    // Defense-in-depth: reject malformed assistant history locally, before
    // any fetch (both streaming and buffered paths).
    assertAssistantHistorySendable(safeRequest);
    // One alias map per model request, built from the exact exposed tool set.
    // A collision or unencodable name throws HERE, before any fetch: the
    // request fails closed without ever reaching the provider.
    const aliasMap = ToolNameAliasMap.fromToolSchemas(safeRequest.toolSchemas);
    const payload = buildDeepSeekPayload(
      safeRequest,
      this.config.model,
      this.config.reasoningProfile,
      false,
      aliasMap,
    );
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const url = `${base}/chat/completions`;

    let lastError: unknown;
    const attempts = Math.max(0, this.config.retryMaxAttempts) + 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1, this.config.retryBaseDelayMs);
        await this.sleepFn(delay);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: redactText(JSON.stringify(payload), [this.config.apiKey]),
          signal: controller.signal,
        });

        // Non-2xx responses are parsed and classified BEFORE any completion
        // validation: an HTTP error is never reported as a malformed response.
        if (!response.ok) {
          await classifyHttpError(response, [this.config.apiKey]);
        }

        const text = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new ProviderBadResponseError("response body is not valid JSON");
        }
        return resolveInboundToolCalls(normalizeDeepSeekResponse(body, undefined), aliasMap);
      } catch (err) {
        if (
          err instanceof ProviderAuthError ||
          err instanceof ProviderBadResponseError ||
          err instanceof DeepSeekRequestRejectedError
        ) {
          throw err;
        }
        if (isAbortError(err)) {
          throw new ProviderTimeoutError();
        }
        const wrapped =
          err instanceof ProviderUnavailableError
            ? err
            : new ProviderUnavailableError(err instanceof Error ? err.message : "network failure");
        lastError = wrapped;
        // continue to next attempt (transient failure)
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error ? lastError : new ProviderUnavailableError();
  }

  /**
   * Streaming chat completion (Phase 3 spec section 15).
   *
   * SSE parsing stays inside this adapter. Tool-call fragments are
   * accumulated across chunks; an early partial `tool_call` event is
   * emitted on the first fragment so the voice controller can hold speech
   * while tool intent is pending, and complete calls with parsed
   * arguments are emitted at stream end (consumers keep the last event
   * per call id).
   *
   * Retries (TASK-0007): transient failures and timeouts BEFORE any
   * consumer-visible event are retried with a fresh AbortController and a
   * fresh timeout per attempt; failures after partial data are never retried
   * (no duplicated stream content); caller abort never retries.
   *
   * Diagnostics (safe, structured): every failed attempt, caller abort,
   * retry exhaustion, and completion are reported through the optional
   * logger with failure kind / HTTP status / attempt counts / emitted_any -
   * never the API key, headers, prompts, or response bodies.
   */
  async *generateStream(
    request: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const safeRequest = sanitizeStructured(request, [this.config.apiKey]) as ModelRequest;
    // Defense-in-depth: reject malformed assistant history locally, before
    // any fetch (both streaming and buffered paths).
    assertAssistantHistorySendable(safeRequest);
    // Same per-request alias map as generate(): built from the exact exposed
    // tool set and shared by outbound payload assembly and inbound resolution.
    const aliasMap = ToolNameAliasMap.fromToolSchemas(safeRequest.toolSchemas);
    const payload = buildDeepSeekPayload(
      safeRequest,
      this.config.model,
      this.config.reasoningProfile,
      true,
      aliasMap,
    );
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const url = `${base}/chat/completions`;

    // Retry discipline (TASK-0007 hardening): every network attempt owns a
    // FRESH AbortController and a FRESH timeout budget, both cleaned up when
    // the attempt ends - no controller/timeout is ever shared across retry
    // attempts. A timeout BEFORE any consumer-visible stream data is a
    // transient failure and is retried within the bounded attempt budget;
    // once any event has been yielded, the stream never retries (a fresh
    // attempt would replay already-delivered text/tool-call content). Caller
    // cancellation aborts the current attempt and never retries.
    const attempts = Math.max(0, this.config.retryMaxAttempts) + 1;
    let attempt = 0;
    let lastError: unknown;
    let lastKind: StreamFailureKind | undefined;
    const streamStartedAt = Date.now();

    while (attempt < attempts) {
      if (signal?.aborted) {
        this.logger?.info("deepseek.stream.caller_aborted", {
          attempt,
          max_attempts: attempts,
          emitted_any: false,
        });
        return;
      }
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1, this.config.retryBaseDelayMs);
        await this.sleepFn(delay);
        if (signal?.aborted) {
          this.logger?.info("deepseek.stream.caller_aborted", {
            attempt,
            max_attempts: attempts,
            emitted_any: false,
          });
          return;
        }
      }
      attempt += 1;

      const controller = new AbortController();
      const onAbort = (): void => {
        try { controller.abort(signal?.reason); } catch { /* noop */ }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      // Fresh per attempt: fragments accumulated by a failed attempt must
      // never leak into a retry's tool-call state.
      const toolAccumulators = new Map<number, ToolCallAccumulator>();
      let doneYielded = false;
      let emittedAny = false;
      const finalizeToolCalls = (): ProposedToolCall[] => {
        const calls: ProposedToolCall[] = [];
        for (const acc of toolAccumulators.values()) {
          let args: Record<string, unknown> = {};
          if (acc.argumentsJson.trim() !== "") {
            try {
              const parsed: unknown = JSON.parse(acc.argumentsJson);
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new ProviderBadResponseError("tool call arguments are not a JSON object");
              }
              args = parsed as Record<string, unknown>;
            } catch (err) {
              if (err instanceof ProviderBadResponseError) throw err;
              throw new ProviderBadResponseError("tool call arguments are not valid JSON");
            }
          }
          if (acc.name.trim() === "") {
            throw new ProviderBadResponseError("tool call is missing a function name");
          }
          calls.push({
            id: acc.id !== "" ? acc.id : randomUUID(),
            // Resolution only after the function name is complete (accumulated
            // across all SSE fragments). Unknown/never-exposed names throw and
            // fail the stream closed.
            name: resolveInboundToolName(acc.name, aliasMap),
            arguments: args,
          });
        }
        return calls;
      };

      const attemptStartedAt = Date.now();
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: redactText(JSON.stringify(payload), [this.config.apiKey]),
          signal: controller.signal,
        });
        // Non-2xx responses are parsed and classified BEFORE any chunk
        // validation: an HTTP error is never reported as a malformed response.
        if (!response.ok) {
          await classifyHttpError(response, [this.config.apiKey]);
        }
        const body = response.body;
        if (!body) throw new ProviderBadResponseError("streaming response has no body");
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
              buffer = buffer.slice(newlineIndex + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") {
                if (!doneYielded) {
                  doneYielded = true;
                  for (const call of finalizeToolCalls()) {
                    emittedAny = true;
                    yield { type: "tool_call", call };
                  }
                  emittedAny = true;
                  yield { type: "done", finish_reason: "stop" };
                }
                this.logger?.info("deepseek.stream.completed", {
                  attempts: attempt,
                  max_attempts: attempts,
                  total_ms: Date.now() - streamStartedAt,
                });
                return;
              }
              if (data === "") continue;
              let parsed: unknown;
              try {
                parsed = JSON.parse(data);
              } catch {
                throw new ProviderBadResponseError(MALFORMED_SSE_MESSAGE);
              }
              const events = parseDeepSeekStreamChunk(parsed, toolAccumulators);
              if (events) {
                for (const event of events) {
                  if (event.type === "done") {
                    if (!doneYielded) {
                      doneYielded = true;
                      for (const call of finalizeToolCalls()) {
                        emittedAny = true;
                        yield { type: "tool_call", call };
                      }
                      emittedAny = true;
                      yield event;
                    }
                  } else {
                    emittedAny = true;
                    yield event;
                  }
                }
              }
            }
            if (signal?.aborted) {
              this.logger?.info("deepseek.stream.caller_aborted", {
                attempt,
                max_attempts: attempts,
                emitted_any: emittedAny,
              });
              return;
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!doneYielded) {
          if (signal?.aborted) return;
          throw new ProviderBadResponseError("stream ended without [DONE]");
        }
        return;
      } catch (err) {
        const attemptDurationMs = Date.now() - attemptStartedAt;
        if (signal?.aborted) {
          // Caller cancellation: never retried, never surfaced as failure.
          this.logger?.info("deepseek.stream.caller_aborted", {
            attempt,
            max_attempts: attempts,
            emitted_any: emittedAny,
            duration_ms: attemptDurationMs,
          });
          return;
        }
        // The attempt-level timeout fired (this attempt's controller, never
        // the caller's signal - that case returned above).
        const timedOut = isAbortError(err) || (controller.signal.aborted && !signal?.aborted);
        const diagnosis = classifyStreamFailure(err, timedOut);
        this.logger?.warn("deepseek.stream.attempt_failed", {
          kind: diagnosis.kind,
          http_status: diagnosis.http_status ?? null,
          attempt,
          max_attempts: attempts,
          emitted_any: emittedAny,
          duration_ms: attemptDurationMs,
          error_name: diagnosis.error_name ?? null,
          error_message: diagnosis.error_message ?? null,
        });
        if (
          err instanceof ProviderAuthError ||
          err instanceof ProviderBadResponseError ||
          err instanceof DeepSeekRequestRejectedError
        ) {
          throw err;
        }
        if (emittedAny) {
          // Never retry after consumer-visible data: a fresh attempt would
          // duplicate already-delivered text/tool-call events.
          if (timedOut) throw new ProviderTimeoutError();
          throw err instanceof ProviderUnavailableError
            ? err
            : new ProviderUnavailableError(err instanceof Error ? err.message : "network failure");
        }
        lastError = timedOut
          ? new ProviderTimeoutError()
          : err instanceof ProviderUnavailableError
            ? err
            : new ProviderUnavailableError(err instanceof Error ? err.message : "network failure");
        lastKind = diagnosis.kind;
        // continue to next attempt (transient failure before any data)
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }

    // Bounded retry budget exhausted without any consumer-visible event.
    this.logger?.warn("deepseek.stream.retries_exhausted", {
      attempts: attempt,
      max_attempts: attempts,
      emitted_any: false,
      last_kind: lastKind ?? null,
      total_ms: Date.now() - streamStartedAt,
    });
    throw lastError instanceof Error ? lastError : new ProviderUnavailableError();
  }
}