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

import { ArthurError, type ErrorCode, invalidRequest, modeViolation, sessionNotFound, toArthurError } from "../errors/errors";
import type { ModelGateway, ModelResult } from "../../models/contracts";
import { Logger } from "../../observability/logging";
import { Metrics } from "../../observability/metrics";
import { newId, newSessionId, newTraceId, newTurnId } from "../../observability/tracing";
import { ConversationLoopRunner, type LoopEvent } from "./loop_runner";
import { ModelRouter } from "../../runtime/model_router";
import type { RuntimeMode } from "../../runtime/runtime_mode";
import type { Settings } from "../../config/settings";
import type { SessionStore } from "../../sessions/store";
import type { SessionRecord, TurnRecord } from "../../sessions/models";
import { SecretSanitizer } from "../../security/sanitize";
import { toToolSchema, ToolRegistry } from "../../tools/registry";
import type { ToolOrchestrator } from "../../tools/orchestrator";
import { ToolDefinition } from "../../tools/contracts";
import type { ArthurMode } from "../modes/mode";
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
import type { StreamingTurnEvent } from "./streaming_service";
import { idempotencyKey, parseModeChange, parseTurnRequest, requestHash } from "./validation";
import type { TurnRequest as ValidatedTurnRequest } from "./models";

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
  /**
   * Explicit trusted execution locality of the model provider behind
   * `gateway` (composition-root metadata — never inferred from
   * capabilities().online, ids, names, URLs, or network state). Required
   * only when `gateway` is a raw ModelGateway; ignored when `gateway` is
   * already a ModelRouter (which carries its own locality). DeepSeek =>
   * "cloud"; in-process fake => "local".
   */
  modelLocality?: RuntimeMode;
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

/**
 * Deep-frozen structured clone of a tool manifest. Definitions are cloned so a
 * caller holding an older snapshot can never be affected by (or affect) later
 * registry state; freezing makes the returned view read-only.
 */
function frozenToolDefinition(definition: ToolDefinition): ToolDefinition {
  const clone = structuredClone(definition) as ToolDefinition;
  deepFreezeValue(clone);
  return clone;
}

function deepFreezeValue(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeValue(child);
  }
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
  private readonly modelLocality: RuntimeMode;
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
    // Default "local" keeps directly-constructed test services honest when
    // no locality is stated (in-process fake); production always passes the
    // explicit value via buildApp. Never derived from capabilities().online.
    this.modelLocality = deps.modelLocality ?? "local";
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

  /**
   * Shared turn bootstrap (SC-06 §77-78): session/history/user-turn creation
   * plus the frozen BaseTurnContext. Runs ONCE per turn; memory retrieval and
   * tool schemas are frozen here and never re-queried between loop rounds.
   */
  private async bootstrapTurn(
    request: ValidatedTurnRequest,
    key: string,
  ): Promise<{
    session: SessionRecord;
    history: TurnRecord[];
    turnId: string;
    traceId: string;
    startedAt: number;
    safeMessage: string;
    modelRequest: import("../../models/contracts").ModelRequest;
  }> {
    const traceId = newTraceId();
    const startedAt = Date.now();
    const turnId = newTurnId();
    const safeMessage = this.sanitizer.sanitizeText(request.message);
    let session: SessionRecord;
    let history: TurnRecord[];
    if (request.session_id) {
      const existing = this.store.getSession(request.session_id);
      if (!existing) throw sessionNotFound(request.session_id);
      if (existing.mode !== request.mode) {
        throw modeViolation(
          `Session ${existing.id} is in ${existing.mode} mode; use the mode-change endpoint to switch modes`,
          { session_id: existing.id, session_mode: existing.mode, requested_mode: request.mode },
        );
      }
      session = existing;
      history = this.store.getRecentTurns(session.id, session.mode, this.config.historyMaxTurns);
      this.store.createUserTurnForIdempotency({
        idempotencyId: key,
        id: turnId,
        sessionId: session.id,
        text: safeMessage,
        traceId,
        mode: session.mode,
      });
    } else {
      session = this.store.createSessionAndUserTurn({
        sessionId: newSessionId(),
        mode: request.mode,
        idempotencyId: key,
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
    const modelRequest = this.sanitizer.sanitizeValue(builtModelRequest);
    return { session, history, turnId, traceId, startedAt, safeMessage, modelRequest };
  }

  /**
   * Build the single authoritative loop runner for this service.
   *
   * HR-01 ModelRouter seam: ConversationLoopRunner -> ModelRouter ->
   * ModelProvider. The service holds whatever ModelGateway buildApp wired
   * (normally the ModelRouter already); when a raw gateway arrives (tests
   * composing ConversationService directly), wrap it once so the loop
   * always runs behind the router. The wrap is idempotent: an existing
   * ModelRouter is reused, never double-wrapped. Locality for a raw gateway
   * comes ONLY from the explicit `modelLocality` construction metadata —
   * capabilities().online (network capability) must never determine
   * RuntimeMode (execution locality): a LAN model may be offline-capable, a
   * local model may have internet access, and a cloud provider may be
   * temporarily unavailable, all without changing where it executes.
   * SC-06 semantics are untouched — the router only selects the configured
   * provider.
   */
  /**
   * Resolve the single authoritative model gateway for the loop: an injected
   * ModelRouter is reused as-is (never rewrapped); a raw ModelGateway is
   * wrapped once with the explicit `modelLocality` construction metadata.
   */
  private resolveModelGateway(): ModelGateway {
    if (this.gateway instanceof ModelRouter) return this.gateway;
    return new ModelRouter({ gateway: this.gateway, locality: this.modelLocality });
  }

  /**
   * HR-01 test seam: the effective loop gateway (ModelRouter) with its
   * routing decision. Read-only; the loop always runs behind this gateway.
   */
  modelRouterForTests(): ModelRouter {
    const gateway = this.resolveModelGateway();
    if (!(gateway instanceof ModelRouter)) throw new Error("model gateway did not resolve to a ModelRouter");
    return gateway;
  }

  private createLoopRunner(): ConversationLoopRunner {
    const gateway = this.resolveModelGateway();
    return new ConversationLoopRunner({
      gateway,
      store: this.store,
      contextBuilder: this.contextBuilder,
      orchestrator: this.orchestrator,
      registry: this.registry,
      sanitizer: this.sanitizer,
      config: {
        modelName: this.config.modelName,
        loopMaxRounds: this.config.loopMaxRounds,
        loopMaxCallsPerRound: this.config.loopMaxCallsPerRound,
        loopMaxCallsTotal: this.config.loopMaxCallsTotal,
        loopMaxResultBytes: this.config.loopMaxResultBytes,
        loopMaxActiveMs: this.config.loopMaxActiveMs,
        loopRepeatLimit: this.config.loopRepeatLimit,
      },
      logger: this.logger,
      metrics: this.metrics,
    });
  }

  /**
   * Streaming turn (Phase 3 spec section 15; SC-06 section 4).
   *
   * NOT a second core: yields the LoopEvents of the shared
   * ConversationLoopRunner. Identical request validation, session/mode
   * checks, sanitization, context assembly, tool orchestration, approval
   * binding, idempotency and persistence as the text path. Intermediate
   * (provisional) round text is yielded for observability but only the final
   * round text becomes turn_completed.display_text, so voice never speaks
   * intermediate model output as final truth. The assistant turn is persisted
   * ONLY at a valid terminal state (completed / needs_approval /
   * interrupted / failed). Cancellation via `signal` persists an
   * `interrupted` audit turn instead of a completed answer.
   */
  async *streamTurn(rawInput: unknown, signal?: AbortSignal): AsyncGenerator<StreamingTurnEvent> {
    const request = parseTurnRequest(rawInput, this.config.maxMessageChars);
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
    const begin = this.store.beginIdempotency(key, request.client_request_id, hash, this.idempotencyStaleMs);
    switch (begin.kind) {
      case "replay":
        // A voice turn is a fresh operation; a reused client_request_id must
        // not replay an unrelated cached response into the audio path.
        throw invalidRequest("client_request_id was already used for a completed request", {
          client_request_id: request.client_request_id,
        });
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

    // SC-06 §4: streamTurn drives the SAME loop as handleTurn; the runner
    // owns model rounds, tool execution, budgets, and stop decisions.
    const loopRunId = newId();
    let boot: Awaited<ReturnType<ConversationService["bootstrapTurn"]>>;
    try {
      boot = await this.bootstrapTurn(request, key);
    } catch (err) {
      this.store.failIdempotency(key);
      throw err;
    }
    const { session, history, turnId, traceId, startedAt, safeMessage, modelRequest } = boot;
    const runner = this.createLoopRunner();
    const loopInput = {
      loopRunId,
      sessionId: session.id,
      turnId,
      traceId,
      mode: session.mode,
      clientRequestId: request.client_request_id,
      safeMessage,
      history,
      baseRequest: modelRequest,
      signal,
      transport: "stream" as const,
    };
    try {
      // Provisional per-round text buffer (§14): intermediate assistant text
      // is yielded for observability, but ONLY the final round text becomes
      // turn_completed.display_text — never spoken as truth early (§13).
      let provisionalText = "";
      let finalText = "";
      let finalStatus: TurnStatus = "completed";
      let finalToolCalls: ToolCallSummary[] = [];
      let finalUsage: ModelResult["usage"];
      let finalModel: import("./models").TurnResponseModel | undefined;
      let streamFailed: { code: string; message: string } | undefined;
      let interruptedPartial = "";
      let firstTokenAt: number | undefined;
      const streamT0 = Date.now();

      yield {
        type: "turn_started",
        session_id: session.id,
        turn_id: turnId,
        trace_id: traceId,
        mode: session.mode,
      };

      // Drive the shared loop; translate LoopEvents to streaming events.
      // Provisional round text is forwarded as text_delta (voice holds speech
      // while tool intent pends); only the final round text is completed.
      const trackFirstToken = (): void => {
        if (firstTokenAt === undefined) {
          firstTokenAt = Date.now() - streamT0;
          this.metrics.timer("model.first_token_ms", firstTokenAt, { provider: this.gateway.id });
        }
      };
      try {
        // The runner yields live provisional round events as they arrive
        // (voice barge-in depends on it); classification lands at round end.
        for await (const loopEvent of runner.run(loopInput)) {
          switch (loopEvent.type) {
            case "loop_started":
              break;
            case "round_started":
              provisionalText = "";
              break;
            case "text_delta":
              trackFirstToken();
              if (loopEvent.provisional) {
                // Live intermediate text from a tool-capable round: forwarded
                // for observability (streaming UI); the voice layer must NOT
                // speak it — it can still be invalidated by a later tool
                // call in the same round (§13, TASK-0024 Bug 1). Never final
                // persistence (§12) and never spoken as truth (§13).
                provisionalText += loopEvent.text;
                yield { type: "text_delta", text: loopEvent.text, provisional: true };
              } else {
                // Classified final text: the tool-disabled round stream, or
                // the final round's settled answer. Speech-eligible.
                finalText = loopEvent.text;
                if (finalText !== "") yield { type: "text_delta", text: finalText, provisional: false };
              }
              break;
            case "tool_call":
              yield { type: "tool_call", call: loopEvent.call };
              break;
            case "tool_result":
              break;
            case "usage":
              finalUsage = loopEvent.usage;
              yield { type: "usage", usage: loopEvent.usage };
              break;
            case "approval_required":
              yield { type: "approval_required", approvals: loopEvent.approvals };
              break;
            case "loop_completed":
              finalText = loopEvent.display_text;
              finalStatus = loopEvent.status;
              finalToolCalls = loopEvent.tool_calls;
              finalModel = loopEvent.model;
              finalUsage = loopEvent.model.input_tokens !== undefined || loopEvent.model.output_tokens !== undefined
                ? {
                    input_tokens: loopEvent.model.input_tokens,
                    output_tokens: loopEvent.model.output_tokens,
                    cached_tokens: loopEvent.model.cached_tokens,
                  }
                : finalUsage;
              break;
            case "loop_interrupted":
              interruptedPartial = loopEvent.partial_text;
              break;
            case "loop_failed":
              streamFailed = { code: loopEvent.code, message: loopEvent.message };
              break;
          }
        }
      } catch (err) {
        const arthurErr = toArthurError(err);
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
          this.store.failIdempotency(key);
        });
        this.logger.error("streaming loop failed", {
          trace_id: traceId,
          session_id: session.id,
          turn_id: turnId,
          code: arthurErr.code,
        });
        this.metrics.counter("arthur.model.failed", 1, { code: arthurErr.code });
        yield {
          type: "turn_failed",
          session_id: session.id,
          turn_id: turnId,
          trace_id: traceId,
          mode: session.mode,
          code: arthurErr.code,
          message: arthurErr.message,
        };
        return;
      }

      // A provider that honors abort by completing early (without yielding
      // more events) still ends the stream here: mark it interrupted so the
      // interrupted audit turn is persisted (spec section 17).
      if (signal?.aborted && !streamFailed && finalText === "" && finalToolCalls.length === 0 && interruptedPartial === "") {
        interruptedPartial = provisionalText;
      }

      if (streamFailed) {
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
          this.store.failIdempotency(key);
        });
        this.logger.error("streaming model generation failed", {
          trace_id: traceId,
          session_id: session.id,
          turn_id: turnId,
          code: streamFailed.code,
        });
        this.metrics.counter("arthur.model.failed", 1, { code: streamFailed.code });
        yield {
          type: "turn_failed",
          session_id: session.id,
          turn_id: turnId,
          trace_id: traceId,
          mode: session.mode,
          code: streamFailed.code,
          message: streamFailed.message,
        };
        return;
      }

      if (signal?.aborted || (finalText === "" && finalToolCalls.length === 0 && interruptedPartial !== "")) {
        // Barge-in / user stop: persist an interrupted audit turn - never a
        // normal completed answer (spec section 17).
        const partial = this.sanitizer.sanitizeText(signal?.aborted ? (interruptedPartial || provisionalText) : interruptedPartial);
        this.store.transaction(() => {
          this.store.createTurn({
            id: newTurnId(),
            sessionId: session.id,
            role: "assistant",
            text: partial,
            traceId,
            status: "interrupted",
            mode: session.mode,
          });
          this.store.failIdempotency(key);
        });
        this.logger.info("streaming turn interrupted", {
          trace_id: traceId,
          session_id: session.id,
          turn_id: turnId,
          partial_chars: partial.length,
        });
        this.metrics.counter("arthur.turn", 1, { status: "interrupted" });
        yield {
          type: "turn_interrupted",
          session_id: session.id,
          turn_id: turnId,
          trace_id: traceId,
          mode: session.mode,
          partial_text: interruptedPartial || provisionalText,
        };
        return;
      }

      // The loop aggregated model totals (latency + tokens + call count)
      // across all rounds; carry them onto the TurnResponse directly.
      const response = this.buildResponse(
        session,
        turnId,
        traceId,
        finalText,
        finalStatus,
        finalToolCalls,
        finalModel?.latency_ms ?? 0,
        finalUsage,
        finalModel?.calls,
      );
      // Patch the loop-aggregated totals onto the response model.
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

      this.logger.info("streaming turn completed", {
        trace_id: traceId,
        session_id: session.id,
        turn_id: turnId,
        status: finalStatus,
        total_ms: Date.now() - startedAt,
        tool_calls: finalToolCalls.length,
      });
      this.metrics.counter("arthur.turn", 1, { status: finalStatus });
      yield {
        type: "turn_completed",
        session_id: session.id,
        turn_id: turnId,
        trace_id: traceId,
        mode: session.mode,
        status: finalStatus,
        display_text: finalText,
        tool_calls: finalToolCalls,
        usage: finalUsage,
      };
    } catch (err) {
      this.store.failIdempotency(key);
      throw err;
    }
  }

  /**
   * Text turn (SC-06 section 4): collect the shared loop's LoopEvents into a
   * TurnResponse. The bounded model→tool→model loop replaces the old
   * model→tools→ONE-follow-up sequence; intermediate assistant text never
   * becomes the persisted answer.
   */
  private async processTurn(request: TurnRequest, idempotencyId: string): Promise<TurnResponse> {
    const loopRunId = newId();
    const boot = await this.bootstrapTurn(request, idempotencyId);
    const { session, history, turnId, traceId, startedAt, safeMessage, modelRequest } = boot;

    this.logger.info("turn started", {
      trace_id: traceId,
      session_id: session.id,
      turn_id: turnId,
      mode: session.mode,
      client_type: request.metadata?.client_type,
      loop_run_id: loopRunId,
    });

    const runner = this.createLoopRunner();
    let finalText = "";
    let finalStatus: TurnStatus = "completed";
    let finalToolCalls: ToolCallSummary[] = [];
    let finalModel: TurnResponseModel | undefined;
    let finalUsage: ModelResult["usage"];
    try {
      for await (const loopEvent of runner.run({
        loopRunId,
        sessionId: session.id,
        turnId,
        traceId,
        mode: session.mode,
        clientRequestId: request.client_request_id,
        safeMessage,
        history,
        baseRequest: modelRequest,
        transport: "buffered" as const,
      })) {
        switch (loopEvent.type) {
          case "loop_completed":
            finalText = loopEvent.display_text;
            finalStatus = loopEvent.status;
            finalToolCalls = loopEvent.tool_calls;
            finalModel = loopEvent.model;
            finalUsage = loopEvent.model.input_tokens !== undefined || loopEvent.model.output_tokens !== undefined
              ? {
                  input_tokens: loopEvent.model.input_tokens,
                  output_tokens: loopEvent.model.output_tokens,
                  cached_tokens: loopEvent.model.cached_tokens,
                }
              : finalUsage;
            break;
          case "loop_interrupted":
            // No signal on the text path: treat as failed-closed interrupt.
            finalText = loopEvent.partial_text;
            finalStatus = "interrupted";
            break;
          case "loop_failed": {
            const failedErr = new ArthurError(loopEvent.code as ErrorCode, loopEvent.message);
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
              code: failedErr.code,
            });
            this.metrics.counter("arthur.model.failed", 1, { code: failedErr.code });
            throw failedErr;
          }
          default:
            break;
        }
      }
    } catch (err) {
      // bootstrapTurn already failed idempotency on its own errors; loop
      // failures after bootstrap must also fail the reservation.
      try {
        this.store.failIdempotency(idempotencyId);
      } catch {
        // Reservation may already be terminal (loop_failed path above).
      }
      throw err;
    }
    void startedAt;

    this.logger.info("turn completed", {
      trace_id: traceId,
      session_id: session.id,
      turn_id: turnId,
      status: finalStatus,
      total_ms: Date.now() - boot.startedAt,
      tool_calls: finalToolCalls.length,
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
      finalToolCalls,
      finalModel?.latency_ms ?? 0,
      finalUsage,
      finalModel?.calls,
    );
  }

  /**
   * Narrow session bootstrap for legitimate clients without a first user turn
   * (DEV-VOICE-CLI-1, voice console): creates a REAL persisted session through
   * the existing SessionStore logic and returns its authoritative id + mode.
   * No user turn is created merely to bootstrap the session, and no store
   * handle is exposed to the caller.
   */
  async createSession(mode: ArthurMode): Promise<{ session_id: string; mode: ArthurMode }> {
    const session = this.store.createSession(newSessionId(), mode);
    this.logger.info("session created", { session_id: session.id, mode: session.mode });
    return { session_id: session.id, mode: session.mode };
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

  /** Server-generated WYSIWYS approval challenge (SC-02 section 20). */
  getApprovalChallenge(approvalId: string): import("../../tools/orchestrator").ApprovalChallenge {
    return this.orchestrator.getApprovalChallenge(approvalId);
  }

  /** Trusted spoken approval summary from the server-side presenter (SC-02 section 21). */
  approvalVoicePrompt(approvalId: string): string {
    return this.orchestrator.approvalVoicePrompt(approvalId);
  }

  /**
   * SC-06 §8/§46 approve + durable resume. Runs the SC-02 decision first
   * (unchanged authority), then continues the journaled loop through the SAME
   * ConversationLoopRunner — voice/API/text share loop semantics (§23).
   * Non-journaled approvals (no loop row) return the bare SC-02 outcome.
   */
  async approve(approvalId: string, channel?: string): Promise<ApprovalOutcome> {
    if (channel !== undefined) this.store.recordApprovalDecisionChannel(approvalId, channel);
    let decision: ApprovalOutcome;
    try {
      decision = await this.orchestrator.executeApproval(approvalId);
    } catch (err) {
      // Expiry path (§49): the decision terminalized the row as expired and
      // threw. Journaled loops still resume with the approval_expired
      // envelope; non-journaled approvals keep the fail-closed throw.
      const approval = this.store.getApproval(approvalId);
      if (approval?.status !== "expired" || !this.store.getLoopByApproval(approvalId)) throw err;
      decision = { approval_id: approvalId, tool_name: approval.tool_name, status: "already_resolved", tool_call_id: approval.tool_call_id };
    }
    return this.resumeJournaledLoop(approvalId, decision, "buffered");
  }

  async reject(approvalId: string, channel?: string): Promise<ApprovalOutcome> {
    if (channel !== undefined) this.store.recordApprovalDecisionChannel(approvalId, channel);
    const decision = await this.orchestrator.rejectApproval(approvalId);
    // Increment 3 §50-51: on a real user rejection, record the invocation
    // fingerprint in the loop's bounded continuation state so an exact
    // re-proposal in the same turn never re-prompts (anti-nag). Survives
    // restart via the journal column.
    if (decision.status === "rejected") this.recordRejectedFingerprint(approvalId);
    return this.resumeJournaledLoop(approvalId, decision, "buffered");
  }

  /**
   * Increment 3.1 §50-51 anti-nag recording: reuse the EXACT fingerprint the
   * orchestrator persisted on the tool_call row (pre-sanitization identity).
   * Never rehashes sanitized args (that would collide distinct secrets).
   * Absent row/NULL fp (pre-3.1) → no nag (fail open safely, never wrongly).
   * Best-effort: recording failures never break the rejection itself.
   */
  private recordRejectedFingerprint(approvalId: string): void {
    try {
      const loop = this.store.getLoopByApproval(approvalId);
      const approval = this.store.getApproval(approvalId);
      if (!loop || !approval) return;
      const toolCall = this.store.getToolCall(approval.tool_call_id);
      const fp = toolCall?.invocation_fingerprint;
      if (typeof fp !== "string" || !/^[0-9a-f]{64}$/.test(fp)) return;
      this.store.addLoopRejectedFingerprint(loop.id, fp);
    } catch {
      // Advisory only; the rejection itself already committed.
    }
  }

  /**
   * Continue a WAITING_APPROVAL journaled loop after its SC-02 decision.
   * Collects the runner's continuation events, persists the resumed answer
   * as a NEW assistant turn, and attaches continuation fields. Losers and
   * non-journaled approvals return the bare decision.
   */
  private async resumeJournaledLoop(
    approvalId: string,
    decision: ApprovalOutcome,
    transport: "stream" | "buffered",
  ): Promise<ApprovalOutcome> {
    const loop = this.store.getLoopByApproval(approvalId);
    if (!loop) return decision;
    const runner = this.createLoopRunner();
    let displayText = "";
    let status: TurnStatus = "completed";
    let toolCalls: ToolCallSummary[] = [];
    let continued = false;
    try {
      const iterator = runner.resumeApproval({ loopId: loop.id, approvalId, transport })[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          continued = (next.value as { continued: boolean }).continued === true;
          break;
        }
        const event = next.value;
        if (event.type === "loop_completed") {
          displayText = event.display_text;
          status = event.status;
          toolCalls = event.tool_calls;
        } else if (event.type === "loop_failed") {
          displayText = event.message;
          status = "failed";
        }
        // loop_interrupted cannot occur without a signal; ignore otherwise.
      }
    } catch (err) {
      this.logger.warn("loop resume continuation failed", {
        session_id: loop.session_id,
        turn_id: loop.turn_id,
        loop_id: loop.id,
        approval_id: approvalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ...decision, resumed: false, loop_id: loop.id };
    }
    if (!continued) return { ...decision, resumed: false, loop_id: loop.id };
    // Persist the resumed answer as a new assistant turn (the suspended
    // needs_approval turn stays as audit history).
    const session = this.store.getSession(loop.session_id);
    if (session) {
      this.store.createTurn({
        id: newTurnId(),
        sessionId: loop.session_id,
        role: "assistant",
        text: displayText,
        traceId: loop.trace_id,
        status: status === "needs_approval" ? "needs_approval" : status === "failed" ? "failed" : "completed",
        mode: session.mode,
      });
    }
    this.logger.info("loop resume completed", {
      trace_id: loop.trace_id,
      session_id: loop.session_id,
      turn_id: loop.turn_id,
      loop_id: loop.id,
      approval_id: approvalId,
      status,
    });
    this.metrics.counter("arthur.turn", 1, { status: `resumed_${status}` });
    return {
      ...decision,
      resumed: true,
      loop_id: loop.id,
      continuation_text: displayText,
      continuation_status: status,
      continuation_tool_calls: toolCalls,
    };
  }

  /** SC-03 safe execution status view (section 71). */
  getExecution(executionId: string): import("../../tools/execution_types").ExecutionStatusView {
    const view = this.orchestrator.getCoordinator().getStatus(executionId);
    if (!view) throw sessionNotFound(executionId);
    return view;
  }

  /** SC-03 cancel API (section 70). */
  cancelExecution(executionId: string): import("../../tools/execution_types").ExecutionStatusView {
    const updated = this.orchestrator.getCoordinator().requestCancel(executionId);
    if (!updated) throw sessionNotFound(executionId);
    const view = this.orchestrator.getCoordinator().getStatus(executionId);
    if (!view) throw sessionNotFound(executionId);
    return view;
  }

  /** SC-03 startup recovery passthrough (section 58). */
  async recoverExecutions(): Promise<{ recovered: number }> {
    return this.orchestrator.getCoordinator().recoverStaleExecutions();
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

  /**
   * Safe tool catalog introspection for developer-facing surfaces (DEV-CLI-1,
   * Option A). Returns manifest-only definitions - name, version, description,
   * schemas, risk, allowed modes. A ToolDefinition carries no executor,
   * adapter, or approval material, and every returned object is a deep-frozen
   * clone of the registry's own frozen definition, so callers can neither
   * mutate runtime policy nor reach execution through the catalog.
   *
   * This is a read-only view, NOT an executable handle: tools still run only
   * through ToolOrchestrator -> ToolExecutionService with full validation,
   * permission, and approval checks.
   */
  listTools(mode?: ArthurMode): ToolDefinition[] {
    const definitions =
      mode === undefined ? this.registry.list() : this.registry.listAllowedForMode(mode);
    return definitions.map(frozenToolDefinition);
  }

  /**
   * SC-03 test seam: exposes the orchestrator/registry for crash-recovery
   * proofs that must drive the production coordinator against a persistent DB.
   * Not a second execution path: every call still flows through the same
   * orchestrator -> coordinator -> service -> executor chain.
   */
  orchestratorForTests(): import("../../tools/orchestrator").ToolOrchestrator {
    return this.orchestrator;
  }

  /** SC-03 test seam: production registry behind the frozen catalog views. */
  registryForTests(): import("../../tools/registry").ToolRegistry {
    return this.registry;
  }

  /**
   * SC-06 test seam: the shared loop runner (same construction as the turn
   * paths). Tests drive resumeApproval/single-flight proofs against the real
   * runner + real store without a second execution path.
   */
  loopRunnerForTests(): import("./loop_runner").ConversationLoopRunner {
    return this.createLoopRunner();
  }

  /** Safe manifest lookup by tool name; undefined when the tool is unknown. */
  getToolDefinition(name: string): ToolDefinition | undefined {
    const definition = this.registry.getDefinition(name);
    return definition === undefined ? undefined : frozenToolDefinition(definition);
  }

  // ---- helpers -----------------------------------------------------------

  private buildResponse(
    session: SessionRecord,
    turnId: string,
    traceId: string,
    text: string,
    status: TurnStatus,
    toolCalls: ToolCallSummary[],
    latencyMs: number,
    usage: ModelResult["usage"],
    modelCalls?: number,
  ): TurnResponse {
    const model: TurnResponseModel = {
      provider: this.gateway.id,
      model: this.config.modelName,
      latency_ms: latencyMs,
    };
    if (usage?.input_tokens !== undefined) model.input_tokens = usage.input_tokens;
    if (usage?.output_tokens !== undefined) model.output_tokens = usage.output_tokens;
    if (usage?.cached_tokens !== undefined) model.cached_tokens = usage.cached_tokens;
    if (modelCalls !== undefined) model.calls = modelCalls;
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