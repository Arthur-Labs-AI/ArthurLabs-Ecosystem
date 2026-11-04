/**
 * SC-06 bounded multi-tool conversation loop v1 (§1-9, §28-34, §60-69).
 *
 * The single authoritative turn-orchestration core. Both handleTurn() (collect
 * LoopEvents into a TurnResponse) and streamTurn() (yield LoopEvents) run
 * through this runner, so text and voice share identical permissions,
 * approvals, loop limits, tool ordering, and context rules (§4-5).
 *
 * Core invariant (§1): the LLM may propose the next step, but ARTHUR Core —
 * never the model — controls whether the loop continues, how many resources
 * it may use, which tool calls execute, and when execution stops.
 *
 * v1 execution is SEQUENTIAL in deterministic model order (§28-29): the model
 * is not a trusted dependency planner, so parallel execution is a future
 * optimization, explicitly out of scope (§30, §152).
 *
 * One LoopEvent stream per user turn; each turn gets a loop_run_id bound to
 * session_id / turn_id / trace_id / mode / client_request_id (§6).
 */

import { createHash, randomUUID } from "node:crypto";

import { Buffer } from "node:buffer";

import { canonicalizeJson } from "../../tools/canonical_json";
import { snapshotJsonSafe } from "../../tools/json_safe";

import { ArthurError, toArthurError } from "../errors/errors";
import type { ChatMessage, ModelGateway, ModelRequest, ModelResult, ProposedToolCall } from "../../models/contracts";
import type { TokenUsage } from "../../observability/usage";
import { sumUsage } from "../../observability/usage";
import type { Logger } from "../../observability/logging";
import type { Metrics } from "../../observability/metrics";
import type { SecretSanitizer } from "../../security/sanitize";
import type { SessionStore } from "../../sessions/store";
import type { ToolOrchestrator } from "../../tools/orchestrator";
import type { ToolExecutionContext } from "../../tools/contracts";
import type { ToolRegistry } from "../../tools/registry";
import type { ArthurMode } from "../modes/mode";
import type { ContextBuilder } from "./context_builder";
import { isEligibleHistoryTurn, MODE_CONTRACTS, SYSTEM_CONTRACT } from "./context_builder";
import type { ToolCallSummary, TurnResponseModel, TurnStatus } from "./models";
import type { ConversationLoopState } from "../../sessions/models";

/** SC-06 §7 loop state machine (in-memory; durable WAITING_APPROVAL later). */
export type LoopState =
  | "CREATED"
  | "MODEL_RUNNING"
  | "ROUND_READY"
  | "TOOL_EXECUTING"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "LIMIT_REACHED";

/** SC-06 §122 internal stop reasons (metric/logging dimension, no raw data). */
export type LoopStopReason =
  | "final_answer"
  | "approval_wait"
  | "user_cancelled"
  | "model_error"
  | "model_bad_response"
  | "tool_outcome_unknown"
  | "round_limit"
  | "tool_call_limit"
  | "context_limit"
  | "security_violation"
  | "active_runtime_limit"
  | "cycle_detected";

export interface LoopBudgets {
  maxRounds: number;
  maxCallsPerRound: number;
  maxCallsTotal: number;
  maxResultBytes: number;
  maxActiveMs: number;
  /** Increment 3 §57-58: max identical consecutive batch repeats (default 2). */
  repeatLimit: number;
}

export interface LoopRunnerDeps {
  gateway: ModelGateway;
  store: SessionStore;
  contextBuilder: ContextBuilder;
  orchestrator: ToolOrchestrator;
  /** Read-only: tool-schema snapshot fingerprint for resume drift detection. */
  registry: ToolRegistry;
  sanitizer: SecretSanitizer;
  config: {
    modelName: string;
    loopMaxRounds: number;
    loopMaxCallsPerRound: number;
    loopMaxCallsTotal: number;
    loopMaxResultBytes: number;
    loopMaxActiveMs: number;
    loopRepeatLimit: number;
  };
  logger: Logger;
  metrics: Metrics;
}

export interface LoopTurnInput {
  loopRunId: string;
  sessionId: string;
  turnId: string;
  traceId: string;
  mode: ArthurMode;
  clientRequestId: string;
  safeMessage: string;
  history: import("../../sessions/models").TurnRecord[];
  baseRequest: ModelRequest;
  signal?: AbortSignal;
  /**
   * Transport mode. Streaming rounds (streamTurn/voice) consume
   * generateStream and yield live provisional events (barge-in depends on
   * it). Buffered rounds (handleTurn) use generate() — one settled result
   * per round, no live events — matching the text path's transport.
   */
  transport: "stream" | "buffered";
  /**
   * Resume seed (§8): when present, run() continues a WAITING_APPROVAL loop
   * instead of starting a new turn. Counters/seen-ids restore from the
   * journal; baseRequest is the reconstructed continuation base.
   * activeMsUsed carries pre-suspension active runtime so the runtime
   * budget is not reset by the resume (§61: approval wait excluded, but
   * pre-suspension active time still counts).
   */
  resume?: {
    startRound: number;
    seenProviderIds: string[];
    modelCallsUsed: number;
    toolCallsUsed: number;
    priorSummaries: ToolCallSummary[];
    priorUsage: TokenUsage;
    priorLatencyMs: number;
    activeMsUsed: number;
  };
}

/** Events produced by the loop; handleTurn collects, streamTurn yields (§4). */
export type LoopEvent =
  | { type: "loop_started"; loop_run_id: string; turn_id: string; trace_id: string }
  | { type: "round_started"; round_no: number }
  | { type: "text_delta"; text: string; round_no: number; provisional: boolean }
  | { type: "tool_call"; call: ProposedToolCall; round_no: number }
  | { type: "tool_result"; summary: ToolCallSummary; round_no: number }
  | { type: "usage"; usage: TokenUsage; round_no: number }
  | { type: "approval_required"; approvals: Array<{ approval_id: string; tool_name: string }> }
  | {
      type: "loop_completed";
      display_text: string;
      status: TurnStatus;
      tool_calls: ToolCallSummary[];
      model: TurnResponseModel;
      stop_reason: LoopStopReason;
      rounds_used: number;
    }
  | { type: "loop_interrupted"; partial_text: string; stop_reason: LoopStopReason }
  | { type: "loop_failed"; code: string; message: string; stop_reason: LoopStopReason };

export interface ValidatedRound {
  roundNo: number;
  assistantText: string;
  calls: ProposedToolCall[];
  usage?: TokenUsage;
  finishReason: string;
  latencyMs: number;
}

/**
 * Validate one model round's proposed tool calls (§15-21, §129).
 *
 * After final provider normalization every provider_call_id must be
 * non-empty (§19-20), bounded (256 chars, matching the provider boundary),
 * and unique inside the turn (§21). A malformed batch is MODEL_BAD_RESPONSE
 * and executes ZERO calls (§129).
 */
export function validateProposedBatch(
  calls: ProposedToolCall[],
  seenProviderIds: Set<string>,
  limits: { maxCallsPerRound: number; remainingTotal: number },
): { ok: true; accepted: ProposedToolCall[] } | { ok: false; reason: string; budgetExhausted?: boolean } {
  if (calls.length > limits.maxCallsPerRound) {
    return { ok: false, reason: `too many tool calls in one round: ${calls.length} > ${limits.maxCallsPerRound}` };
  }
  if (calls.length > limits.remainingTotal) {
    // Increment 3 §14: over-total proposals are NOT model misbehavior —
    // they route to the tool-disabled final synthesis path (no execution).
    return { ok: false, reason: `tool call turn budget exceeded`, budgetExhausted: true };
  }
  const batchIds = new Set<string>();
  for (const call of calls) {
    if (typeof call.id !== "string" || call.id.length === 0) {
      return { ok: false, reason: "model returned a tool call with an empty provider id" };
    }
    if (call.id.length > 256) {
      return { ok: false, reason: "model returned a tool call with an oversized provider id" };
    }
    if (typeof call.name !== "string" || call.name.trim() === "") {
      return { ok: false, reason: "model returned a tool call without a tool name" };
    }
    if (batchIds.has(call.id) || seenProviderIds.has(call.id)) {
      return { ok: false, reason: `duplicate provider tool-call id in turn: ${call.id}` };
    }
    batchIds.add(call.id);
  }
  return { ok: true, accepted: calls };
}

/**
 * Invocation fingerprint (§55 + Increment 3 §1): SHA256 over JCS of
 * {tool_name, arguments} via the shared canonicalizeJson (stable key
 * ordering — same semantic args → same fingerprint regardless of key order).
 * Semantic invocation identity ONLY: excludes provider_call_id, ARTHUR ids,
 * rounds, and timestamps. Throws CanonicalJsonError on non-JSON-safe args;
 * callers treat unhashable proposals as non-matchable (never crash).
 */
export function invocationFingerprint(name: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeJson({ tool_name: name, arguments: args }), "utf8").digest("hex");
}

/** Batch fingerprint (§56): SHA-256 over the ordered invocation list. */
export function batchFingerprint(calls: Array<{ name: string; args: Record<string, unknown> }>): string {
  const parts = calls.map((c) => invocationFingerprint(c.name, c.args));
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

/**
 * SC-06 §15 tool-schema snapshot identity: SHA-256 over the sorted frozen
 * tool set (name + version + definition hash + allowed modes). Resume
 * recomputes this over the CURRENT registry and fails closed on drift.
 */
export function toolSchemaFingerprint(
  tools: Array<{ name: string; version: string; definitionHash: string; allowedModes: string[] }>,
): string {
  const sorted = [...tools]
    .map((t) => [t.name, t.version, t.definitionHash, [...t.allowedModes].sort()])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256").update(JSON.stringify(sorted), "utf8").digest("hex");
}

export class ConversationLoopRunner {
  private readonly gateway: ModelGateway;
  private readonly store: SessionStore;
  private readonly contextBuilder: ContextBuilder;
  private readonly orchestrator: ToolOrchestrator;
  private readonly registry: ToolRegistry;
  private readonly sanitizer: SecretSanitizer;
  private readonly budgets: LoopBudgets;
  private readonly modelName: string;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(deps: LoopRunnerDeps) {
    this.gateway = deps.gateway;
    this.store = deps.store;
    this.contextBuilder = deps.contextBuilder;
    this.orchestrator = deps.orchestrator;
    this.registry = deps.registry;
    this.sanitizer = deps.sanitizer;
    this.budgets = {
      maxRounds: deps.config.loopMaxRounds,
      maxCallsPerRound: deps.config.loopMaxCallsPerRound,
      maxCallsTotal: deps.config.loopMaxCallsTotal,
      maxResultBytes: deps.config.loopMaxResultBytes,
      maxActiveMs: deps.config.loopMaxActiveMs,
      repeatLimit: deps.config.loopRepeatLimit,
    };
    this.modelName = deps.config.modelName;
    this.logger = deps.logger.child("loop");
    this.metrics = deps.metrics;
  }

  /**
   * Run the bounded loop for one user turn, yielding LoopEvents.
   *
   * Cancellation (§105-108): the AbortSignal stops the current model call,
   * prevents every future round/tool/final-synthesis, and yields
   * loop_interrupted; not-yet-started batch calls never start (§108).
   */
  async *run(input: LoopTurnInput): AsyncGenerator<LoopEvent> {
    const activeStartedAt = Date.now();
    const activeMsBase = input.resume?.activeMsUsed ?? 0;
    const activeElapsedMs = (): number => activeMsBase + (Date.now() - activeStartedAt);
    let state: LoopState = "CREATED";
    const seenProviderIds = new Set<string>(input.resume?.seenProviderIds ?? []);
    const allSummaries: ToolCallSummary[] = [...(input.resume?.priorSummaries ?? [])];
    let totalUsage: TokenUsage = input.resume?.priorUsage ?? {};
    let totalLatencyMs = input.resume?.priorLatencyMs ?? 0;
    let modelCalls = input.resume?.modelCallsUsed ?? 0;
    let toolCallsUsed = input.resume?.toolCallsUsed ?? 0;
    let resultBytesUsed = 0;
    let roundsUsed = (input.resume?.startRound ?? 1) - 1;
    let currentRequest = input.baseRequest;
    // Increment 3.1 audit: cumulative per-round evidence log for cross-round
    // oldest-first compaction. Rebuilds currentRequest deterministically
    // after any compaction (equivalent to the chained buildFollowup when
    // nothing compacts).
    const roundLog: Array<{ assistant: ChatMessage; results: ChatMessage[] }> = [];
    const rebuildRequest = (): void => {
      const history: ChatMessage[] = [...input.baseRequest.history];
      for (const entry of roundLog) {
        history.push(entry.assistant, ...entry.results);
      }
      currentRequest = { ...input.baseRequest, history, userMessage: "" };
    };
    const pushRoundLog = (assistant: ChatMessage, results: ChatMessage[]): void => {
      roundLog.push({ assistant, results });
      rebuildRequest();
    };
    // Increment 3 §57-58 cycle state: last ordered batch fingerprint +
    // consecutive-repeat count (journal-restored on resume). True only when
    // a mutation completed since the last batch (state-change reset, §11).
    let lastBatchFp: string | null = null;
    let consecutiveRepeats = 0;
    let mutationCompletedSinceBatch = false;
    // Increment 3 budgets extension: repeat limit is trusted config.
    const repeatLimit = this.budgets.repeatLimit;
    // SC-06 §14-15: frozen snapshot identities computed once at bootstrap.
    const schemaFingerprint = toolSchemaFingerprint(
      input.baseRequest.toolSchemas.map((s) => ({
        name: s.name,
        version: this.registry.getDefinition(s.name)?.version ?? "",
        definitionHash: this.registry.getDefinitionHash(s.name) ?? "",
        allowedModes: [...(this.registry.getDefinition(s.name)?.allowed_modes ?? [])],
      })),
    );
    const remainingBudgetsJson = (): string => JSON.stringify({
      rounds_remaining: Math.max(0, this.budgets.maxRounds - roundsUsed),
      tool_calls_remaining: Math.max(0, this.budgets.maxCallsTotal - toolCallsUsed),
      active_ms_remaining: Math.max(0, this.budgets.maxActiveMs - activeElapsedMs()),
      result_bytes_remaining: Math.max(0, this.budgets.maxResultBytes - resultBytesUsed),
    });
    // Journal terminal CAS (§3): authoritative conditional transition from
    // any non-terminal state + progress snapshot. Returns the CAS result;
    // loop control flow never depends on it (fail-closed at resume time).
    const journalTerminal = (to: "COMPLETED" | "FAILED" | "INTERRUPTED" | "LIMIT_REACHED"): void => {
      try {
        this.store.casLoopState(input.loopRunId,
          ["CREATED", "MODEL_RUNNING", "ROUND_READY", "TOOL_EXECUTING", "RESUMING"],
          to,
          {
            currentRound: roundsUsed,
            modelCallsUsed: modelCalls,
            toolCallsUsed,
            activeRuntimeMs: activeElapsedMs(),
          });
      } catch {
        // Journal outage must not break the turn; resume will fail closed.
      }
      state = to;
    };
    const journalProgress = (toState: "MODEL_RUNNING" | "ROUND_READY" | "TOOL_EXECUTING"): void => {
      try {
        this.store.updateLoopProgress(input.loopRunId, {
          currentRound: roundsUsed,
          modelCallsUsed: modelCalls,
          toolCallsUsed,
          activeRuntimeMs: activeElapsedMs(),
        });
        this.store.casLoopState(input.loopRunId,
          ["CREATED", "MODEL_RUNNING", "ROUND_READY", "TOOL_EXECUTING", "RESUMING"], toState);
      } catch {
        // Advisory only.
      }
      state = toState;
    };
    // §1/§90: persist the journal row BEFORE active progression begins.
    // Identity is server-generated (input.loopRunId); never model-chosen.
    // Resume continuation (§8) skips creation: the row already exists and
    // the WAITING_APPROVAL->RESUMING claim was won before delegating here.
    if (!input.resume) {
      try {
        this.store.createLoop({
          id: input.loopRunId,
          turnId: input.turnId,
          sessionId: input.sessionId,
          mode: input.mode,
          traceId: input.traceId,
          clientRequestId: input.clientRequestId,
          budgetsJson: remainingBudgetsJson(),
          toolSchemaFingerprint: schemaFingerprint,
        });
      } catch {
        // Journal collision (duplicate loop id) fails closed: no progression.
        state = "FAILED";
        yield { type: "loop_failed", code: "INTERNAL_ERROR", message: "Conversation loop identity collision", stop_reason: "security_violation" };
        return;
      }
    }

    if (input.resume) {
      const journal = this.store.getLoop(input.loopRunId);
      lastBatchFp = journal?.last_batch_fingerprint ?? null;
      consecutiveRepeats = journal?.consecutive_repeats ?? 0;
    }

    this.metrics.counter("arthur.loop.started", 1, { mode: input.mode });
    yield { type: "loop_started", loop_run_id: input.loopRunId, turn_id: input.turnId, trace_id: input.traceId };
    if (!input.resume) {
      this.store.casLoopState(input.loopRunId, ["CREATED"], "MODEL_RUNNING");
    }
    state = "MODEL_RUNNING";

    const activeExhausted = (): boolean => activeElapsedMs() >= this.budgets.maxActiveMs;

    // Buffered per-round model call (text path): one settled generate()
    // result per round; provider partials never surface.
    const bufferedRound = async (
      gateway: ModelGateway,
      request: ModelRequest,
      roundNo: number,
    ): Promise<{ kind: "round"; round: ValidatedRound } | { kind: "failed"; error: ArthurError }> => {
      const t0 = Date.now();
      try {
        const result = await gateway.generate(request);
        return {
          kind: "round",
          round: {
            roundNo,
            assistantText: result.assistant_text,
            calls: result.tool_calls,
            usage: result.usage,
            finishReason: result.finish_reason,
            latencyMs: Date.now() - t0,
          },
        };
      } catch (err) {
        return { kind: "failed", error: toArthurError(err) };
      }
    };

    // Per-round model stream (§14 + voice barge-in): text deltas and tool
    // calls are yielded LIVE as round events (consumers may show them
    // immediately), but classification happens at round end — only the
    // final round's text becomes the answer (§12-13). Fully assembled,
    // normalized, validated calls are returned at round end (§22); partial
    // fragments are advisory live events only and never reach validation.
    // TASK-0024 Bug 1: live text from a tool-CAPABLE round is provisional
    // (it can still be invalidated by a later tool call in the same round)
    // and must never reach TTS. A tool-DISABLED round (toolSchemas empty)
    // cannot later become a tool round, so its live text is final-speech
    // eligible and streams to speech immediately.
    const streamRound = async function* (
      gateway: ModelGateway,
      request: ModelRequest,
      roundNo: number,
      signal?: AbortSignal,
    ): AsyncGenerator<
      | { kind: "live"; event: LoopEvent }
      | { kind: "round"; round: ValidatedRound }
      | { kind: "cancelled"; partialText: string }
      | { kind: "failed"; error: ArthurError }
    > {
      let assistantText = "";
      const byId = new Map<string, ProposedToolCall>();
      let usage: TokenUsage | undefined;
      let finishReason = "stop";
      const t0 = Date.now();
      try {
        for await (const event of gateway.generateStream(request, signal)) {
          if (signal?.aborted) {
            yield { kind: "cancelled", partialText: assistantText };
            return;
          }
          switch (event.type) {
            case "text_delta":
              assistantText += event.text;
              yield { kind: "live", event: { type: "text_delta", text: event.text, round_no: roundNo, provisional: request.toolSchemas.length > 0 } };
              break;
            case "tool_call":
              // Advisory live signal (voice holds speech); the complete
              // assembled call arrives at stream end (§22).
              if (event.call.id !== "" && event.call.name !== "") {
                byId.set(event.call.id, event.call);
              }
              yield { kind: "live", event: { type: "tool_call", call: event.call, round_no: roundNo } };
              break;
            case "usage":
              usage = event.usage;
              break;
            case "done":
              finishReason = event.finish_reason;
              break;
          }
        }
      } catch (err) {
        if (signal?.aborted) {
          yield { kind: "cancelled", partialText: assistantText };
          return;
        }
        yield { kind: "failed", error: toArthurError(err) };
        return;
      }
      if (signal?.aborted) {
        yield { kind: "cancelled", partialText: assistantText };
        return;
      }
      const latencyMs = Date.now() - t0;
      // Only fully assembled calls survive: non-empty id AND non-empty name.
      // Anonymous/partial fragments never reach validation (§22).
      const assembled = [...byId.values()].filter((c) => c.id !== "" && c.name !== "");
      yield {
        kind: "round",
        round: { roundNo, assistantText, calls: assembled, usage, finishReason, latencyMs },
      };
    };

    const recordModelCall = (status: "success" | "failed", latencyMs: number, result?: ModelResult): void => {
      this.store.createModelCall({
        id: randomUUID(),
        turnId: input.turnId,
        provider: this.gateway.id,
        model: this.modelName,
        latencyMs,
        status,
        inputTokens: result?.usage?.input_tokens,
        outputTokens: result?.usage?.output_tokens,
        cachedTokens: result?.usage?.cached_tokens,
        providerRequestId: result?.raw_provider_id,
      });
    };

    for (let roundNo = input.resume?.startRound ?? 1; ; roundNo += 1) {
      if (input.signal?.aborted) {
        this.cancelInFlightTurn(input.turnId);
        journalTerminal("INTERRUPTED");
        this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "user_cancelled" });
        yield { type: "loop_interrupted", partial_text: "", stop_reason: "user_cancelled" };
        return;
      }
      if (activeExhausted()) {
        journalTerminal("LIMIT_REACHED");
        yield* this.finishWithSynthesis({
          input, currentRequest, allSummaries, totalUsage, totalLatencyMs, modelCalls,
          roundsUsed, stopReason: "active_runtime_limit", state,
        });
        return;
      }
      if (roundNo > this.budgets.maxRounds) {
        journalTerminal("LIMIT_REACHED");
        this.metrics.counter("arthur.loop.limit_reached", 1, { reason: "round_limit", mode: input.mode });
        yield* this.finishWithSynthesis({
          input, currentRequest, allSummaries, totalUsage, totalLatencyMs, modelCalls,
          roundsUsed, stopReason: "round_limit", state,
        });
        return;
      }

      yield { type: "round_started", round_no: roundNo };
      journalProgress("MODEL_RUNNING");
      // Transport per consumer: streaming rounds drain the live stream
      // (provisional events flow immediately; voice barge-in depends on
      // it); buffered rounds await one settled generate() result.
      let round: ValidatedRound | undefined;
      let roundError: ArthurError | undefined;
      if (input.transport === "stream") {
        // Drain the live round stream: provisional events flow to consumers
        // immediately; the terminal step carries the validated round,
        // cancellation, or failure.
        for await (const step of streamRound(this.gateway, currentRequest, roundNo, input.signal)) {
          if (step.kind === "live") {
            yield step.event;
            continue;
          }
          if (step.kind === "cancelled") {
            this.cancelInFlightTurn(input.turnId);
            journalTerminal("INTERRUPTED");
            this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "user_cancelled" });
            yield {
              type: "loop_interrupted",
              partial_text: this.sanitizer.sanitizeText(step.partialText),
              stop_reason: "user_cancelled",
            };
            return;
          }
          if (step.kind === "failed") {
            roundError = step.error;
            break;
          }
          round = step.round;
        }
      } else {
        const settled = await bufferedRound(this.gateway, currentRequest, roundNo);
        if (settled.kind === "failed") {
          roundError = settled.error;
        } else {
          round = settled.round;
        }
      }
      if (roundError) {
        journalTerminal("FAILED");
        this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "model_error" });
        recordModelCall("failed", 0, undefined);
        if (allSummaries.length > 0) {
          const fallback = this.deterministicFallback(allSummaries);
          yield {
            type: "loop_completed", display_text: fallback, status: "completed",
            tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(totalLatencyMs, totalUsage, modelCalls),
            stop_reason: "model_error", rounds_used: roundsUsed,
          };
          this.metrics.counter("arthur.loop.completed", 1, { stop_reason: "model_error", mode: input.mode });
          return;
        }
        yield { type: "loop_failed", code: roundError.code, message: roundError.message, stop_reason: "model_error" };
        return;
      }
      if (!round) {
        // The round source always yields a terminal step; fail closed if the
        // contract is ever violated.
        journalTerminal("FAILED");
        yield { type: "loop_failed", code: "MODEL_BAD_RESPONSE", message: "Model round ended without a result", stop_reason: "model_error" };
        return;
      }
      roundsUsed = roundNo;
      modelCalls += 1;
      totalLatencyMs += round.latencyMs;
      if (round.usage) totalUsage = sumUsage(totalUsage, round.usage);
      recordModelCall("success", round.latencyMs, {
        assistant_text: round.assistantText, tool_calls: round.calls,
        usage: round.usage, finish_reason: round.finishReason,
      });
      this.metrics.counter("arthur.loop.round", 1, { mode: input.mode });
      this.metrics.timer("arthur.model.latency_ms", round.latencyMs, { provider: this.gateway.id });
      if (round.usage) yield { type: "usage", usage: round.usage, round_no: roundNo };
      journalProgress("ROUND_READY");

      // Final round: no tools → sanitized assistant text is the answer (§10).
      if (round.calls.length === 0) {
        const finalText = this.sanitizer.sanitizeText(round.assistantText);
        yield { type: "text_delta", text: finalText, round_no: roundNo, provisional: false };
        journalTerminal("COMPLETED");
        this.metrics.counter("arthur.loop.completed", 1, { stop_reason: "final_answer", mode: input.mode });
        yield {
          type: "loop_completed", display_text: finalText, status: "completed",
          tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(totalLatencyMs, totalUsage, modelCalls),
          stop_reason: "final_answer", rounds_used: roundsUsed,
        };
        return;
      }

      // Intermediate text is provisional (§11-13): yielded for observability
      // but never final; the voice layer holds speech while tools pend.
      if (round.assistantText !== "") {
        yield { type: "text_delta", text: round.assistantText, round_no: roundNo, provisional: true };
      }

      // Protocol validation BEFORE any execution (§19-21, §129).
      const validation = validateProposedBatch(round.calls, seenProviderIds, {
        maxCallsPerRound: this.budgets.maxCallsPerRound,
        remainingTotal: this.budgets.maxCallsTotal - toolCallsUsed,
      });
      if (!validation.ok) {
        // Increment 3 §14: total-budget exhaustion routes to final synthesis
        // (no execution); other malformed batches stay MODEL_BAD_RESPONSE.
        if (validation.budgetExhausted) {
          journalTerminal("LIMIT_REACHED");
          const pendingRequest = this.contextBuilder.buildFollowup(
            currentRequest,
            { role: "assistant", content: round.assistantText, tool_calls: round.calls },
            [],
          );
          yield* this.finishWithSynthesis({
            input, currentRequest: pendingRequest, allSummaries, totalUsage, totalLatencyMs, modelCalls,
            roundsUsed, stopReason: "tool_call_limit", state,
          });
          return;
        }
        journalTerminal("FAILED");
        this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "model_bad_response" });
        if (allSummaries.length > 0) {
          const fallback = this.deterministicFallback(allSummaries);
          yield {
            type: "loop_completed", display_text: fallback, status: "completed",
            tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(totalLatencyMs, totalUsage, modelCalls),
            stop_reason: "model_bad_response", rounds_used: roundsUsed,
          };
          return;
        }
        const err = new ArthurError("MODEL_BAD_RESPONSE", validation.reason);
        yield { type: "loop_failed", code: err.code, message: err.message, stop_reason: "model_bad_response" };
        return;
      }
      for (const call of validation.accepted) seenProviderIds.add(call.id);
      // Increment 3.1 audit (F34): frozen schema existence gate. Tools absent
      // from the turn's frozen toolSchemas set are unknown FOR THIS TURN —
      // even if registered later mid-turn. Fail-closed rejected envelope,
      // never dispatch (the model must only invoke its frozen contract).
      const frozenNames = new Set(input.baseRequest.toolSchemas.map((s) => s.name));
      // Increment 3.1 §7: whole-batch preflight — every accepted call must
      // produce an exact canonical fingerprint. Non-JSON-safe /
      // non-canonicalizable proposals are protocol malformation:
      // MODEL_BAD_RESPONSE with ZERO executions (provider IDs never serve
      // as semantic identity fallback). Schema-shape errors remain per-call
      // invalid-arguments envelopes in the orchestrator.
      const callFps: Array<string | null> = validation.accepted.map((c) =>
        (c.arguments !== null && typeof c.arguments === "object" && !Array.isArray(c.arguments))
          ? this.proposalFingerprint(c.name, c.arguments as Record<string, unknown>)
          : null);
      if (callFps.some((fp) => fp === null)) {
        journalTerminal("FAILED");
        this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "model_bad_response" });
        if (allSummaries.length > 0) {
          const fallback = this.deterministicFallback(allSummaries);
          yield {
            type: "loop_completed", display_text: fallback, status: "completed",
            tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(totalLatencyMs, totalUsage, modelCalls),
            stop_reason: "model_bad_response", rounds_used: roundsUsed,
          };
          return;
        }
        const unhashable = new ArthurError("MODEL_BAD_RESPONSE", "model returned a tool call with non-canonicalizable arguments");
        yield { type: "loop_failed", code: unhashable.code, message: unhashable.message, stop_reason: "model_bad_response" };
        return;
      }
      // Increment 3 §50-51 anti-nag + §52-53 dedupe: absorb matching calls
      // pre-dispatch (no approval challenge, no execution, no budget count —
      // budget counts orchestrator-dispatched calls only, §14-15).
      const rejectedFps = new Set(this.store.getLoopRejectedFingerprints(input.loopRunId));
      const completedFps = this.completedMutationFingerprints(input.turnId);
      const absorbedMessages: ChatMessage[] = [];
      const executable: ProposedToolCall[] = [];
      const executableIdx: number[] = [];
      // Synthetic (non-row) summary ids already journaled inline this round —
      // the round-end row-based append must skip them (no junk duplicates).
      const inlineJournaledIds = new Set<string>();
      for (let i = 0; i < validation.accepted.length; i += 1) {
        const call = validation.accepted[i] as ProposedToolCall;
        const fp = callFps[i] as string | null;
        // F34 frozen existence: a tool that EXISTS live but is ABSENT from
        // the turn-frozen schema set (gained mid-turn) is unknown for this
        // turn — rejected envelope, never dispatched. Tools absent from the
        // live registry too still route through the orchestrator, preserving
        // the existing unknown-tool rejection + durable audit row.
        const liveDefinition = this.registry.getDefinition(call.name);
        if (!frozenNames.has(call.name) && liveDefinition !== undefined) {
          const frozenSummary = `unknown tool for this turn: ${call.name}`;
          const frozenId = randomUUID();
          inlineJournaledIds.add(frozenId);
          try {
            this.store.appendLoopTranscript(input.loopRunId, [{
              round_no: roundNo,
              sequence_no: i + 1,
              provider_call_id: call.id,
              tool_call_id: frozenId,
              tool_name: call.name,
              arguments_json: "{}",
              status: "rejected",
              result_summary: frozenSummary,
            }]);
          } catch {
            // Advisory only.
          }
          absorbedMessages.push({
            role: "tool",
            content: JSON.stringify({
              status: "rejected",
              reason: "unknown_tool",
              summary: frozenSummary,
              source: "tool",
              trust: "untrusted_data",
            }),
            name: call.name,
            tool_call_id: call.id,
          });
          allSummaries.push({
            tool_call_id: frozenId,
            name: call.name,
            risk: "unknown_tool",
            status: "rejected",
            result_summary: frozenSummary,
            round: roundNo,
            sequence: i + 1,
          });
          this.metrics.counter("arthur.tool.rejected", 1, { reason: "frozen_schema" });
          continue;
        }
        const definition = this.registry.getDefinition(call.name);
        const needsApproval = definition !== undefined &&
          this.orchestrator.approvalBarrierIndex([call], input.mode) === 0;
        // Absorbed entries are journaled directly (no durable tool_call row
        // exists) so resume rebuilds evidence + prior summaries faithfully.
        const journalAbsorbed = (toolCallId: string, status: string, resultSummary: string): void => {
          try {
            const snap = (call.arguments !== null && typeof call.arguments === "object" && !Array.isArray(call.arguments))
              ? this.proposalSnapshot(call.name, call.arguments as Record<string, unknown>)
              : null;
            this.store.appendLoopTranscript(input.loopRunId, [{
              round_no: roundNo,
              sequence_no: i + 1,
              provider_call_id: call.id,
              tool_call_id: toolCallId,
              tool_name: call.name,
              arguments_json: snap?.argsJson ?? "{}",
              status,
              result_summary: resultSummary,
              note: status === "rejected" ? "previously_rejected" : "already_completed",
            }]);
          } catch {
            // Advisory only.
          }
        };
        if (fp !== null && needsApproval && rejectedFps.has(fp)) {
          const absorbedId = randomUUID();
          const absorbedSummary = "The user already rejected this action in this turn.";
          absorbedMessages.push(this.previouslyRejectedMessage(call));
          allSummaries.push({
            tool_call_id: absorbedId,
            name: call.name,
            risk: definition?.risk ?? "approval_required",
            status: "rejected",
            result_summary: absorbedSummary,
            round: roundNo,
            sequence: i + 1,
            note: "previously_rejected",
          });
          journalAbsorbed(absorbedId, "rejected", absorbedSummary);
          inlineJournaledIds.add(absorbedId);
          this.metrics.counter("arthur.loop.anti_nag_hit", 1, { mode: input.mode });
          continue;
        }
        const isMutation = definition !== undefined && definition.risk !== "read";
        if (fp !== null && isMutation && completedFps.has(fp)) {
          const absorbedId = randomUUID();
          const absorbedSummary = "This exact action already completed in this turn.";
          absorbedMessages.push(this.alreadyCompletedMessage(call, absorbedSummary));
          allSummaries.push({
            tool_call_id: absorbedId,
            name: call.name,
            risk: (definition as { risk: string }).risk,
            status: "completed",
            result_summary: absorbedSummary,
            round: roundNo,
            sequence: i + 1,
            note: "already_completed",
          });
          journalAbsorbed(absorbedId, "completed", absorbedSummary);
          inlineJournaledIds.add(absorbedId);
          this.metrics.counter("arthur.loop.dedupe_hit", 1, { mode: input.mode });
          continue;
        }
        executable.push(call);
        executableIdx.push(i);
      }
      // Increment 3.1 §9: ordered batch fingerprint over EXACT semantic
      // invocation identities only — provider IDs have zero influence on
      // cycle identity (same A/B with different provider IDs → same batch
      // FP; [A,B] != [B,A]). Unhashable batches already failed above.
      const batchFp = batchFingerprint(validation.accepted.map((c) => ({
        name: c.name,
        args: c.arguments as Record<string, unknown>,
      })));
      if (lastBatchFp !== null && batchFp === lastBatchFp && !mutationCompletedSinceBatch) {
        consecutiveRepeats += 1;
      } else {
        consecutiveRepeats = 1;
        mutationCompletedSinceBatch = false;
      }
      lastBatchFp = batchFp;
      this.store.updateLoopProgress(input.loopRunId, {
        lastBatchFingerprint: batchFp,
        consecutiveRepeats,
      });
      if (consecutiveRepeats > repeatLimit) {
        // Threshold exceeded: ZERO executor calls for this round (§12).
        journalTerminal("LIMIT_REACHED");
        this.metrics.counter("arthur.loop.cycle_detected", 1, { mode: input.mode });
        yield* this.finishWithSynthesis({
          input, currentRequest, allSummaries, totalUsage, totalLatencyMs, modelCalls,
          roundsUsed, stopReason: "cycle_detected", state,
          instruction: "The tool loop repeated without useful progress. Do not request tools. Answer using the available results.",
        });
        return;
      }
      // All-absorbed round: evidence feeds the next round; no dispatch, no
      // budget consumption, no barrier.
      if (executable.length === 0) {
        pushRoundLog(
          { role: "assistant", content: round.assistantText, tool_calls: validation.accepted },
          [...absorbedMessages],
        );
        continue;
      }
      // Soft tool-budget gate (§65-67 + Increment 3 §14): executable
      // dispatched calls vs remaining total. Absorbed/deferred calls never
      // counted (§15); re-proposals recount on dispatch (no loophole).
      if (toolCallsUsed + executable.length > this.budgets.maxCallsTotal) {
        journalTerminal("LIMIT_REACHED");
        const pendingRequest = this.contextBuilder.buildFollowup(
          currentRequest,
          { role: "assistant", content: round.assistantText, tool_calls: validation.accepted },
          [...absorbedMessages],
        );
        yield* this.finishWithSynthesis({
          input, currentRequest: pendingRequest, allSummaries, totalUsage, totalLatencyMs, modelCalls,
          roundsUsed, stopReason: "tool_call_limit", state,
        });
        return;
      }

      // Preflight the WHOLE batch before any execution (§38-40): when ANY
      // accepted call needs approval, the round suspends at the barrier
      // BEFORE side-effect/tool execution from the same batch. The first
      // approval-required call in model order becomes the barrier (§41);
      // siblings never execute (deferred — the model re-plans, §42-43).
      // Read-only probe: definition lookup + permission evaluate only.
      journalProgress("TOOL_EXECUTING");
      const ctx: ToolExecutionContext = {
        session_id: input.sessionId, turn_id: input.turnId, trace_id: input.traceId,
        mode: input.mode, approved: false,
      };
      const batchMessages: ChatMessage[] = [];
      let approvalBarrier: { approval_id: string; tool_name: string } | undefined;
      let outcomeUnknown = false;
      // Increment 3: preflight + dispatch operate on the EXECUTABLE subset
      // (absorbed nag/dedupe envelopes bypass the barrier and budget).
      // Original sequence numbers preserved via executableIdx.
      const barrierIndex = this.orchestrator.approvalBarrierIndex(executable, input.mode);
      if (barrierIndex >= 0) {
        // Atomic barrier: ONLY the first approval-required call goes to the
        // orchestrator (which persists the pending approval + tool call).
        // Nothing before or after it in this batch executes.
        const barrierCall = executable[barrierIndex] as ProposedToolCall;
        const barrierSeq = (executableIdx[barrierIndex] as number) + 1;
        const handling = await this.orchestrator.handleProposed([barrierCall], {
          ...ctx,
          provider_call_id: barrierCall.id,
          round_no: roundNo,
          sequence_no: barrierSeq,
        });
        const summary = handling.summaries[0] as ToolCallSummary;
        summary.round = roundNo;
        summary.sequence = barrierSeq;
        toolCallsUsed += 1;
        allSummaries.push(summary);
        this.metrics.counter("arthur.loop.tool_call", 1, { mode: input.mode, status: summary.status });
        yield { type: "tool_result", summary, round_no: roundNo };
        if (summary.status === "pending_approval") {
          approvalBarrier = { approval_id: summary.approval_id as string, tool_name: summary.name };
          // §6-7 durable barrier: CAS journal row into WAITING_APPROVAL with
          // the single waiting_approval_id + budgets + transcript. Losers (a
          // second barrier for this loop) fail closed here.
          this.appendJournalTranscript(input.loopRunId, input.turnId, [summary]);
          const barrierSet = this.store.setLoopBarrierCAS({
            id: input.loopRunId,
            approvalId: summary.approval_id as string,
            currentRound: roundNo,
            modelCallsUsed: modelCalls,
            toolCallsUsed,
            activeRuntimeMs: activeElapsedMs(),
            lastBatchFingerprint: batchFp,
            budgetsJson: remainingBudgetsJson(),
          });
          if (!barrierSet) {
            journalTerminal("FAILED");
            this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "security_violation" });
            yield { type: "loop_failed", code: "INTERNAL_ERROR", message: "Conversation loop barrier could not be attached", stop_reason: "security_violation" };
            return;
          }
          state = "WAITING_APPROVAL";
          this.metrics.counter("arthur.loop.waiting_approval", 1, { mode: input.mode });
        } else {
          // Barrier call did not pend (e.g. rejected on re-validation):
          // feed its envelope back and continue reasoning normally.
          batchMessages.push(this.rejectedResultMessage(barrierCall, summary));
          pushRoundLog(
            { role: "assistant", content: round.assistantText, tool_calls: [barrierCall] },
            this.roundMessages(round, [barrierCall], batchMessages),
          );
          continue;
        }
      }
      for (let seq = 0; approvalBarrier === undefined && seq < executable.length; seq += 1) {
        const call = executable[seq] as ProposedToolCall;
        const origSeq = (executableIdx[seq] as number) + 1;
        if (input.signal?.aborted) {
          // §108: completed calls keep durable truth; not-started never start.
          this.cancelInFlightTurn(input.turnId);
          journalTerminal("INTERRUPTED");
          yield { type: "loop_interrupted", partial_text: "", stop_reason: "user_cancelled" };
          return;
        }
        if (activeExhausted()) {
          journalTerminal("LIMIT_REACHED");
          yield* this.finishWithSynthesis({
            input, currentRequest, allSummaries, totalUsage, totalLatencyMs, modelCalls,
            roundsUsed, stopReason: "active_runtime_limit", state,
          });
          return;
        }
        // Sequential v1: execute ONE accepted call at a time in model order.
        // F39/F40: the dispatch await races user cancellation — on abort the
        // in-flight turn executions are cancelled via SC-03 requestCancel
        // (durable + same-process attempt abort), the late summary is
        // discarded, and not-started siblings never start.
        const dispatch = this.orchestrator.handleProposed([call], {
          ...ctx,
          provider_call_id: call.id,
          round_no: roundNo,
          sequence_no: origSeq,
        });
        let handling: Awaited<typeof dispatch> | undefined;
        if (input.signal !== undefined) {
          const abortNow = input.signal.aborted
            ? Promise.resolve(true)
            : await new Promise<boolean>((resolve) => {
              const onAbort = (): void => {
                input.signal?.removeEventListener("abort", onAbort);
                resolve(true);
              };
              input.signal?.addEventListener("abort", onAbort, { once: true });
              void dispatch.then(
                () => {
                  input.signal?.removeEventListener("abort", onAbort);
                  resolve(false);
                },
                () => {
                  input.signal?.removeEventListener("abort", onAbort);
                  resolve(false);
                },
              );
            });
          if (abortNow) {
            this.cancelInFlightTurn(input.turnId);
            try { await dispatch; } catch { /* discarded: SC-03 row is truth */ }
            journalTerminal("INTERRUPTED");
            yield { type: "loop_interrupted", partial_text: "", stop_reason: "user_cancelled" };
            return;
          }
          handling = await dispatch;
        } else {
          handling = await dispatch;
        }
        const summary = handling.summaries[0] as ToolCallSummary;
        summary.round = roundNo;
        summary.sequence = origSeq;
        toolCallsUsed += 1;
        allSummaries.push(summary);
        this.metrics.counter("arthur.loop.tool_call", 1, { mode: input.mode, status: summary.status });
        yield { type: "tool_result", summary, round_no: roundNo };

        if (summary.status === "pending_approval") {
          // §40-42 v1 subset: first approval is the barrier; the loop
          // suspends with needs_approval. Remaining batch siblings are NOT
          // executed (deferred); the model re-plans after the decision.
          // (Late-pending race: preflight said auto but the orchestrator
          // pended — still the single durable barrier via the same CAS.)
          approvalBarrier = { approval_id: summary.approval_id as string, tool_name: summary.name };
          this.appendJournalTranscript(input.loopRunId, input.turnId, [summary]);
          const lateBarrierSet = this.store.setLoopBarrierCAS({
            id: input.loopRunId,
            approvalId: summary.approval_id as string,
            currentRound: roundNo,
            modelCallsUsed: modelCalls,
            toolCallsUsed,
            activeRuntimeMs: activeElapsedMs(),
            lastBatchFingerprint: batchFp,
            budgetsJson: remainingBudgetsJson(),
          });
          if (!lateBarrierSet) {
            journalTerminal("FAILED");
            this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "security_violation" });
            yield { type: "loop_failed", code: "INTERNAL_ERROR", message: "Conversation loop barrier could not be attached", stop_reason: "security_violation" };
            return;
          }
          state = "WAITING_APPROVAL";
          this.metrics.counter("arthur.loop.waiting_approval", 1, { mode: input.mode });
          break;
        }
        if (summary.status === "outcome_unknown") {
          // §34: never ask the model "what now" — it could duplicate a
          // mutation. Fail closed with an explicit unresolved message.
          outcomeUnknown = true;
          break;
        }
        const msg = handling.toolResultMessages[0];
        if (msg && summary.status === "completed") {
          resultBytesUsed += ConversationLoopRunner.modelBytes(msg.content);
          batchMessages.push(msg);
        } else if (summary.status !== "completed") {
          // §23-24, §126: every non-completed outcome (rejected/failed/
          // cancelled/timed_out) still gets exactly one result envelope so
          // the model can adapt instead of crashing the turn.
          batchMessages.push(this.rejectedResultMessage(call, summary));
        }
      }

      if (approvalBarrier) {
        // Increment 3.1 audit: deferred siblings are REPRESENTED (never
        // executed): TurnResponse summary (cancelled + deferred_by_approval
        // note — frozen union), model envelope (deferred/approval_barrier),
        // and journal transcript entry so resume evidence includes them.
        // Accounted = provider ids already executed or absorbed this round.
        const accountedIds = new Set<string>();
        for (const row of this.store.getToolCallsForTurn(input.turnId)) {
          if (row.provider_call_id) accountedIds.add(row.provider_call_id);
        }
        for (const e of this.readJournalTranscript(input.loopRunId)) {
          if (e.round_no === roundNo && e.provider_call_id) accountedIds.add(e.provider_call_id);
        }
        for (let i = 0; i < validation.accepted.length; i += 1) {
          const call = validation.accepted[i] as ProposedToolCall;
          if (accountedIds.has(call.id)) continue;
          const deferredSummary: ToolCallSummary = {
            tool_call_id: randomUUID(),
            name: call.name,
            risk: this.registry.getDefinition(call.name)?.risk ?? "read",
            status: "cancelled",
            result_summary: "Deferred by the approval barrier; the model must re-plan after the decision.",
            round: roundNo,
            sequence: i + 1,
            note: "deferred_by_approval",
          };
          allSummaries.push(deferredSummary);
          batchMessages.push({
            role: "tool",
            content: JSON.stringify({
              status: "deferred",
              reason: "approval_barrier",
              summary: deferredSummary.result_summary,
              source: "tool",
              trust: "untrusted_data",
            }),
            name: call.name,
            tool_call_id: call.id,
          });
          try {
            this.store.appendLoopTranscript(input.loopRunId, [{
              round_no: roundNo,
              sequence_no: i + 1,
              provider_call_id: call.id,
              tool_call_id: deferredSummary.tool_call_id,
              tool_name: call.name,
              arguments_json: "{}",
              status: "cancelled",
              result_summary: deferredSummary.result_summary,
              note: "deferred_by_approval",
            }]);
          } catch {
            // Advisory only.
          }
        }
        yield { type: "approval_required", approvals: [approvalBarrier] };
        // Journal row is already durably WAITING_APPROVAL (barrier CAS).
        // Durable turn state (needs_approval) is persisted by the caller
        // from loop_completed; resume re-enters via resumeApproval.
        state = "WAITING_APPROVAL";
        const pendingText = round.assistantText.trim() !== ""
          ? this.sanitizer.sanitizeText(round.assistantText)
          : "(requesting approval to run a tool)";
        this.metrics.counter("arthur.loop.completed", 1, { stop_reason: "approval_wait", mode: input.mode });
        yield {
          type: "loop_completed", display_text: pendingText, status: "needs_approval",
          tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(totalLatencyMs, totalUsage, modelCalls),
          stop_reason: "approval_wait", rounds_used: roundsUsed,
        };
        return;
      }

      if (outcomeUnknown) {
        this.appendJournalTranscript(input.loopRunId, input.turnId, allSummaries.filter((s) => s.round === roundNo && s.note === undefined && !inlineJournaledIds.has(s.tool_call_id)));
        journalTerminal("FAILED");
        this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "tool_outcome_unknown" });
        const fallback = "The operation may or may not have completed, so I stopped instead of retrying it. " +
          this.deterministicFallback(allSummaries);
        yield {
          type: "loop_completed", display_text: fallback.trim(), status: "failed",
          tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(totalLatencyMs, totalUsage, modelCalls),
          stop_reason: "tool_outcome_unknown", rounds_used: roundsUsed,
        };
        return;
      }

      // Increment 3.1 audit: cumulative cross-round oldest-first compaction.
      // All logged result messages (this turn, oldest first) compact against
      // the budget; the request history rebuilds deterministically from the
      // log so earlier rounds' evidence compacts too (§21). Deterministic
      // for identical transcript + budget.
      {
        const allResults: ChatMessage[] = [];
        for (const entry of roundLog) allResults.push(...entry.results);
        allResults.push(...batchMessages);
        const before = allResults.map((m) => m.content);
        const compacted = ConversationLoopRunner.compactOldestFirst(allResults, this.budgets.maxResultBytes);
        if (compacted.compacted > 0) {
          this.metrics.counter("arthur.loop.context_compacted", compacted.compacted, { mode: input.mode });
          // Write compacted contents back into the SAME message objects so
          // the round log, pending followup, and byte accounting agree.
          const byRef = new Map<ChatMessage, string>();
          for (let i = 0; i < allResults.length; i += 1) {
            byRef.set(allResults[i] as ChatMessage, (compacted.messages[i] as ChatMessage).content);
          }
          for (const entry of roundLog) {
            for (const m of entry.results) {
              const next = byRef.get(m);
              if (next !== undefined) m.content = next;
            }
          }
          for (let i = 0; i < batchMessages.length; i += 1) {
            const next = byRef.get(batchMessages[i] as ChatMessage);
            if (next !== undefined) (batchMessages[i] as ChatMessage).content = next;
          }
          void before;
        }
        resultBytesUsed = 0;
        for (const entry of roundLog) {
          for (const m of entry.results) resultBytesUsed += ConversationLoopRunner.modelBytes(m.content);
        }
        for (const m of batchMessages) resultBytesUsed += ConversationLoopRunner.modelBytes(m.content);
      }
      if (resultBytesUsed > this.budgets.maxResultBytes) {
        // §24 summary overflow: even compact summaries cannot fit.
        journalTerminal("LIMIT_REACHED");
        this.metrics.counter("arthur.loop.limit_reached", 1, { reason: "context_limit", mode: input.mode });
        yield* this.finishWithSynthesis({
          input, currentRequest, allSummaries, totalUsage, totalLatencyMs, modelCalls,
          roundsUsed, stopReason: "context_limit", state,
          instruction: "Tool result context is exhausted. Do not request tools. Answer using the available results.",
        });
        return;
      }

      // Next round: frozen base context + appended tool-call/result messages
      // only (§77-79). Memory/tool schemas are never re-queried mid-turn.
      // Results are paired back in call order (§27) via roundMessages —
      // absorbed nag/dedupe envelopes included (one result per proposal).
      // Durable compact transcript (§16): operational entries for this round
      // (row-backed only; inline-journaled synthetic ids already recorded).
      this.appendJournalTranscript(input.loopRunId, input.turnId,
        allSummaries.filter((s) => s.round === roundNo && s.note === undefined && !inlineJournaledIds.has(s.tool_call_id)));
      this.store.updateLoopProgress(input.loopRunId, {
        currentRound: roundNo,
        modelCallsUsed: modelCalls,
        toolCallsUsed,
        activeRuntimeMs: activeElapsedMs(),
        budgetsJson: remainingBudgetsJson(),
      });
      // §11 state-change reset: a completed mutation is deterministic core
      // evidence that execution state changed → next identical batch is not
      // a stagnant repeat.
      for (const s of allSummaries) {
        if (s.round === roundNo && s.status === "completed") {
          const def = this.registry.getDefinition(s.name);
          if (def && def.risk !== "read") mutationCompletedSinceBatch = true;
        }
      }
      pushRoundLog(
        {
          role: "assistant",
          content: round.assistantText,
          tool_calls: validation.accepted,
        },
        this.roundMessages(round, validation.accepted, [...absorbedMessages, ...batchMessages]),
      );
    }
  }

  /** SC-06 §44-45/§49 decision envelope for the barrier provider id. */
  private decisionResultMessage(toolName: string, providerId: string, kind: "completed" | "rejected_by_user" | "approval_expired", summary: string): ChatMessage {
    const payload: Record<string, unknown> = {
      status: kind,
      summary,
      source: "tool",
      trust: "untrusted_data",
    };
    return { role: "tool", content: JSON.stringify(payload), name: toolName, tool_call_id: providerId };
  }

  /**
   * SC-06 §8/§46-49 durable approval resume. Called AFTER the SC-02 decision
   * terminalized the approval row. Fail-closed guards + single-flight CAS,
   * then continuation rounds through the SAME run() loop.
   * Returns continued=false WITHOUT model calls when the CAS is lost.
   */
  async *resumeApproval(input: { loopId: string; approvalId: string; transport: "stream" | "buffered" }):
    AsyncGenerator<LoopEvent, { continued: boolean; loopState?: string }> {
    const rows = this.readResumeRows(input.loopId, input.approvalId);
    if (!rows.ok) {
      yield rows.event;
      const truth = this.store.getLoop(input.loopId);
      return { continued: false, loopState: truth?.state };
    }
    const guards = this.checkResumeGuards(input.loopId);
    if (!guards.ok) {
      yield guards.event;
      return { continued: false, loopState: "FAILED" };
    }
    const loop = this.store.getLoop(input.loopId);
    const approval = this.store.getApproval(input.approvalId);
    if (!loop || !approval) {
      yield { type: "loop_failed", code: "APPROVAL_INVALID", message: "Resume rows vanished", stop_reason: "security_violation" };
      return { continued: false };
    }
    const barrierToolCall = this.store.getToolCall(approval.tool_call_id);
    if (barrierToolCall?.status === "outcome_unknown") {
      this.store.casLoopState(input.loopId, ["WAITING_APPROVAL"], "FAILED");
      this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "tool_outcome_unknown" });
      yield { type: "loop_failed", code: "TOOL_OUTCOME_UNKNOWN", message: "Approved operation has an unknown outcome; loop cannot resume", stop_reason: "tool_outcome_unknown" };
      return { continued: false, loopState: "FAILED" };
    }
    if (approval.status === "expired" && barrierToolCall?.status === "pending_approval") {
      this.store.updateToolCall(barrierToolCall.id, { status: "failed", resultSummary: "approval expired before decision" });
    }
    const claimed = this.store.claimLoopResumeCAS(input.loopId, input.approvalId);
    if (!claimed) {
      const truth = this.store.getLoop(input.loopId);
      this.metrics.counter("arthur.loop.resume_contention", 1, { mode: guards.mode });
      return { continued: false, loopState: truth?.state };
    }
    this.store.clearLoopBarrier(input.loopId);
    this.metrics.counter("arthur.loop.resumed", 1, { mode: guards.mode, decision: approval.status });
    const fresh = this.store.getLoop(input.loopId);
    if (!fresh) {
      yield { type: "loop_failed", code: "INTERNAL_ERROR", message: "Loop vanished after resume claim", stop_reason: "security_violation" };
      return { continued: false };
    }
    const providerId = barrierToolCall?.provider_call_id ?? "";
    const envelopeProviderId = providerId !== "" ? providerId : approval.tool_call_id;
    const envelope = approval.status === "approved"
      ? this.decisionResultMessage(approval.tool_name, envelopeProviderId, "completed", barrierToolCall?.result_summary ?? "approved tool executed")
      : approval.status === "rejected"
        ? this.decisionResultMessage(approval.tool_name, envelopeProviderId, "rejected_by_user", "The user rejected this action.")
        : this.decisionResultMessage(approval.tool_name, envelopeProviderId, "approval_expired", "The approval request expired before a decision.");
    // Micro-check F14/F47: resume evidence follows (round_no, sequence_no)
    // order — never journal append, approval-creation, or completion order.
    const transcriptEntries = [...this.readJournalTranscript(input.loopId)].sort(
      (a, b) => (a.round_no - b.round_no) || (a.sequence_no - b.sequence_no),
    );
    const evidenceByProvider = new Map<string, ChatMessage>();
    for (const e of transcriptEntries) {
      if (!e.provider_call_id) continue;
      // Deferred siblings keep their deferred/approval_barrier reason (§45);
      // absorbed nag/dedupe entries keep their envelope status/summary.
      const content = e.note === "deferred_by_approval"
        ? JSON.stringify({ status: "deferred", reason: "approval_barrier", summary: e.result_summary ?? e.status, source: "tool", trust: "untrusted_data" })
        : JSON.stringify({ status: e.status, summary: e.result_summary ?? e.status, source: "tool", trust: "untrusted_data" });
      evidenceByProvider.set(e.provider_call_id, {
        role: "tool",
        content,
        name: e.tool_name,
        tool_call_id: e.provider_call_id,
      });
    }
    evidenceByProvider.set(envelopeProviderId, envelope);
    const evidenceMessages = [...evidenceByProvider.values()];
    const userTurn = this.store.getTurn(fresh.turn_id);
    const recentHistory = this.store.getRecentTurns(fresh.session_id, guards.mode, 20)
      .filter(isEligibleHistoryTurn)
      .filter((t) => t.id !== fresh.turn_id)
      .map((t) => ({ role: t.role as "user" | "assistant", content: t.text }));
    const assistantPrior: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: transcriptEntries
        .filter((e) => e.provider_call_id !== "")
        .map((e) => ({ id: e.provider_call_id, name: e.tool_name, arguments: this.safeParseArgs(e.arguments_json) })),
    };
    const currentSchemas = this.registry.listAllowedForMode(guards.mode);
    const baseRequest: ModelRequest = {
      systemContract: SYSTEM_CONTRACT,
      modeContract: MODE_CONTRACTS[guards.mode] ?? "",
      history: [...recentHistory, assistantPrior, ...evidenceMessages],
      toolSchemas: currentSchemas.map((s) => ({ name: s.name, description: s.description, parameters: s.input_schema })),
      userMessage: userTurn?.text ?? "",
      model: this.modelName,
      reasoningProfile: "normal",
      traceId: fresh.trace_id,
      sessionId: fresh.session_id,
      clientRequestId: fresh.client_request_id,
    };
    const seenIds = transcriptEntries.map((e) => e.provider_call_id).filter((id) => id !== "");
    if (envelopeProviderId !== "" && !seenIds.includes(envelopeProviderId)) seenIds.push(envelopeProviderId);
    const priorSummaries: ToolCallSummary[] = transcriptEntries.map((e) => ({
      tool_call_id: e.tool_call_id,
      name: e.tool_name,
      risk: this.registry.getDefinition(e.tool_name)?.risk ?? "read",
      status: e.status as ToolCallSummary["status"],
      result_summary: e.result_summary,
      round: e.round_no,
      sequence: e.sequence_no,
      ...(e.note !== undefined ? { note: e.note } : {}),
    }));
    yield* this.run({
      loopRunId: input.loopId,
      sessionId: fresh.session_id,
      turnId: fresh.turn_id,
      traceId: fresh.trace_id,
      mode: guards.mode,
      clientRequestId: fresh.client_request_id,
      safeMessage: userTurn?.text ?? "",
      history: [],
      baseRequest,
      transport: input.transport,
      resume: {
        startRound: fresh.current_round + 1,
        seenProviderIds: seenIds,
        modelCallsUsed: fresh.model_calls_used,
        toolCallsUsed: fresh.tool_calls_used,
        priorSummaries,
        priorUsage: this.sumTurnUsage(fresh.turn_id),
        priorLatencyMs: this.sumTurnLatency(fresh.turn_id),
        activeMsUsed: fresh.active_runtime_ms,
      },
    });
    return { continued: true, loopState: "RESUMING" };
  }

  /**
   * §117-118 turn totals across pre- + post-decision rounds: restore from
   * the durable model_calls rows (authoritative per-round telemetry).
   */
  private sumTurnUsage(turnId: string): TokenUsage {
    const totals: TokenUsage = {};
    for (const mc of this.store.getModelCallsForTurn(turnId)) {
      if (mc.input_tokens !== undefined) totals.input_tokens = (totals.input_tokens ?? 0) + mc.input_tokens;
      if (mc.output_tokens !== undefined) totals.output_tokens = (totals.output_tokens ?? 0) + mc.output_tokens;
      if (mc.cached_tokens !== undefined) totals.cached_tokens = (totals.cached_tokens ?? 0) + mc.cached_tokens;
    }
    return totals;
  }

  private sumTurnLatency(turnId: string): number {
    let total = 0;
    for (const mc of this.store.getModelCallsForTurn(turnId)) total += mc.latency_ms;
    return total;
  }

  /**
   * F39/F40: cancel this turn's in-flight executions through the SC-03
   * coordinator (durably persisted cancel + same-process attempt abort).
   * Best-effort: never throws; SC-03 rows remain the truth.
   */
  private cancelInFlightTurn(turnId: string): void {
    try {
      const coordinator = this.orchestrator.getCoordinator();
      for (const exec of coordinator.getExecutions().listNonTerminalExecutions(500)) {
        if (exec.turn_id !== turnId) continue;
        try {
          coordinator.requestCancel(exec.id);
        } catch {
          // Per-execution best effort.
        }
      }
    } catch {
      // Cancellation aid must never break the interrupt path.
    }
  }

  /** Lenient canonical-args parse for transcript evidence ({} on failure). */
  private safeParseArgs(json: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to empty args.
    }
    return {};
  }

  /** SC-06 §95-98: read + parse the bounded compact transcript. */
  private readJournalTranscript(loopId: string): import("../../sessions/models").LoopTranscriptEntry[] {
    const loop = this.store.getLoop(loopId);
    if (!loop?.transcript_json) return [];
    try {
      const parsed: unknown = JSON.parse(loop.transcript_json);
      if (!Array.isArray(parsed)) return [];
      return parsed as import("../../sessions/models").LoopTranscriptEntry[];
    } catch {
      return [];
    }
  }

  /** SC-06 §8 resume: mode freeze, schema drift, outcome quarantine (§13/§15/§20). */
  private checkResumeGuards(loopId: string):
    { ok: true; mode: ArthurMode } | { ok: false; event: LoopEvent } {
    const loop = this.store.getLoop(loopId);
    if (!loop) {
      return { ok: false, event: { type: "loop_failed", code: "APPROVAL_INVALID", message: "Conversation loop not found", stop_reason: "security_violation" } };
    }
    const session = this.store.getSession(loop.session_id);
    if (!session || session.mode !== loop.mode) {
      this.store.casLoopState(loopId, ["WAITING_APPROVAL"], "FAILED");
      this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "security_violation" });
      return { ok: false, event: { type: "loop_failed", code: "MODE_VIOLATION", message: "Session mode changed during approval wait; loop cannot resume", stop_reason: "security_violation" } };
    }
    const currentSchemas = this.registry.listAllowedForMode(session.mode);
    const currentFingerprint = this.currentSchemaFingerprint(currentSchemas.map((s) => ({ name: s.name })));
    if (loop.tool_schema_fingerprint && currentFingerprint !== loop.tool_schema_fingerprint) {
      this.store.casLoopState(loopId, ["WAITING_APPROVAL"], "FAILED");
      this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "security_violation" });
      return { ok: false, event: { type: "loop_failed", code: "TOOL_NOT_FOUND", message: "Tool contract changed during approval wait; loop cannot resume", stop_reason: "security_violation" } };
    }
    return { ok: true, mode: session.mode };
  }

  /** SC-06 §8 resume: journal truth + terminal decision rows (guards 1-2). */
  private readResumeRows(loopId: string, approvalId: string):
    { ok: true; loopId: string; approvalId: string } | { ok: false; event: LoopEvent } {
    const loop = this.store.getLoop(loopId);
    if (!loop || loop.state !== "WAITING_APPROVAL" || loop.waiting_approval_id !== approvalId) {
      return { ok: false, event: { type: "loop_failed", code: "APPROVAL_INVALID", message: "Conversation loop is not waiting on this approval", stop_reason: "security_violation" } };
    }
    const approval = this.store.getApproval(approvalId);
    if (!approval) {
      return { ok: false, event: { type: "loop_failed", code: "APPROVAL_INVALID", message: "Approval not found", stop_reason: "security_violation" } };
    }
    if (approval.status === "pending" || approval.status === "executing") {
      return { ok: false, event: { type: "loop_failed", code: "APPROVAL_INVALID", message: "Approval decision is not terminal", stop_reason: "security_violation" } };
    }
    return { ok: true, loopId, approvalId };
  }

  /**
   * Tool-disabled final synthesis (§65-68): one last model call with empty
   * tool schemas and a trusted instruction. Cannot execute tools; a tool
   * proposal here is MODEL_BAD_RESPONSE and executes nothing.
   */
  private async *finishWithSynthesis(args: {
    input: LoopTurnInput;
    currentRequest: ModelRequest;
    allSummaries: ToolCallSummary[];
    totalUsage: TokenUsage;
    totalLatencyMs: number;
    modelCalls: number;
    roundsUsed: number;
    stopReason: LoopStopReason;
    state: LoopState;
    /** Increment 3 §13/§25: per-reason trusted no-tools instruction. */
    instruction?: string;
  }): AsyncGenerator<LoopEvent> {
    const { input, allSummaries } = args;
    this.metrics.counter("arthur.loop.limit_reached", 1, { reason: args.stopReason, mode: input.mode });
    if (input.signal?.aborted) {
      yield { type: "loop_interrupted", partial_text: "", stop_reason: "user_cancelled" };
      return;
    }
    // Tool-disabled synthesis (§65-67): the accumulated follow-up history
    // (frozen base + all round evidence) with tool schemas stripped and the
    // trusted no-tools instruction. This is the last model call.
    const request: ModelRequest = {
      ...args.currentRequest,
      toolSchemas: [],
      systemContract: `${input.baseRequest.systemContract} ${args.instruction ?? "Tool budget is exhausted. Do not request tools. Answer using the available results."}`,
    };
    try {
      const synthT0 = Date.now();
      const result = await this.gateway.generate(request);
      const synthLatency = Date.now() - synthT0;
      this.store.createModelCall({
        id: randomUUID(),
        turnId: input.turnId,
        provider: this.gateway.id,
        model: this.modelName,
        latencyMs: synthLatency,
        status: "success",
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        cachedTokens: result.usage?.cached_tokens,
        providerRequestId: result.raw_provider_id,
      });
      const calls = args.modelCalls + 1;
      if (result.tool_calls.length > 0) {
        // §68: synthesis must not call tools; nothing executes.
        this.metrics.counter("arthur.loop.failed", 1, { stop_reason: "model_bad_response" });
        yield {
          type: "loop_completed", display_text: this.deterministicFallback(allSummaries), status: "completed",
          tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(args.totalLatencyMs, args.totalUsage, calls),
          stop_reason: args.stopReason, rounds_used: args.roundsUsed,
        };
        return;
      }
      yield {
        type: "loop_completed", display_text: this.sanitizer.sanitizeText(result.assistant_text), status: "completed",
        tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(args.totalLatencyMs, result.usage ? sumUsage(args.totalUsage, result.usage) : args.totalUsage, calls),
        stop_reason: args.stopReason, rounds_used: args.roundsUsed,
      };
    } catch {
      // §69: deterministic fallback — concise summaries, never raw payload.
      this.store.createModelCall({
        id: randomUUID(),
        turnId: input.turnId,
        provider: this.gateway.id,
        model: this.modelName,
        latencyMs: 0,
        status: "failed",
      });
      yield {
        type: "loop_completed", display_text: this.deterministicFallback(allSummaries), status: "completed",
        tool_calls: ConversationLoopRunner.sortedSummaries(allSummaries), model: this.turnModel(args.totalLatencyMs, args.totalUsage, args.modelCalls + 1),
        stop_reason: args.stopReason, rounds_used: args.roundsUsed,
      };
    }
  }

  /** Assistant tool-call messages + paired tool results in call order (§27). */
  /**
   * Micro-check F14/F47: authoritative aggregation order. Every externally
   * visible summary array (TurnResponse.tool_calls, continuation_tool_calls,
   * stream turn_completed) is sorted by (round_no ASC, sequence_no ASC) —
   * never DB/journal insertion, approval-creation, completion, or synthetic
   * append order. Stable sort; missing keys sort last. Durable history is
   * never rewritten for presentation.
   */
  private static sortedSummaries(summaries: ToolCallSummary[]): ToolCallSummary[] {
    const key = (s: ToolCallSummary): [number, number] => [
      s.round ?? Number.MAX_SAFE_INTEGER,
      s.sequence ?? Number.MAX_SAFE_INTEGER,
    ];
    return [...summaries].sort((a, b) => {
      const [ar, asq] = key(a);
      const [br, bsq] = key(b);
      return ar - br || asq - bsq;
    });
  }

  private roundMessages(round: ValidatedRound, calls: ProposedToolCall[], results: ChatMessage[]): ChatMessage[] {
    void round;
    const byId = new Map(results.map((m) => [m.tool_call_id, m]));
    const ordered = calls.map((c) => byId.get(c.id)).filter((m): m is ChatMessage => m !== undefined);
    const extras = results.filter((m) => !calls.some((c) => c.id === m.tool_call_id));
    return [...ordered, ...extras];
  }

  /**
   * Increment 3 §19-20 authoritative byte measure: UTF-8 byte length of the
   * EXACT model-facing content string (status + summary + data + pairing
   * envelope). Never string.length for UTF-8. Single function — all loop
   * context accounting flows through here.
   */
  private static modelBytes(content: string): number {
    return Buffer.byteLength(content, "utf8");
  }

  /** True when a model-facing message is already summary-only (compact). */
  private static isCompactMessage(msg: ChatMessage): boolean {
    try {
      const parsed: unknown = JSON.parse(msg.content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
      const rec = parsed as Record<string, unknown>;
      if (rec["data_omitted"] === true) return true;
      return !("data" in rec);
    } catch {
      return true;
    }
  }

  /** Extract the bounded summary from a model-facing message ("" if none). */
  private static messageSummary(msg: ChatMessage): string {
    try {
      const parsed: unknown = JSON.parse(msg.content);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const s = (parsed as Record<string, unknown>)["summary"];
        if (typeof s === "string") return s;
      }
    } catch {
      // Fall through.
    }
    return "";
  }

  /**
   * Increment 3 §21-22 deterministic oldest-first compaction. Replaces the
   * oldest RICH messages with valid summary-only envelopes (pairing, name,
   * status, summary preserved; data_omitted + loop_context_budget reason).
   * Deterministic for identical input/budget. Never truncates JSON (§23): a
   * message is either the full envelope or a complete compact envelope.
   */
  private static compactOldestFirst(messages: ChatMessage[], budgetBytes: number): { messages: ChatMessage[]; compacted: number } {
    const out = [...messages];
    let compacted = 0;
    const total = (): number => out.reduce((n, m) => n + ConversationLoopRunner.modelBytes(m.content), 0);
    for (let i = 0; i < out.length && total() > budgetBytes; i += 1) {
      const msg = out[i] as ChatMessage;
      if (ConversationLoopRunner.isCompactMessage(msg)) continue;
      let status = "completed";
      try {
        const parsed = JSON.parse(msg.content) as { status?: unknown };
        if (typeof parsed.status === "string") status = parsed.status;
      } catch {
        // Keep default status.
      }
      out[i] = {
        role: "tool",
        content: JSON.stringify({
          status,
          summary: ConversationLoopRunner.messageSummary(msg),
          data_omitted: true,
          reason: "loop_context_budget",
          source: "tool",
          trust: "untrusted_data",
        }),
        name: msg.name,
        tool_call_id: msg.tool_call_id,
      };
      compacted += 1;
    }
    return { messages: out, compacted };
  }

  /** §23-26 rejected/failure envelope: status + summary, no policy details. */
  private rejectedResultMessage(call: ProposedToolCall, summary: ToolCallSummary): ChatMessage {
    const payload: Record<string, unknown> = {
      status: summary.status,
      summary: summary.result_summary ?? summary.status,
      source: "tool",
      trust: "untrusted_data",
    };
    return {
      role: "tool",
      content: JSON.stringify(payload),
      name: call.name,
      tool_call_id: call.id,
    };
  }

  /** §69 deterministic fallback: concise summaries only, never raw payload. */
  private deterministicFallback(summaries: ToolCallSummary[]): string {
    const parts = summaries
      .filter((s) => s.status === "completed")
      .map((s) => s.result_summary)
      .filter((s): s is string => Boolean(s));
    if (parts.length > 0) return parts.join("\n");
    return "I could not complete the request within the conversation limits.";
  }

  private turnModel(latencyMs: number, usage: TokenUsage | undefined, calls: number): TurnResponseModel {
    const model: TurnResponseModel = {
      provider: this.gateway.id,
      model: this.modelName,
      latency_ms: latencyMs,
      calls,
    };
    if (usage?.input_tokens !== undefined) model.input_tokens = usage.input_tokens;
    if (usage?.output_tokens !== undefined) model.output_tokens = usage.output_tokens;
    if (usage?.cached_tokens !== undefined) model.cached_tokens = usage.cached_tokens;
    return model;
  }

  /**
   * Increment 3.1 exact proposal fingerprint: the EXACT JSON-safe proposal
   * crossing (snapshotJsonSafe) hashed canonically — NO sanitization or
   * redaction in this pipeline (§1). Semantically distinct secrets hash
   * distinctly even when their model-visible forms collide. Returns null
   * when the args are non-JSON-safe (caller fails the batch pre-dispatch).
   * Matches durable rows: the orchestrator persists the identically derived
   * fingerprint from its pre-sanitize snapshot.
   */
  private proposalFingerprint(name: string, args: Record<string, unknown>): string | null {
    return this.proposalSnapshot(name, args)?.fp ?? null;
  }

  /**
   * Exact snapshot + canonical form shared by fingerprinting and
   * absorbed-entry journaling (single derivation — fingerprint and recorded
   * args can never diverge). The journaled argsJson is the canonical form
   * of the EXACT snapshot (operational continuation metadata, still passed
   * through sanitizeJson at the store boundary for secret safety).
   */
  private proposalSnapshot(name: string, args: Record<string, unknown>): { fp: string; argsJson: string } | null {
    try {
      const snap = snapshotJsonSafe(args, "LoopProposal.arguments") as Record<string, unknown>;
      return { fp: invocationFingerprint(name, snap), argsJson: canonicalizeJson(snap) };
    } catch {
      return null;
    }
  }

  /**
   * Increment 3.1 §6 durable completed-mutation fingerprints: read the
   * persisted invocation_fingerprint column (written by the orchestrator
   * from the exact pre-sanitize snapshot). No rehashing, no raw-args
   * persistence, restart-safe. Reads excluded by the query (§8).
   * OUTCOME_UNKNOWN rows never appear here and must never dedupe (§7).
   */
  private completedMutationFingerprints(turnId: string): Set<string> {
    const out = new Set<string>();
    for (const fp of this.store.getCompletedMutationFingerprints(turnId)) {
      if (typeof fp === "string" && /^[0-9a-f]{64}$/.test(fp)) out.add(fp);
    }
    return out;
  }

  /** Increment 3 §50 anti-nag envelope (no fingerprint/hash exposed, §44). */
  private previouslyRejectedMessage(call: ProposedToolCall): ChatMessage {
    return {
      role: "tool",
      content: JSON.stringify({
        status: "rejected",
        reason: "previously_rejected",
        summary: "The user already rejected this action in this turn.",
        source: "tool",
        trust: "untrusted_data",
      }),
      name: call.name,
      tool_call_id: call.id,
    };
  }

  /** Increment 3 §52 duplicate-mutation envelope. */
  private alreadyCompletedMessage(call: ProposedToolCall, summary: string): ChatMessage {
    return {
      role: "tool",
      content: JSON.stringify({
        status: "already_completed",
        summary,
        source: "tool",
        trust: "untrusted_data",
      }),
      name: call.name,
      tool_call_id: call.id,
    };
  }

  /**
   * SC-06 §16/§95-97 compact transcript append: operational entries only.
   * Resolves each summary to its durable tool_call row for canonical args.
   * Bounded (64 entries, capped summaries, 4KiB args); never rich payloads
   * or reasoning. Best-effort: journal failures never break the turn.
   */
  private appendJournalTranscript(loopId: string, turnId: string, summaries: ToolCallSummary[]): void {
    try {
      const entries = summaries.map((s) => {
        const row = this.store.getToolCall(s.tool_call_id);
        return {
          round_no: s.round ?? 0,
          sequence_no: s.sequence ?? 0,
          provider_call_id: row?.provider_call_id ?? "",
          tool_call_id: s.tool_call_id,
          tool_name: s.name,
          arguments_json: row?.arguments_json ?? "{}",
          status: s.status,
          result_summary: s.result_summary,
        };
      });
      this.store.appendLoopTranscript(loopId, entries);
      void turnId;
    } catch {
      // Journal is advisory except at barrier/resume/terminal CAS gates.
    }
  }

  /** Recompute the current schema fingerprint for resume drift detection. */
  currentSchemaFingerprint(toolSchemas: Array<{ name: string }>): string {
    return toolSchemaFingerprint(
      toolSchemas.map((s) => ({
        name: s.name,
        version: this.registry.getDefinition(s.name)?.version ?? "",
        definitionHash: this.registry.getDefinitionHash(s.name) ?? "",
        allowedModes: [...(this.registry.getDefinition(s.name)?.allowed_modes ?? [])],
      })),
    );
  }
}
