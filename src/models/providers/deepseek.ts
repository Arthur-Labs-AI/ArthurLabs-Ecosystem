/**
 * DeepSeek provider adapter (spec section 7).
 *
 * The only place in the codebase that knows about the DeepSeek HTTP API. It
 * authenticates with a secret, applies a finite timeout, retries only transient
 * failures with bounded exponential backoff + jitter, maps the ARTHUR reasoning
 * profile, and immediately normalizes the vendor response into `ModelResult`.
 * No SDK object ever leaves this file, and the secret is never logged.
 */

import { randomUUID } from "node:crypto";
import {
  ChatMessage,
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResult,
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

export interface DeepSeekProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  reasoningProfile: ReasoningProfile;
}

export interface DeepSeekProviderDeps {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
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

// ---- Payload assembly (pure; redaction applied by the caller's logger) ---

function chatMessageToOpenAI(message: ChatMessage): Record<string, unknown> {
  const msg: Record<string, unknown> = {
    role: message.role,
    content: message.content === "" ? null : message.content,
  };
  if (message.name) msg.name = message.name;
  if (message.tool_call_id) msg.tool_call_id = message.tool_call_id;
  if (message.tool_calls && message.tool_calls.length > 0) {
    msg.tool_calls = message.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
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
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  messages.push({ role: "system", content: request.systemContract });
  if (request.modeContract) {
    messages.push({ role: "system", content: request.modeContract });
  }
  for (const historyMessage of request.history) {
    messages.push(chatMessageToOpenAI(historyMessage));
  }
  if (request.userMessage !== "") {
    messages.push({ role: "user", content: request.userMessage });
  }

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    ...reasoningParams(profile),
  };

  if (request.toolSchemas.length > 0) {
    payload.tools = request.toolSchemas.map((schema) => ({
      type: "function",
      function: {
        name: schema.name,
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

export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (raw === undefined || raw === null) return undefined;
  const u = requireObject(raw, "usage");
  const usage: TokenUsage = {};
  usage.input_tokens = optionalTokenCount(u.prompt_tokens, "prompt_tokens");
  usage.output_tokens = optionalTokenCount(u.completion_tokens, "completion_tokens");
  usage.total_tokens = optionalTokenCount(u.total_tokens, "total_tokens");
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

export function normalizeDeepSeekResponse(body: unknown, fallbackRequestId?: string): ModelResult {
  try {
    const b = requireObject(body, "response body");
    const choices = b.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderBadResponseError("response has no choices");
    }
    const choice = requireObject(choices[0], "choice");
    const message = requireObject(choice.message, "choice message");

    let assistant_text = "";
    if (message.content !== undefined && message.content !== null) {
      if (typeof message.content !== "string") {
        throw new ProviderBadResponseError("message content is not a string");
      }
      assistant_text = message.content;
      if (assistant_text.length > MAX_ASSISTANT_TEXT_CHARS) {
        throw new ProviderBadResponseError("assistant content exceeds size limit");
      }
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== "string") {
      throw new ProviderBadResponseError("finish_reason is not a string");
    }
    if (b.id !== undefined && b.id !== null && typeof b.id !== "string") {
      throw new ProviderBadResponseError("response id is not a string");
    }

    const tool_calls = parseToolCalls(message.tool_calls);
    if (assistant_text === "" && tool_calls.length === 0) {
      throw new ProviderBadResponseError("response contains neither text nor tool calls");
    }

    return {
      assistant_text,
      tool_calls,
      usage: normalizeUsage(b.usage),
      finish_reason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
      raw_provider_id: typeof b.id === "string" ? b.id : fallbackRequestId,
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

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Provider ------------------------------------------------------------

export class DeepSeekProvider implements ModelProvider {
  private readonly config: DeepSeekProviderConfig;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(config: DeepSeekProviderConfig, deps: DeepSeekProviderDeps = {}) {
    this.config = config;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleepFn = deps.sleepFn ?? defaultSleep;
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
    const payload = buildDeepSeekPayload(safeRequest, this.config.model, this.config.reasoningProfile);
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

        if (response.status === 401 || response.status === 403) {
          throw new ProviderAuthError();
        }
        if (!response.ok) {
          if (isTransientHttpStatus(response.status)) {
            throw new ProviderUnavailableError(`DeepSeek HTTP ${response.status}`);
          }
          throw new ProviderBadResponseError(`DeepSeek HTTP ${response.status}`);
        }

        const text = await readBodyWithLimit(response, MAX_RESPONSE_BYTES);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new ProviderBadResponseError("response body is not valid JSON");
        }
        return normalizeDeepSeekResponse(body, undefined);
      } catch (err) {
        if (err instanceof ProviderAuthError || err instanceof ProviderBadResponseError) {
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
}
