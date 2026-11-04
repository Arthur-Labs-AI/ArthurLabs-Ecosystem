/**
 * Provider-agnostic model contracts (spec sections 6.4, 6.5, 7, 8).
 *
 * Core/business logic depends only on `ModelGateway`, never on a specific
 * provider SDK. Providers normalize their vendor responses into `ModelResult`
 * immediately so no SDK object ever crosses this boundary.
 */

import type { ArthurMode } from "../core/modes/mode";
import type { TokenUsage } from "../observability/usage";

/** ARTHUR-level reasoning profile (spec section 7 "Reasoning"). */
export type ReasoningProfile = "fast" | "normal" | "deep";

export interface ModelCapabilities {
  id: string;
  modelName: string;
  supportsTools: boolean;
  supportsReasoning: boolean;
  maxContextTokens: number;
  /** Whether the provider can actually reach the network (fake = false). */
  online: boolean;
}

/** A normalized tool call proposed by the model (never executed directly). */
export interface ProposedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A single chat message handed to the provider. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  /** Present on assistant messages that proposed tool calls. */
  tool_calls?: ProposedToolCall[];
}

/** JSON-schema-shaped tool description handed to the model (spec section 10). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Assembled turn context (spec section 8).
 * system_contract + mode_contract + recent_session_history + allowed_tool_schemas
 * + current_user_message. Nothing else is ever included automatically.
 */
export interface ModelRequest {
  systemContract: string;
  modeContract: string;
  history: ChatMessage[];
  toolSchemas: ToolSchema[];
  userMessage: string;
  model: string;
  reasoningProfile: ReasoningProfile;
  /** Operational correlation, never sent to the provider as prompt content. */
  traceId?: string;
  sessionId?: string;
  clientRequestId?: string;
  /** Structured metadata about memory snippets included in history (Phase 2). */
  memory?: { domain: string; context_tokens: number; included: number };
}

/** Structured, normalized model result (spec section 6.5). */
export interface ModelResult {
  assistant_text: string;
  tool_calls: ProposedToolCall[];
  usage?: TokenUsage;
  finish_reason: string;
  raw_provider_id?: string;
}

export interface ModelProvider {
  id(): string;
  capabilities(): ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResult>;
}

// ---- Streaming (Phase 3 spec section 15) --------------------------------

/**
 * Streaming model event normalized from the provider transport (DeepSeek SSE
 * or a fake stream). Partial text is never persisted as a final assistant
 * turn until the stream reaches a valid terminal state.
 */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ProposedToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; finish_reason: string };

/**
 * Optional streaming capability. Non-streaming providers remain supported:
 * the ModelGateway falls back to a single buffered generate() result.
 */
export interface StreamingModelProvider extends ModelProvider {
  generateStream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

export interface StreamingModelGateway {
  generateStream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}


export interface ModelGateway {
  readonly id: string;
  capabilities(): ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResult>;
  /**
   * Streaming generation (Phase 3 spec section 15). Providers without native
   * streaming fall back to a single buffered result; the signal is honored.
   */
  generateStream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

// ---- Provider-level error types (mapped to ArthurError at the gateway) ----

export class ProviderTimeoutError extends Error {
  constructor(message = "Model provider timed out") {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message = "Model provider is unavailable") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderAuthError extends Error {
  constructor(message = "Model provider rejected authentication") {
    super(message);
    this.name = "ProviderAuthError";
  }
}

export class ProviderBadResponseError extends Error {
  constructor(message = "Model provider returned a malformed response") {
    super(message);
    this.name = "ProviderBadResponseError";
  }
}