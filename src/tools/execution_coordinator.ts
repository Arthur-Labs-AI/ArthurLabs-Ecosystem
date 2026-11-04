/**
 * Durable tool execution coordinator (SC-03 sections 5, 7-10, 13-14, 17-21,
 * 25-43, 45-52, 58-69). Single lifecycle for AUTO and APPROVED tools: the
 * only difference is how authorization was obtained before entering.
 *
 * Invariant: persist the intent (READY execution + tool call) BEFORE the
 * possible side effect, and never guess what happened after a crash, timeout,
 * or transport failure. Unknown mutation outcomes quarantine as
 * OUTCOME_UNKNOWN and require reconciliation instead of blind retry.
 */
import { randomUUID } from "node:crypto";

import { ArthurError } from "../core/errors/errors";
import type { ArthurMode } from "../core/modes/mode";
import type { Logger } from "../observability/logging";
import type { Metrics } from "../observability/metrics";
import { newId } from "../observability/tracing";
import type { SecretSanitizer } from "../security/sanitize";
import type { PermissionService } from "./permissions";
import type { ToolRegistry } from "./registry";
import type { ToolExecutionContext, ToolResult } from "./contracts";
import { computeRetryDelayMs, type ToolExecutionPolicy } from "./execution_policy";
import { ExecutionStore } from "../sessions/execution_store";
import type { SessionStore } from "../sessions/store";
import type { ExecutionRecordStatus, ToolExecutionAttemptRow, ToolExecutionRow } from "../sessions/models";
import type { ToolReconciler } from "./execution_types";
import { DefaultRetryRandomSource, newRuntimeInstanceId, RealExecutionClock, type ExecutionClock, type RetryRandomSource } from "./execution_clock";
import { SingleAttemptExecutionService } from "./execution_service_v2";

export interface AuthorizedExecutionRequest {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
  turnId: string;
  traceId: string;
  mode: ArthurMode;
  toolCallId: string;
  approvalId?: string | null;
  authorization?: ToolExecutionContext["authorization"];
  approvalToken?: ToolExecutionContext["approvalToken"];
  toolVersion: string;
  toolDefinitionHash: string;
  argumentsHash: string;
  policy: ToolExecutionPolicy;
  deadlineMs?: number;
  reconciler?: ToolReconciler;
}

export interface ExecutionRunResult {
  executionId: string;
  toolCallId: string;
  state: ExecutionRecordStatus;
  result?: ToolResult;
  errorCode?: string;
  errorSummary?: string;
  attemptCount: number;
  /** Attempts executed so far (for observability/tests). */
  attempts?: ToolExecutionAttemptRow[];
}

interface ActiveAttempt {
  controller: AbortController;
  settled: boolean;
}

function isoToMs(iso: string): number {
  return Date.parse(iso);
}

export class ToolExecutionCoordinator {
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly lastResults = new Map<string, ToolResult>();
  private readonly runtimeInstanceId: string;
  readonly clock: ExecutionClock;
  private readonly jitter: RetryRandomSource;

  constructor(
    private readonly store: SessionStore,
    private readonly executions: ExecutionStore,
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionService,
    private readonly attempts: SingleAttemptExecutionService,
    private readonly sanitizer: SecretSanitizer,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    opts?: { runtimeInstanceId?: string; clock?: ExecutionClock; jitter?: RetryRandomSource },
  ) {
    void this.permissions;
    this.runtimeInstanceId = opts?.runtimeInstanceId ?? newRuntimeInstanceId();
    this.clock = opts?.clock ?? new RealExecutionClock();
    // SC-03 section 90: retry jitter flows through the injected source only.
    // Production defaults to DefaultRetryRandomSource; deterministic tests
    // inject ScriptedRetryRandomSource. Math.random is never called here.
    this.jitter = opts?.jitter ?? new DefaultRetryRandomSource();
  }

  /** Create the durable READY record BEFORE any side effect (SC-03 14/65). */
  createExecution(req: AuthorizedExecutionRequest): ToolExecutionRow {
    const nowIso = this.clock.nowIso();
    const totalMs = req.deadlineMs ?? req.policy.total_timeout_ms;
    const deadlineAt = new Date(this.clock.nowMs() + totalMs).toISOString();
    const executionId = randomUUID();
    // NOTE: transaction-free by design. Callers that also write the tool call
    // or consume an approval wrap this in store.transaction themselves;
    // standalone callers (tests, recovery) get a single-statement INSERT plus
    // in-memory counters, which is crash-safe (no partial intent exists).
    const row = this.executions.insertReadyExecution({
      id: executionId,
      toolCallId: req.toolCallId,
      approvalId: req.approvalId ?? null,
      sessionId: req.sessionId,
      turnId: req.turnId,
      mode: req.mode,
      toolName: req.toolName,
      toolVersion: req.toolVersion,
      toolDefinitionHash: req.toolDefinitionHash,
      argumentsHash: req.argumentsHash,
      maxAttempts: req.policy.retry.max_attempts,
      createdAt: nowIso,
      deadlineAt,
    });
    this.metrics.counter("arthur.tool.execution.created", 1, { tool: req.toolName });
    this.logger.info("tool execution created", {
      trace_id: req.traceId,
      session_id: req.sessionId,
      turn_id: req.turnId,
      tool_name: req.toolName,
      execution_id: executionId,
      tool_call_id: req.toolCallId,
    });
    return row;
  }

  /** Run one logical execution to a terminal-or-waiting state (bounded, recoverable). */
  async run(req: AuthorizedExecutionRequest, executionId?: string): Promise<ExecutionRunResult> {
    const execId = executionId ?? this.createExecution(req).id;
    let exec = this.executions.getExecution(execId);
    if (!exec) throw new ArthurError("TOOL_EXECUTION_CONFLICT", "Execution not found: " + execId);
    const policy = req.policy;

    // Pre-dispatch deadline check: READY with an exceeded deadline never invokes.
    if ((exec.state === "ready" || exec.state === "retry_wait") && this.clock.nowMs() >= isoToMs(exec.deadline_at)) {
      const nowIso = this.clock.nowIso();
      this.store.transaction(() => {
        if (policy.effects === "mutation") {
          this.executions.moveToOutcomeUnknown(execId, "TOOL_TIMEOUT", "execution deadline exceeded before dispatch", nowIso, "timeout", "unknown");
        } else {
          this.executions.moveToTimedOut(execId, "TOOL_TIMEOUT", "execution deadline exceeded before dispatch", nowIso);
        }
      });
      this.metrics.counter(policy.effects === "mutation" ? "arthur.tool.execution.outcome_unknown" : "arthur.tool.execution.timeout", 1);
      exec = this.executions.getExecution(execId) as ToolExecutionRow;
      return this.toResult(exec);
    }

    // Backoff wait for RETRY_WAIT is driven by the caller (orchestrator awaits
    // the persisted next_attempt_at via clock.sleep); the coordinator never
    // spawns detached timers. Here we only enforce the gate.
    if (exec.state === "retry_wait" && exec.next_attempt_at && isoToMs(exec.next_attempt_at) > this.clock.nowMs()) {
      return this.toResult(exec);
    }

    let guard = 0;
    while (guard < policy.retry.max_attempts + 2) {
      guard += 1;
      exec = this.executions.getExecution(execId) as ToolExecutionRow;
      if (exec.state === "succeeded" || exec.state === "failed" || exec.state === "cancelled" || exec.state === "timed_out" || exec.state === "outcome_unknown") {
        return this.toResult(exec);
      }
      if (exec.state === "cancel_requested") {
        // Cancel was requested while idle between attempts: terminalize without dispatch.
        const nowIso = this.clock.nowIso();
        this.store.transaction(() => {
          this.executions.moveToCancelled(execId, "execution cancelled", nowIso);
        });
        this.metrics.counter("arthur.tool.execution.cancelled", 1);
        exec = this.executions.getExecution(execId) as ToolExecutionRow;
        return this.toResult(exec);
      }
      if (exec.state === "retry_wait" && exec.next_attempt_at && isoToMs(exec.next_attempt_at) > this.clock.nowMs()) {
        return this.toResult(exec);
      }
      if (this.clock.nowMs() >= isoToMs(exec.deadline_at)) {
        const nowIso = this.clock.nowIso();
        this.store.transaction(() => {
          if (policy.effects === "mutation") {
            this.executions.moveToOutcomeUnknown(execId, "TOOL_TIMEOUT", "execution deadline exceeded", nowIso, "timeout", "unknown");
          } else {
            this.executions.moveToTimedOut(execId, "TOOL_TIMEOUT", "execution deadline exceeded", nowIso);
          }
        });
        exec = this.executions.getExecution(execId) as ToolExecutionRow;
        return this.toResult(exec);
      }

      const attemptNo = exec.attempt_count + 1;
      if (exec.state === "running") {
        // Another dispatcher owns the in-flight attempt (concurrent resume race
        // or crash-window overlap). Never conclude exhaustion or terminalize
        // from here: report stored truth and let the owner commit. This closes
        // the resume-race where a second run() would overwrite RUNNING with a
        // spurious exhaustion verdict while attempt N is still executing.
        return this.toResult(exec);
      }
      if (attemptNo > policy.retry.max_attempts) {
        const nowIso = this.clock.nowIso();
        this.store.transaction(() => {
          // SC-03 section 104 retry exhaustion: known-not-applied outcome ->
          // FAILED + TOOL_RETRY_EXHAUSTED; unknown mutation outcome ->
          // OUTCOME_UNKNOWN quarantine (never a blind FAILED that invites a
          // duplicate). The last attempt row already records its own terminal
          // state; only the execution row transitions here.
          if (policy.effects === "mutation" && (exec?.last_error_code === "TOOL_OUTCOME_UNKNOWN" || exec?.last_error_code === "TOOL_TIMEOUT")) {
            this.executions.moveToOutcomeUnknown(execId, "TOOL_OUTCOME_UNKNOWN", exec?.last_error_summary ?? "retry budget exhausted with uncertain outcome", nowIso, "timeout", "unknown");
          } else {
            this.executions.moveToFailedExhausted(execId, "TOOL_RETRY_EXHAUSTED", "retry budget exhausted", nowIso);
          }
        });
        exec = this.executions.getExecution(execId) as ToolExecutionRow;
        return this.toResult(exec);
      }

      const outcome = await this.runAttempt(req, exec, attemptNo, policy);
      if (outcome === "continue") continue;
      exec = this.executions.getExecution(execId) as ToolExecutionRow;
      return this.toResult(exec);
    }
    exec = this.executions.getExecution(execId) as ToolExecutionRow;
    return this.toResult(exec);
  }

  /**
   * Execute a single attempt: atomic claim, bounded dispatch, durable commit.
   * Returns "continue" when a retry_wait was scheduled and the loop may proceed
   * (after the caller honors the backoff gate above).
   */
  private async runAttempt(
    req: AuthorizedExecutionRequest,
    exec: ToolExecutionRow,
    attemptNo: number,
    policy: ToolExecutionPolicy,
  ): Promise<"done" | "continue"> {
    const executionId = exec.id;
    const attemptId = newId();
    const startedIso = this.clock.nowIso();
    const claimed = this.store.transaction(() =>
      this.executions.claimAttempt({
        executionId,
        attemptId,
        attemptNo,
        runtimeInstanceId: this.runtimeInstanceId,
        startedAt: startedIso,
      }),
    );
    if (!claimed) {
      // Duplicate retry race lost (SC-03 96): another claim won; stop.
      this.metrics.counter("arthur.tool.execution.retry", 1, { result: "race_lost" });
      return "done";
    }
    this.metrics.counter("arthur.tool.execution.started", 1, { tool: req.toolName });
    this.logger.info("tool attempt started", {
      trace_id: req.traceId,
      session_id: req.sessionId,
      turn_id: req.turnId,
      tool_name: req.toolName,
      execution_id: executionId,
      attempt_id: attemptId,
      attempt_no: attemptNo,
    });
    const attemptStarted = this.clock.nowMs();

    // Attempt deadline = min(now + attempt_timeout, overall deadline).
    const attemptDeadlineMs = Math.min(this.clock.nowMs() + policy.attempt_timeout_ms, isoToMs(exec.deadline_at));
    const controller = new AbortController();
    this.active.set(executionId, { controller, settled: false });
    // Bounded attempt timeout: intentionally NOT unref'd. The timer must hold
    // the loop while an attempt is in flight, otherwise an idle loop drains
    // and the timeout never fires. The bound itself (<= attempt_timeout_ms)
    // guarantees it cannot hold the process open indefinitely.
    const timeoutHandle = setTimeout(() => controller.abort(new Error("attempt timeout")), Math.max(0, attemptDeadlineMs - this.clock.nowMs()));
    // Overall-deadline + user-cancel listeners feed the same controller via requestCancel().

    const ctx: ToolExecutionContext = {
      session_id: req.sessionId,
      turn_id: req.turnId,
      trace_id: req.traceId,
      mode: req.mode,
      approved: req.authorization !== undefined,
      approvalToken: req.approvalToken,
      authorization: req.authorization,
      execution_id: executionId,
      attempt_id: attemptId,
      attempt_no: attemptNo,
      deadline_at: new Date(attemptDeadlineMs).toISOString(),
      signal: controller.signal,
    };

    let attemptCtxArg = { execution_id: executionId, attempt_id: attemptId, attempt_no: attemptNo, deadline_at: new Date(attemptDeadlineMs).toISOString(), signal: controller.signal };
    let outcome;
    try {
      outcome = await this.attempts.executeAttempt({
        name: req.toolName,
        args: req.args,
        ctx,
        attempt: attemptCtxArg,
        policy,
        signal: controller.signal,
        abortGraceMs: policy.abort_grace_ms,
      });
    } catch (err) {
      // Defense in depth: the service classifies everything, but a bug must
      // still quarantine mutations instead of failing blind.
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof ArthurError ? err.code : "TOOL_EXECUTION_FAILED";
      outcome = {
        ok: false as const,
        failure: {
          kind: "permanent" as const,
          effect_outcome: (policy.effects === "mutation" ? "unknown" : "not_applied") as "unknown" | "not_applied",
          retry_hint: false,
          code,
          summary: message,
        },
        effectOutcome: (policy.effects === "mutation" ? "unknown" : "not_applied") as "unknown" | "not_applied",
        kind: "permanent" as const,
      };
    } finally {
      clearTimeout(timeoutHandle);
      const rec = this.active.get(executionId);
      if (rec) rec.settled = true;
      this.active.delete(executionId);
    }
    const durationMs = this.clock.nowMs() - attemptStarted;
    this.metrics.timer("attempt_duration_ms", durationMs, { tool: req.toolName });

    if (outcome.ok) {
      const finishedIso = this.clock.nowIso();
      // Bounded result persistence (SC-03 78/79): summary always; structured
      // data only for result_persistence = 'bounded_json' tools (validated +
      // JSON-safe snapshot from the service boundary, sanitized + size-bounded
      // in the store). summary_only (default) persists no result data.
      const okResult = (outcome as { result: ToolResult }).result;
      const committed = this.store.transaction(() =>
        this.executions.completeSucceeded(
          executionId,
          attemptId,
          outcome.ok ? okResult.summary : "",
          finishedIso,
          policy.result_persistence === "bounded_json" ? okResult.data : undefined,
        ),
      );
      if (!committed) {
        // Cancellation race (SC-03 95): the cancel CAS won first. Report the
        // stored truth instead of inventing a second terminal state.
        const current = this.executions.getExecution(executionId) as ToolExecutionRow;
        this.logger.info("tool attempt commit lost race", {
          trace_id: req.traceId,
          execution_id: executionId,
          attempt_id: attemptId,
          state: current.state,
        });
        return "done";
      }
      if (outcome.ok) this.lastResults.set(executionId, (outcome as { result: ToolResult }).result);
      this.metrics.counter("arthur.tool.execution.succeeded", 1, { tool: req.toolName });
      this.metrics.timer("execution_total_ms", isoToMs(finishedIso) - isoToMs(exec.created_at), { tool: req.toolName });
      this.logger.info("tool execution succeeded", {
        trace_id: req.traceId,
        session_id: req.sessionId,
        turn_id: req.turnId,
        tool_name: req.toolName,
        execution_id: executionId,
        attempt_id: attemptId,
      });
      return "done";
    }

    // Failure path: classify -> quarantine, retry, or fail.
    const failure = outcome.failure;
    const effect = outcome.effectOutcome;
    const wasCancelRequested = (this.executions.getExecution(executionId)?.state === "cancel_requested");
    const finishedIso = this.clock.nowIso();

    // Cancellation semantics (SC-03 40/77/109): a cancel request + clean
    // not-applied abort -> CANCELLED; uncertain mutation -> OUTCOME_UNKNOWN;
    // an already-finished success stays SUCCEEDED (handled by commit race above).
    // NOTE: kind=cancelled WITHOUT a cancel request is impossible after the
    // service fix above (attempt timeouts surface as TOOL_TIMEOUT); the guard
    // stays strict so a timeout can never masquerade as a user cancel.
    // F13/SC-109: ANY failure under an outstanding cancel request resolves by
    // effect evidence, not by failure kind: unknown effect on a mutation is
    // OUTCOME_UNKNOWN (never CANCELLED = never implies rollback), while a
    // proven not_applied effect is CANCELLED regardless of kind.
    if (wasCancelRequested) {
      if (effect === "unknown") {
        this.store.transaction(() =>
          this.executions.moveToOutcomeUnknown(executionId, "TOOL_OUTCOME_UNKNOWN", failure.summary || "cancelled with uncertain side effects", finishedIso, failure.kind, effect),
        );
        this.metrics.counter("arthur.tool.execution.outcome_unknown", 1);
        return "done";
      }
      if (effect === "not_applied") {
        this.store.transaction(() => this.executions.moveToCancelled(executionId, failure.summary || "execution cancelled", finishedIso));
        this.metrics.counter("arthur.tool.execution.cancelled", 1);
        return "done";
      }
    }

    // Timeout semantics (SC-03 42/76): side-effect-free abort -> TIMED_OUT,
    // mutation with uncertain state -> OUTCOME_UNKNOWN.
    if (failure.kind === "timeout") {
      if (policy.effects === "mutation") {
        this.store.transaction(() =>
          this.executions.moveToOutcomeUnknown(executionId, "TOOL_TIMEOUT", failure.summary, finishedIso, failure.kind, effect),
        );
        this.metrics.counter("arthur.tool.execution.outcome_unknown", 1);
        return "done";
      }
      // Side-effect-free timeouts may still retry when policy allows.
      if (this.retryAllowed(req, policy, executionId, attemptNo, failure.retry_hint, finishedIso)) {
        this.scheduleRetry(req, executionId, attemptNo, policy, failure, finishedIso);
        return "continue";
      }
      this.store.transaction(() => {
        const exhausted = attemptNo >= policy.retry.max_attempts;
        this.executions.completeFailed(executionId, attemptId, exhausted ? "TOOL_RETRY_EXHAUSTED" : "TOOL_TIMEOUT", failure.summary, finishedIso, true);
      });
      this.metrics.counter("arthur.tool.execution.timeout", 1);
      return "done";
    }

    // Output-invalid after mutation -> quarantine/reconcile (SC-03 31/111).
    // Effect unknown + non-idempotent -> never retry (SC-03 29/102).
    if (effect === "unknown") {
      if (policy.effects === "mutation" && policy.idempotency === "operation_key") {
        // Same operation id may be retried against an idempotent target.
        if (this.retryAllowed(req, policy, executionId, attemptNo, true, finishedIso)) {
          this.scheduleRetry(req, executionId, attemptNo, policy, failure, finishedIso);
          return "continue";
        }
      }
      this.store.transaction(() =>
        this.executions.moveToOutcomeUnknown(executionId, failure.code || "TOOL_OUTCOME_UNKNOWN", failure.summary, finishedIso, failure.kind, effect),
      );
      this.metrics.counter("arthur.tool.execution.outcome_unknown", 1);
      return "done";
    }

    // Known-not-applied failures: retry only when every gate passes (SC-03 25).
    if (failure.kind === "transient" && this.retryAllowed(req, policy, executionId, attemptNo, failure.retry_hint, finishedIso)) {
      this.scheduleRetry(req, executionId, attemptNo, policy, failure, finishedIso);
      return "continue";
    }
    if (failure.kind === "output_invalid" && policy.effects === "none" && this.retryAllowed(req, policy, executionId, attemptNo, false, finishedIso)) {
      this.scheduleRetry(req, executionId, attemptNo, policy, failure, finishedIso);
      return "continue";
    }

    const exhausted = attemptNo >= policy.retry.max_attempts;
    // Legacy marker preserved on the durable record: execution failures persist
    // as "execution failed: <cause>" (pre-SC-03 audit text contract).
    const recordSummary = failure.summary.startsWith("execution failed:")
      ? failure.summary
      : `execution failed: ${failure.summary}`;
    this.store.transaction(() => {
      this.executions.completeFailed(
        executionId,
        attemptId,
        exhausted && (failure.kind === "transient" || failure.kind === "timeout") ? "TOOL_RETRY_EXHAUSTED" : failure.code,
        recordSummary,
        finishedIso,
        true,
      );
    });
    this.metrics.counter("arthur.tool.execution.failed", 1);
    return "done";
  }

  private retryAllowed(
    req: AuthorizedExecutionRequest,
    policy: ToolExecutionPolicy,
    executionId: string,
    attemptNo: number,
    retryHint: boolean,
    nowIso: string,
  ): boolean {
    void req;
    void nowIso;
    // SC-03 section 25: ALL conditions must hold.
    if (policy.retry.strategy === "off") return false;
    if (!retryHint && policy.effects !== "none") return false;
    if (policy.effects === "none" && policy.retry.strategy === "transient") {
      // side-effect-free reads may retry transient/timeout failures.
    } else if (!retryHint) {
      return false;
    }
    if (attemptNo >= policy.retry.max_attempts) return false;
    const exec = this.executions.getExecution(executionId);
    if (!exec) return false;
    if (this.clock.nowMs() >= isoToMs(exec.deadline_at)) return false;
    if (exec.state === "cancel_requested") return false;
    // Safe-to-repeat: intrinsic reads, or operation_key idempotent mutations.
    if (policy.effects === "mutation" && policy.idempotency !== "operation_key" && policy.idempotency !== "intrinsic") {
      return false;
    }
    return true;
  }

  private scheduleRetry(
    req: AuthorizedExecutionRequest,
    executionId: string,
    attemptNo: number,
    policy: ToolExecutionPolicy,
    failure: { kind: string; code: string; summary: string; effect_outcome: string },
    nowIso: string,
  ): void {
    void nowIso;
    const delay = computeRetryDelayMs(policy, attemptNo, this.jitter.next01());
    const nextAt = new Date(this.clock.nowMs() + delay).toISOString();
    const ok = this.store.transaction(() =>
      this.executions.moveToRetryWait(executionId, nextAt, failure.code, failure.summary, failure.kind, failure.effect_outcome),
    );
    if (ok) {
      this.metrics.counter("arthur.tool.execution.retry", 1, {
        tool: req.toolName,
        attempt_no: String(attemptNo),
        failure_kind: failure.kind,
      });
      this.metrics.timer("retry_delay_ms", delay, { tool: req.toolName });
      this.logger.info("tool execution retry scheduled", {
        trace_id: req.traceId,
        execution_id: executionId,
        attempt_no: attemptNo,
        next_attempt_at: nextAt,
        failure_kind: failure.kind,
      });
    }
  }

  private toResult(exec: ToolExecutionRow): ExecutionRunResult {
    return {
      executionId: exec.id,
      toolCallId: exec.tool_call_id,
      state: exec.state,
      result: this.lastResults.get(exec.id),
      errorCode: exec.last_error_code ?? undefined,
      errorSummary: exec.last_error_summary ?? undefined,
      attemptCount: exec.attempt_count,
      attempts: this.executions.listAttempts(exec.id),
    };
  }

  /** Last validated success result (in-memory only; never persisted raw). */
  lastResult(executionId: string): ToolResult | undefined {
    return this.lastResults.get(executionId);
  }

  /**
   * Public stored-truth view of an execution (single-flight resume path):
   * reflects the DURABLE row without dispatching, claiming, or mutating.
   * Terminal states report their persisted outcome; non-terminal states report
   * as-is so the caller can decide to drive or wait.
   */
  toPublicResult(exec: ToolExecutionRow): ExecutionRunResult {
    return this.toResult(exec);
  }

  /** Client cancellation (SC-03 40/41/69/70): persist first, then abort. */
  requestCancel(executionId: string): ToolExecutionRow | undefined {
    const exec = this.executions.getExecution(executionId);
    if (!exec) return undefined;
    const nowIso = this.clock.nowIso();
    if (exec.state === "ready" || exec.state === "retry_wait") {
      this.store.transaction(() => this.executions.moveToCancelled(executionId, "cancelled before start", nowIso));
      this.metrics.counter("arthur.tool.execution.cancelled", 1);
      return this.executions.getExecution(executionId);
    }
    if (exec.state === "running" || exec.state === "cancel_requested") {
      this.store.transaction(() => this.executions.requestCancel(executionId, nowIso));
      this.metrics.counter("arthur.tool.execution.cancel_requested", 1);
      this.active.get(executionId)?.controller.abort(new Error("user cancellation"));
      return this.executions.getExecution(executionId);
    }
    return exec;
  }

  /** Safe status view (SC-03 71). */
  getStatus(executionId: string): import("./execution_types").ExecutionStatusView | undefined {
    const exec = this.executions.getExecution(executionId);
    if (!exec) return undefined;
    return {
      execution_id: exec.id,
      tool_call_id: exec.tool_call_id,
      tool: { name: exec.tool_name, version: exec.tool_version },
      state: exec.state,
      attempt_count: exec.attempt_count,
      created_at: exec.created_at,
      started_at: exec.started_at,
      deadline_at: exec.deadline_at,
      can_cancel: exec.state === "ready" || exec.state === "retry_wait" || exec.state === "running",
      reconciliation_required: exec.reconciliation_required === 1 || exec.state === "outcome_unknown",
    };
  }

  getExecution(executionId: string): ToolExecutionRow | undefined {
    return this.executions.getExecution(executionId);
  }

  /** Direct store access for atomic consume/bind paths (same DB transaction). */
  getExecutions(): ExecutionStore {
    return this.executions;
  }

  listAttempts(executionId: string): ToolExecutionAttemptRow[] {
    return this.executions.listAttempts(executionId);
  }

  /**
   * Startup crash recovery (SC-03 58-63, 97-99, 112): scan non-terminal
   * executions left by a dead runtime instance and apply deterministic rules.
   * Fully synchronous DB work (no awaits inside): production startup calls the
   * sync wrapper below; the async alias exists for call-site compatibility.
   */
  recoverStaleExecutionsSync(currentInstanceId?: string): { recovered: number } {
    const me = currentInstanceId ?? this.runtimeInstanceId;
    const stale = this.executions.listNonTerminalExecutions();
    let recovered = 0;
    for (const exec of stale) {
      const policy = this.registry.getExecutionPolicy(exec.tool_name);
      const nowIso = this.clock.nowIso();
      const deadlinePassed = this.clock.nowMs() >= isoToMs(exec.deadline_at);
      if (exec.state === "ready") {
        // Resume only when deadline/authorization/definition still valid.
        const def = this.registry.getDefinition(exec.tool_name);
        if (deadlinePassed || !def || def.version !== exec.tool_version) {
          this.store.transaction(() => {
            if ((policy?.effects ?? "none") === "mutation") {
              this.executions.moveToOutcomeUnknown(exec.id, "TOOL_TIMEOUT", "stale ready execution past deadline", nowIso, "timeout", "unknown");
            } else {
              this.executions.moveToTimedOut(exec.id, "TOOL_TIMEOUT", "stale ready execution past deadline", nowIso);
            }
          });
        }
        recovered += 1;
        continue;
      }
      if (exec.state === "retry_wait") {
        recovered += 1;
        continue;
      }
      if (exec.state === "running" || exec.state === "cancel_requested") {
        const attempts = this.executions.listAttempts(exec.id);
        const runningAttempt = attempts.find((a) => a.state === "running");
        const foreign = !runningAttempt || runningAttempt.runtime_instance_id !== me;
        if (!foreign) continue;
        const effects = policy?.effects ?? "none";
        this.store.transaction(() => {
          if (effects === "mutation") {
            this.executions.moveToOutcomeUnknown(exec.id, "TOOL_OUTCOME_UNKNOWN", "stale running mutation after restart", nowIso, "timeout", "unknown");
          } else if (deadlinePassed) {
            this.executions.moveToTimedOut(exec.id, "TOOL_TIMEOUT", "stale running execution past deadline", nowIso);
          } else {
            // Side-effect-free stale RUNNING: safe retry/fail path. Mark the
            // orphan attempt failed so history is preserved, then retry_wait
            // when budget remains, else terminal FAILED. The execution-level
            // transition must not depend on a running attempt row (the orphan
            // was just terminalized above), so use the recovery helpers.
            if (runningAttempt) {
              this.executions.updateAttemptOutcome(runningAttempt.id, { state: "failed", code: "TOOL_EXECUTION_FAILED", summary: "stale attempt after restart", kind: "transient", effect: "not_applied", finishedAt: nowIso });
            }
            if (exec.attempt_count < (policy?.retry.max_attempts ?? 1) && policy?.retry.strategy === "transient") {
              this.executions.recoverToRetryWait(exec.id, nowIso, "TOOL_EXECUTION_FAILED", "execution failed: stale attempt after restart");
            } else {
              this.executions.recoverToFailed(exec.id, "TOOL_EXECUTION_FAILED", "execution failed: stale attempt after restart", nowIso);
            }
          }
        });
        recovered += 1;
        continue;
      }
      if (exec.state === "outcome_unknown" || exec.state === "reconciling") {
        recovered += 1;
      }
    }
    return { recovered };
  }

  /** Async alias (same production path, awaitable at call sites). */
  async recoverStaleExecutions(currentInstanceId?: string): Promise<{ recovered: number }> {
    return this.recoverStaleExecutionsSync(currentInstanceId);
  }

  /** Reconcile an OUTCOME_UNKNOWN execution via a read-only reconciler (SC-03 53-57). */
  async reconcile(executionId: string, reconciler: ToolReconciler): Promise<ToolExecutionRow | undefined> {
    const exec = this.executions.getExecution(executionId);
    if (!exec || exec.state !== "outcome_unknown") return exec ?? undefined;
    const claimed = this.store.transaction(() => this.executions.moveToReconciling(executionId));
    if (!claimed) return this.executions.getExecution(executionId);
    const t0 = this.clock.nowMs();
    let verdict: import("./execution_types").ToolReconcileVerdict;
    try {
      verdict = await reconciler.reconcile(executionId);
    } catch {
      verdict = "unknown";
    }
    this.metrics.timer("reconciliation_ms", this.clock.nowMs() - t0, { tool: exec.tool_name });
    this.metrics.counter("arthur.tool.execution.reconcile", 1, { verdict });
    const nowIso = this.clock.nowIso();
    this.store.transaction(() => {
      if (verdict === "succeeded") {
        this.executions.reconcileTerminal(executionId, "succeeded", "completed", "reconciled: operation succeeded", nowIso);
      } else if (verdict === "failed" || verdict === "not_applied") {
        this.executions.reconcileTerminal(executionId, "failed", "failed", "reconciled: operation did not apply", nowIso);
      } else if (verdict === "still_running") {
        this.executions.casExecutionState(executionId, ["reconciling"], "outcome_unknown");
      } else {
        this.executions.casExecutionState(executionId, ["reconciling"], "outcome_unknown");
      }
    });
    return this.executions.getExecution(executionId);
  }

  /** Expose runtime identity for recovery tests. */
  runtimeId(): string {
    return this.runtimeInstanceId;
  }
}
