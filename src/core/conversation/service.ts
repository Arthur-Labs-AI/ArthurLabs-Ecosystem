/**
 * Conversation service (spec sections 4, 6, 9, 12; audit HIGH 3/4/5, MEDIUM 6).
 *
 * The local orchestration core. It depends on `ModelGateway` (never a provider)
 * and the tool orchestrator, persists every turn, and fails closed on invalid
 * input, provider errors, or unapproved actions.
 *
 * Idempotency is driven by a dedicated `idempotency_keys` state machine that is
 * reserved atomically before any session/turn state is created, so concurrent
 * retries and crash recovery cannot duplicate state or leak a cached response
 * for a different request.
 */

import { invalidRequest, modeViolation, sessionNotFound, toArthurError } from "../errors/errors";
import type { ChatMessage, ModelGateway, ModelResult } from "../../models/contracts";
import { Logger } from "../../observability/logging";
import { Metrics } from "../../observability/metrics";
import { newId, newSessionId, newTraceId, newTurnId } from "../../observability/tracing";
import type { Settings } from "../../config/settings";
import type { SessionStore } from "../../sessions/store";
import type { SessionRecord, TurnRecord } from "../../sessions/models";
import { SecretSanitizer } from "../../security/sanitize";
import { toToolSchema, ToolRegistry } from "../../tools/registry";
import type { ToolOrchestrator } from "../../tools/orchestrator";
import { ToolExecutionContext } from "../../tools/contracts";
import { ContextBuilder } from "./context_builder";
import {
  ApprovalOutcome,
  ModeChangeResult,
  SessionSummary,
  ToolCallSummary,
  TurnRequest,
  TurnResponse,
  TurnResponseModel,
  TurnStatus,
} from "./models";
import { idempotencyKey, parseModeChange, parseTurnRequest, requestHash } from "./validation";

export interface AfterTurnInput {
  session: SessionRecord;
  turnId: string;
  traceId: string;
  userMessage: string;
  assistantText: string;
  history: TurnRecord[];
}

export interface ConversationServiceDeps {
  gateway: ModelGateway;
  store: SessionStore;
  contextBuilder: ContextBuilder;
  orchestrator: ToolOrchestrator;
  registry: ToolRegistry;
  sanitizer: SecretSanitizer;
  config: Settings;
  logger: Logger;
  metrics: Metrics;
  /**
   * Optional post-turn hook (Phase 2: automatic memory extraction). Must never
   * fail the turn; the service wraps it in its own error handling.
   */
  afterTurn?: (input: AfterTurnInput) => Promise<void>;
}

export interface StatusInfo {
  version: string;
  env: string;
  provider: string;
  model: string;
  reasoningProfile: string;
  capabilities: unknown;
}

export class ConversationService {
  private readonly gateway: ModelGateway;
  private readonly store: SessionStore;
  private readonly contextBuilder: ContextBuilder;
  private readonly orchestrator: ToolOrchestrator;
  private readonly registry: ToolRegistry;
  private readonly sanitizer: SecretSanitizer;
  private readonly config: Settings;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly afterTurn?: (input: AfterTurnInput) => Promise<void>;
  private readonly idempotencyStaleMs: number;

  constructor(deps: ConversationServiceDeps) {
    this.gateway = deps.gateway;
    this.store = deps.store;
    this.contextBuilder = deps.contextBuilder;
    this.orchestrator = deps.orchestrator;
    this.registry = deps.registry;
    this.sanitizer = deps.sanitizer;
    this.config = deps.config;
    this.logger = deps.logger.child("conversation");
    this.metrics = deps.metrics;
    this.afterTurn = deps.afterTurn;
    // An in_progress idempotency record older than a full retry budget is a
    // crashed prior attempt and may be adopted safely.
    this.idempotencyStaleMs = this.config.modelTimeoutSeconds * 1000 * (this.config.retryMaxAttempts + 2);
  }

  async handleTurn(rawInput: unknown): Promise<TurnResponse> {
    const request = parseTurnRequest(rawInput, this.config.maxMessageChars);
    // Validate the current session and mode before any cached replay. A response
    // from an older mode must never bypass today's server-side mode check.
    if (request.session_id) {
      const current = this.store.getSession(request.session_id);
      if (!current) throw sessionNotFound(request.session_id);
      if (current.mode !== request.mode) {
        throw modeViolation(`Session ${current.id} is in ${current.mode} mode; use the mode-change endpoint to switch modes`, {
          session_id: current.id,
          session_mode: current.mode,
          requested_mode: request.mode,
        });
      }
    }
    const key = idempotencyKey(request);
    const hash = requestHash(request);

    // Atomic reservation BEFORE any session/turn state is created (HIGH 3).
    const begin = this.store.beginIdempotency(key, request.client_request_id, hash, this.idempotencyStaleMs);
    switch (begin.kind) {
      case "replay":
        this.logger.info("idempotent replay", {
          client_request_id: request.client_request_id,
        });
        return JSON.parse(begin.responseJson) as TurnResponse;
      case "conflict":
        throw invalidRequest("client_request_id was already used for a different request", {
          client_request_id: request.client_request_id,
        });
      case "in_progress":
        throw invalidRequest("A request with this client_request_id is already in progress", {
          client_request_id: request.client_request_id,
        });
      case "failed":
        throw invalidRequest("A previous attempt with this client_request_id did not complete; use a new id", {
          client_request_id: request.client_request_id,
        });
      case "proceed":
        break;
    }

    try {
      const response = await this.processTurn(request, key);
      this.store.finalizeIdempotentTurn({
        idempotencyId: key,
        assistant: {
          id: newTurnId(),
          sessionId: response.session_id,
          text: response.display_text,
          traceId: response.trace_id,
          status: response.status,
          mode: response.mode,
        },
        responseJson: JSON.stringify(response),
      });
      return response;
    } catch (err) {
      this.store.failIdempotency(key);
      throw err;
    }
  }

  private async processTurn(request: TurnRequest, idempotencyId: string): Promise<TurnResponse> {
    const traceId = newTraceId();
    const startedAt = Date.now();
    const turnId = newTurnId();
    // Secret-safety boundary: the sanitized message is what is persisted, sent
    // to the model, and returned to clients (HIGH 5).
    const safeMessage = this.sanitizer.sanitizeText(request.message);

    let session: SessionRecord;
    let history: TurnRecord[];
    if (request.session_id) {
      const existing = this.store.getSession(request.session_id);
      if (!existing) {
        throw sessionNotFound(request.session_id);
      }
      if (existing.mode !== request.mode) {
        throw modeViolation(
          `Session ${existing.id} is in ${existing.mode} mode; use the mode-change endpoint to switch modes`,
          { session_id: existing.id, session_mode: existing.mode, requested_mode: request.mode },
        );
      }
      session = existing;
      // Mode-partitioned history: only turns from the current mode are included
      // (HIGH 4), and only BEFORE the new user message is persisted.
      history = this.store.getRecentTurns(session.id, session.mode, this.config.historyMaxTurns);
      this.store.createUserTurnForIdempotency({
        idempotencyId,
        id: turnId,
        sessionId: session.id,
        text: safeMessage,
        traceId,
        mode: session.mode,
      });
    } else {
      // Atomic session + first user turn (MEDIUM 6).
      session = this.store.createSessionAndUserTurn({
        sessionId: newSessionId(),
        mode: request.mode,
        idempotencyId,
        turn: { id: turnId, text: safeMessage, traceId },
      });
      history = [];
    }

    const allowedTools = this.registry.listAllowedForMode(session.mode);
    const builtModelRequest = await this.contextBuilder.build({
      mode: session.mode,
      history,
      toolSchemas: allowedTools.map(toToolSchema),
      userMessage: safeMessage,
      model: this.config.modelName,
      reasoningProfile: this.config.reasoningProfile,
      traceId,
      sessionId: session.id,
      clientRequestId: request.client_request_id,
    });
    // Final provider-agnostic payload boundary: sanitize history, context-source
    // blocks, schemas, metadata, and current text before any ModelGateway call.
    const modelRequest = this.sanitizer.sanitizeValue(builtModelRequest);

    this.logger.info("turn started", {
      trace_id: traceId,
      session_id: session.id,
      turn_id: turnId,
      mode: session.mode,
      client_type: request.metadata?.client_type,
    });

    // Primary model call.
    let modelResult: ModelResult;
    let latencyMs: number;
    try {
      const t0 = Date.now();
      modelResult = await this.gateway.generate(modelRequest);
      latencyMs = Date.now() - t0;
    } catch (err) {
      const arthurErr = toArthurError(err);
      this.recordModelCall(turnId, "failed", Date.now() - startedAt, undefined);
      this.store.transaction(() => {
        this.store.createTurn({
          id: newTurnId(),
          sessionId: session.id,
          role: "assistant",
          text: "",
          traceId,
          status: "failed",
          mode: session.mode,
        });
        this.store.failIdempotency(idempotencyId);
      });
      this.logger.error("model generation failed", {
        trace_id: traceId,
        session_id: session.id,
        turn_id: turnId,
        code: arthurErr.code,
      });
      this.metrics.counter("arthur.model.failed", 1, { code: arthurErr.code });
      throw arthurErr;
    }

    this.recordModelCall(turnId, "success", latencyMs, modelResult);
    this.metrics.timer("arthur.model.latency_ms", latencyMs, { provider: this.gateway.id });

    // Orchestrate proposed tool calls (validate + permission + execute/approve).
    const ctx: ToolExecutionContext = {
      session_id: session.id,
      turn_id: turnId,
      trace_id: traceId,
      mode: session.mode,
      approved: false,
    };
    const handling = await this.orchestrator.handleProposed(modelResult.tool_calls, ctx);

    let finalText = this.sanitizer.sanitizeText(modelResult.assistant_text);
    let finalLatencyMs = latencyMs;
    let finalUsage = modelResult.usage;
    let finalStatus: TurnStatus = "completed";

    if (handling.needsApproval) {
      finalStatus = "needs_approval";
      finalText =
        finalText.trim() !== "" ? finalText : "(requesting approval to run a tool)";
    } else if (handling.toolResultMessages.length > 0) {
      // Bounded Phase 1 response loop: feed executed tool results back once.
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: finalText,
        tool_calls: modelResult.tool_calls,
      };
      const followupRequest = this.contextBuilder.buildFollowup(modelRequest, assistantMessage, handling.toolResultMessages);
      const followupStarted = Date.now();
      try {
        const followup = await this.gateway.generate(followupRequest);
        finalLatencyMs = Date.now() - followupStarted;
        finalText = this.sanitizer.sanitizeText(followup.assistant_text);
        finalUsage = followup.usage;
        this.recordModelCall(turnId, "success", finalLatencyMs, followup);
      } catch (err) {
        const arthurErr = toArthurError(err);
        this.recordModelCall(turnId, "failed", Date.now() - followupStarted, undefined);
        this.logger.warn("follow-up model call failed; returning tool results", {
          trace_id: traceId,
          session_id: session.id,
          turn_id: turnId,
          code: arthurErr.code,
        });
        finalText =
          finalText.trim() !== ""
            ? finalText
            : handling.toolResultMessages.map((m) => m.content).join("\n");
      }
    }

    this.logger.info("turn completed", {
      trace_id: traceId,
      session_id: session.id,
      turn_id: turnId,
      status: finalStatus,
      total_ms: Date.now() - startedAt,
      tool_calls: handling.summaries.length,
    });
    this.metrics.counter("arthur.turn", 1, { status: finalStatus });

    // Phase 2: bounded post-turn memory extraction. Failures are swallowed and
    // never affect the conversation response (spec section 36).
    if (this.afterTurn && finalStatus === "completed") {
      try {
        await this.afterTurn({
          session,
          turnId,
          traceId,
          userMessage: safeMessage,
          assistantText: finalText,
          history,
        });
      } catch (err) {
        this.logger.warn("post-turn hook failed; conversation continues", {
          trace_id: traceId,
          session_id: session.id,
          turn_id: turnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.buildResponse(
      session,
      turnId,
      traceId,
      finalText,
      finalStatus,
      handling.summaries,
      finalLatencyMs,
      finalUsage,
    );
  }

  async getSession(id: string): Promise<SessionSummary> {
    const session = this.store.getSession(id);
    if (!session) {
      throw sessionNotFound(id);
    }
    const turns = this.store.getTurns(id).map((t) => ({
      id: t.id,
      role: t.role,
      text: t.text,
      created_at: t.created_at,
      status: t.status,
      mode: t.mode,
    }));
    return {
      id: session.id,
      mode: session.mode,
      created_at: session.created_at,
      updated_at: session.updated_at,
      status: session.status,
      turns,
    };
  }

  async changeMode(id: string, rawInput: unknown): Promise<ModeChangeResult> {
    const { mode } = parseModeChange(rawInput);
    const session = this.store.getSession(id);
    if (!session) {
      throw sessionNotFound(id);
    }
    if (session.mode === mode) {
      return { session_id: id, from: session.mode, to: mode };
    }
    // Atomic mode update + boundary marker (MEDIUM 6 / HIGH 4).
    this.store.changeModeAtomic(id, mode, {
      id: newTurnId(),
      text: `Mode changed from ${session.mode} to ${mode}`,
      traceId: newTraceId(),
    });
    this.logger.info("session mode changed", { session_id: id, from: session.mode, to: mode });
    return { session_id: id, from: session.mode, to: mode };
  }

  async approve(approvalId: string): Promise<ApprovalOutcome> {
    return this.orchestrator.executeApproval(approvalId);
  }

  async reject(approvalId: string): Promise<ApprovalOutcome> {
    return this.orchestrator.rejectApproval(approvalId);
  }

  getStatus(): StatusInfo {
    return {
      version: this.config.version,
      env: this.config.env,
      provider: this.gateway.id,
      model: this.config.modelName,
      reasoningProfile: this.config.reasoningProfile,
      capabilities: this.gateway.capabilities(),
    };
  }

  listPendingApprovals(sessionId?: string) {
    return this.store.listPendingApprovals(sessionId);
  }

  // ---- helpers -----------------------------------------------------------

  private recordModelCall(
    turnId: string,
    status: "success" | "failed",
    latencyMs: number,
    result: ModelResult | undefined,
  ): void {
    this.store.createModelCall({
      id: newId(),
      turnId,
      provider: this.gateway.id,
      model: this.config.modelName,
      latencyMs,
      status,
      inputTokens: result?.usage?.input_tokens,
      outputTokens: result?.usage?.output_tokens,
      cachedTokens: result?.usage?.cached_tokens,
      providerRequestId: result?.raw_provider_id,
    });
  }

  private buildResponse(
    session: SessionRecord,
    turnId: string,
    traceId: string,
    text: string,
    status: TurnStatus,
    toolCalls: ToolCallSummary[],
    latencyMs: number,
    usage: ModelResult["usage"],
  ): TurnResponse {
    const model: TurnResponseModel = {
      provider: this.gateway.id,
      model: this.config.modelName,
      latency_ms: latencyMs,
    };
    if (usage?.input_tokens !== undefined) model.input_tokens = usage.input_tokens;
    if (usage?.output_tokens !== undefined) model.output_tokens = usage.output_tokens;
    if (usage?.cached_tokens !== undefined) model.cached_tokens = usage.cached_tokens;
    return {
      session_id: session.id,
      turn_id: turnId,
      trace_id: traceId,
      mode: session.mode,
      speech_text: text,
      display_text: text,
      status,
      tool_calls: toolCalls,
      model,
    };
  }
}