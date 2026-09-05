/**
 * Tool orchestrator (spec section 10, 12; audit BLOCKER 1/2, MEDIUM 6/7, HIGH 5).
 *
 * Validates model-proposed tool calls, enforces the permission/approval
 * skeleton, executes only what is allowed through the secured execution facade,
 * and records every tool call. Model output can never execute arbitrary code,
 * shell commands, or network calls: only registered executors run, and only
 * after validation + permission checks.
 *
 * Approvals are executed as a state machine (pending -> executing -> approved /
 * failed) with an atomic compare-and-swap claim, so two concurrent approvals of
 * the same id execute the underlying action exactly once.
 */

import { ArthurError, approvalInvalid, modeViolation, toArthurError } from "../core/errors/errors";
import { ArthurMode } from "../core/modes/mode";
import type { ApprovalOutcome, ToolCallSummary } from "../core/conversation/models";
import type { ChatMessage, ProposedToolCall } from "../models/contracts";
import { Logger } from "../observability/logging";
import { Metrics } from "../observability/metrics";
import { newId, newTraceId } from "../observability/tracing";
import type { SessionStore } from "../sessions/store";
import { SecretSanitizer } from "../security/sanitize";
import { ApprovalToken, ToolExecutionContext, ToolDefinition, ToolResult } from "./contracts";
import { ToolExecutionService } from "./execution";
import { buildModelToolResultPayload, MODEL_TOOL_RESULT_MAX_BYTES } from "./model_payload";
import { argumentsDigest, PermissionService, signApprovalToken } from "./permissions";
import { ToolRegistry } from "./registry";

export interface ToolOrchestratorDeps {
  registry: ToolRegistry;
  execution: ToolExecutionService;
  store: SessionStore;
  permissions: PermissionService;
  sanitizer: SecretSanitizer;
  approvalTtlSeconds: number;
  approvalSigningSecret: string;
  /**
   * Model-facing tool-result payload cap in bytes (TASK-0011B). Defaults to
   * MODEL_TOOL_RESULT_MAX_BYTES (16 KiB); oversized data is omitted whole,
   * never partially truncated. A non-positive or non-finite value is invalid
   * and silently falls back to the default (TASK-0011B-F1): it must never be
   * able to weaken or disable the bound.
   */
  modelToolResultMaxBytes?: number;
  logger: Logger;
  metrics: Metrics;
}

export interface ProposedHandling {
  summaries: ToolCallSummary[];
  needsApproval: boolean;
  /** Tool result messages for the model follow-up round (completed tools only). */
  toolResultMessages: ChatMessage[];
}

export class ToolOrchestrator {
  private readonly registry: ToolRegistry;
  private readonly execution: ToolExecutionService;
  private readonly store: SessionStore;
  private readonly permissions: PermissionService;
  private readonly sanitizer: SecretSanitizer;
  private readonly approvalTtlSeconds: number;
  private readonly approvalSigningSecret: string;
  private readonly modelToolResultMaxBytes: number;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(deps: ToolOrchestratorDeps) {
    this.registry = deps.registry;
    this.execution = deps.execution;
    this.store = deps.store;
    this.permissions = deps.permissions;
    this.sanitizer = deps.sanitizer;
    this.approvalTtlSeconds = deps.approvalTtlSeconds;
    this.approvalSigningSecret = deps.approvalSigningSecret;
    // TASK-0011B-F1 hardening: a positive finite cap is accepted (floored to
    // whole bytes); 0, negative values, NaN, or Infinity are invalid and fall
    // back to the default 16 KiB bound - NaN would otherwise compare false
    // against every size and silently disable the cap, and 0/negative would
    // omit every payload while looking like a "bounded" configuration.
    const requestedCap = deps.modelToolResultMaxBytes;
    this.modelToolResultMaxBytes =
      typeof requestedCap === "number" && Number.isFinite(requestedCap) && requestedCap > 0
        ? Math.floor(requestedCap)
        : MODEL_TOOL_RESULT_MAX_BYTES;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
  }

  async handleProposed(proposed: ProposedToolCall[], ctx: ToolExecutionContext): Promise<ProposedHandling> {
    const summaries: ToolCallSummary[] = [];
    const toolResultMessages: ChatMessage[] = [];
    let needsApproval = false;

    for (const call of proposed) {
      const start = Date.now();
      const definition = this.registry.getDefinition(call.name);
      const safeArgs = this.sanitizer.sanitizeObject(call.arguments);

      if (!definition) {
        const summary = this.rejectedSummary(call, "unknown_tool", "unknown tool");
        summaries.push(summary);
        this.recordToolCall(ctx, call, undefined, "rejected", summary.result_summary ?? "unknown tool");
        this.logger.warn("tool rejected: unknown tool", {
          trace_id: ctx.trace_id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          tool_name: call.name,
        });
        this.metrics.counter("arthur.tool.rejected", 1, { reason: "unknown" });
        continue;
      }

      const validation = this.registry.validateArgs(call.name, safeArgs);
      if (!validation.valid) {
        const summary = this.rejectedSummary(
          call,
          definition.risk,
          `invalid arguments: ${(validation.errors ?? []).join("; ")}`,
        );
        summaries.push(summary);
        this.recordToolCall(ctx, call, definition, "rejected", summary.result_summary ?? "invalid arguments");
        this.logger.warn("tool rejected: invalid arguments", {
          trace_id: ctx.trace_id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          tool_name: call.name,
        });
        this.metrics.counter("arthur.tool.rejected", 1, { reason: "invalid_arguments" });
        continue;
      }

      const decision = this.permissions.evaluate(definition, ctx.mode);

      if (decision === "reject") {
        const reason = !definition.allowed_modes.includes(ctx.mode)
          ? `not permitted in ${ctx.mode} mode`
          : "high-risk action rejected in Phase 1";
        const summary = this.rejectedSummary(call, definition.risk, reason);
        summaries.push(summary);
        this.recordToolCall(ctx, call, definition, "rejected", summary.result_summary ?? reason);
        this.logger.warn("tool rejected", {
          trace_id: ctx.trace_id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          tool_name: call.name,
          risk: definition.risk,
          reason,
        });
        this.metrics.counter("arthur.tool.rejected", 1, { reason: "permission" });
        continue;
      }

      if (decision === "approval") {
        needsApproval = true;
        const { summary } = this.createPendingApproval(call, safeArgs, definition, ctx);
        summaries.push(summary);
        this.logger.info("tool pending approval", {
          trace_id: ctx.trace_id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          tool_name: call.name,
          approval_id: summary.approval_id,
        });
        this.metrics.counter("arthur.tool.pending_approval", 1);
        continue;
      }

      // decision === "auto": execute now (read / low_write) through the facade.
      try {
        const result = await this.execution.execute(call.name, safeArgs, ctx);
        const safeSummary = this.sanitizer.capSummary(result.summary);
        const summary = this.completedSummary(call, definition, { ok: result.ok, summary: safeSummary });
        summaries.push(summary);
        this.recordToolCall(ctx, call, definition, "completed", safeSummary);
        // TASK-0011B: the model follow-up receives a bounded structured
        // payload (summary + validated data), not just the summary. The data
        // already crossed the ToolExecutionService validation boundary; the
        // payload builder re-sanitizes it recursively and enforces the
        // model-facing size cap (oversized data is omitted whole).
        toolResultMessages.push({
          role: "tool",
          content: buildModelToolResultPayload(result, this.sanitizer, this.modelToolResultMaxBytes),
          name: call.name,
          tool_call_id: call.id,
        });
        this.logger.info("tool executed", {
          trace_id: ctx.trace_id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          tool_name: call.name,
          risk: definition.risk,
          duration_ms: Date.now() - start,
        });
        this.metrics.counter("arthur.tool.executed", 1, { risk: definition.risk });
        this.metrics.timer("arthur.tool.duration_ms", Date.now() - start, { tool: call.name });
      } catch (err) {
        const message = this.sanitizer.capSummary(err instanceof Error ? err.message : "tool execution failed");
        // The execution facade wraps raw executor failures into a generic
        // TOOL_EXECUTION_FAILED message; the sanitized cause is kept for the
        // LOCAL log only (never persisted to tool records or sent to model).
        const causeMessage =
          err instanceof ArthurError && err.cause instanceof Error
            ? this.sanitizer.capSummary(err.cause.message)
            : undefined;
        const summary = this.rejectedSummary(call, definition.risk, `execution failed: ${message}`);
        summaries.push(summary);
        this.recordToolCall(ctx, call, definition, "failed", `execution failed: ${message}`);
        this.logger.error("tool execution failed", {
          trace_id: ctx.trace_id,
          session_id: ctx.session_id,
          turn_id: ctx.turn_id,
          tool_name: call.name,
          error: message,
          cause: causeMessage,
        });
        this.metrics.counter("arthur.tool.failed", 1);
      }
    }

    return { summaries, needsApproval, toolResultMessages };
  }

  async executeApproval(approvalId: string): Promise<ApprovalOutcome> {
    let approval = this.store.getApproval(approvalId);
    if (!approval) {
      throw approvalInvalid(`Approval not found: ${approvalId}`, { approval_id: approvalId });
    }

    // An executing record has an unknown external outcome after a crash.
    // Never automatically reset or retry it; reconciliation must determine the
    // adapter outcome first, otherwise a retry could duplicate an external write.

    switch (approval.status) {
      case "approved":
      case "rejected":
      case "failed":
        return { approval_id: approvalId, tool_name: approval.tool_name, status: "already_resolved" };
      case "executing":
        // Concurrent duplicate or a crash left the record mid-flight. Never re-execute.
        throw approvalInvalid("Approval is currently being executed", { approval_id: approvalId });
      case "expired":
        throw approvalInvalid("Approval expired", { approval_id: approvalId, expires_at: approval.expires_at });
      case "pending":
        break;
      default:
        throw approvalInvalid("Approval is in an unknown state", { approval_id: approvalId });
    }

    if (new Date(approval.expires_at).getTime() < Date.now()) {
      this.store.updateApproval(approvalId, { status: "expired" });
      throw approvalInvalid("Approval expired", { approval_id: approvalId, expires_at: approval.expires_at });
    }

    // Session must still exist; fail closed rather than defaulting to a mode.
    const session = this.store.getSession(approval.session_id);
    if (!session) {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "session no longer exists");
      throw approvalInvalid("Approval session no longer exists", { approval_id: approvalId });
    }

    // The persisted tool call must be the exact record this approval authorizes.
    const toolCall = this.store.getToolCall(approval.tool_call_id);
    if (!toolCall || toolCall.status !== "pending_approval") {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "tool call is not pending approval");
      throw approvalInvalid("Approval does not match a pending tool call", { approval_id: approvalId });
    }
    if (
      toolCall.tool_name !== approval.tool_name ||
      toolCall.turn_id !== approval.turn_id ||
      toolCall.arguments_json !== approval.arguments_json ||
      toolCall.risk_level !== approval.risk_level
    ) {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "approval is not bound to its tool call");
      throw approvalInvalid("Approval is not bound to its persisted tool call", { approval_id: approvalId });
    }

    const definition = this.registry.getDefinition(approval.tool_name);
    if (!definition) {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "tool no longer registered");
      throw new ArthurError("TOOL_NOT_FOUND", `Unknown tool: ${approval.tool_name}`);
    }

    if (definition.risk !== approval.risk_level) {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "tool risk no longer matches approval");
      throw approvalInvalid("Approval risk binding does not match the registered tool", { approval_id: approvalId });
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(approval.arguments_json) as Record<string, unknown>;
    } catch {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "stored arguments are malformed");
      throw approvalInvalid("Stored approval arguments are malformed", { approval_id: approvalId });
    }

    // Cryptographic binding: the recalculated digest must equal the stored hash.
    if (argumentsDigest(args) !== approval.arguments_hash) {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "argument digest mismatch");
      throw approvalInvalid("Approval argument digest does not match", { approval_id: approvalId });
    }

    // Re-validate before execution (spec section 18).
    const validation = this.registry.validateArgs(approval.tool_name, args);
    if (!validation.valid) {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "argument re-validation failed");
      throw new ArthurError(
        "TOOL_ARGUMENT_INVALID",
        `Tool arguments failed re-validation: ${(validation.errors ?? []).join("; ")}`,
      );
    }

    // Re-run the permission decision against the CURRENT session mode.
    const decision = this.permissions.evaluate(definition, session.mode);
    if (decision !== "approval") {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "tool is no longer approved for this session");
      if (!definition.allowed_modes.includes(session.mode)) {
        throw modeViolation(`Tool ${approval.tool_name} is not permitted in ${session.mode} mode`, {
          tool: approval.tool_name,
          mode: session.mode,
        });
      }
      throw approvalInvalid(`Approval is no longer valid for tool ${approval.tool_name}`, {
        approval_id: approvalId,
      });
    }

    // Atomic claim: exactly one concurrent caller wins pending -> executing.
    const claimed = this.store.claimApprovalBound({
      id: approvalId,
      sessionId: approval.session_id,
      sessionMode: session.mode,
      turnId: approval.turn_id,
      toolCallId: approval.tool_call_id,
      toolName: approval.tool_name,
      argumentsJson: approval.arguments_json,
      argumentsHash: approval.arguments_hash,
      riskLevel: approval.risk_level,
    });
    if (!claimed) {
      const current = this.store.getApproval(approvalId);
      if (current?.status === "approved") {
        return { approval_id: approvalId, tool_name: approval.tool_name, status: "already_resolved" };
      }
      throw approvalInvalid("Approval is already being executed", { approval_id: approvalId });
    }

    const signable = {
      approval_id: approvalId,
      tool_name: approval.tool_name,
      session_id: approval.session_id,
      turn_id: approval.turn_id,
      arguments_hash: approval.arguments_hash,
      issued_at: new Date().toISOString(),
      expires_at: approval.expires_at,
    };
    const token: ApprovalToken = {
      ...signable,
      signature: signApprovalToken(signable, this.approvalSigningSecret),
    };
    const ctx: ToolExecutionContext = {
      session_id: approval.session_id,
      turn_id: approval.turn_id,
      trace_id: newTraceId(),
      mode: session.mode,
      approved: true,
      approvalToken: token,
    };

    const start = Date.now();
    try {
      const result = await this.execution.execute(approval.tool_name, args, ctx);
      const safeSummary = this.sanitizer.capSummary(result.summary);
      this.store.completeApproval(approvalId, approval.tool_call_id, safeSummary);
      this.logger.info("approved tool executed", {
        trace_id: ctx.trace_id,
        session_id: approval.session_id,
        turn_id: approval.turn_id,
        tool_name: approval.tool_name,
        approval_id: approvalId,
        duration_ms: Date.now() - start,
      });
      this.metrics.counter("arthur.approval.approved", 1);
      return {
        approval_id: approvalId,
        tool_name: approval.tool_name,
        status: "approved",
        tool_call_id: approval.tool_call_id,
        result_summary: safeSummary,
      };
    } catch (err) {
      const message = this.sanitizer.capSummary(err instanceof Error ? err.message : "execution failed");
      // Once the claim is executing, an adapter error may mean the external
      // write succeeded but its response was lost. Preserve the unknown state;
      // automatic retry is forbidden until explicit reconciliation.
      this.store.recordApprovalExecutionError(approvalId, approval.tool_call_id, message);
      const causeMessage =
        err instanceof ArthurError && err.cause instanceof Error
          ? this.sanitizer.capSummary(err.cause.message)
          : undefined;
      this.logger.error("approved tool execution failed", {
        session_id: approval.session_id,
        turn_id: approval.turn_id,
        tool_name: approval.tool_name,
        approval_id: approvalId,
        error: message,
        cause: causeMessage,
      });
      this.metrics.counter("arthur.approval.failed", 1);
      throw toArthurError(err);
    }
  }

  async rejectApproval(approvalId: string): Promise<ApprovalOutcome> {
    const approval = this.store.getApproval(approvalId);
    if (!approval) {
      throw approvalInvalid(`Approval not found: ${approvalId}`, { approval_id: approvalId });
    }
    if (approval.status !== "pending") {
      return { approval_id: approvalId, tool_name: approval.tool_name, status: "already_resolved" };
    }
    const rejected = this.store.rejectApproval(approvalId, approval.tool_call_id);
    if (!rejected) {
      return { approval_id: approvalId, tool_name: approval.tool_name, status: "already_resolved" };
    }
    this.logger.info("approval rejected", {
      session_id: approval.session_id,
      turn_id: approval.turn_id,
      tool_name: approval.tool_name,
      approval_id: approvalId,
    });
    this.metrics.counter("arthur.approval.rejected", 1);
    return {
      approval_id: approvalId,
      tool_name: approval.tool_name,
      status: "rejected",
      tool_call_id: approval.tool_call_id,
    };
  }

  // ---- helpers -----------------------------------------------------------

  private completedSummary(call: ProposedToolCall, definition: ToolDefinition, result: ToolResult): ToolCallSummary {
    return {
      tool_call_id: call.id,
      name: call.name,
      risk: definition.risk,
      status: "completed",
      result_summary: result.summary,
    };
  }

  private rejectedSummary(call: ProposedToolCall, risk: string, reason: string): ToolCallSummary {
    return {
      tool_call_id: call.id,
      name: call.name,
      risk,
      status: "rejected",
      result_summary: reason,
    };
  }

  private createPendingApproval(
    call: ProposedToolCall,
    safeArgs: Record<string, unknown>,
    definition: ToolDefinition,
    ctx: ToolExecutionContext,
  ): { summary: ToolCallSummary } {
    const toolCallId = newId();
    const argumentsJson = JSON.stringify(safeArgs);
    const argumentsHash = argumentsDigest(safeArgs);
    const approvalId = newId();
    const expiresAt = new Date(Date.now() + this.approvalTtlSeconds * 1000).toISOString();

    this.store.createPendingApprovalAtomic({
      toolCall: {
        id: toolCallId,
        turnId: ctx.turn_id,
        toolName: call.name,
        argumentsJson,
        riskLevel: definition.risk,
      },
      approval: {
        id: approvalId,
        turnId: ctx.turn_id,
        sessionId: ctx.session_id,
        toolCallId,
        toolName: call.name,
        argumentsJson,
        argumentsHash,
        riskLevel: definition.risk,
        expiresAt,
      },
    });

    const summary: ToolCallSummary = {
      tool_call_id: toolCallId,
      name: call.name,
      risk: definition.risk,
      status: "pending_approval",
      approval_id: approvalId,
    };
    return { summary };
  }

  private recordToolCall(
    ctx: ToolExecutionContext,
    call: ProposedToolCall,
    definition: ToolDefinition | undefined,
    status: "completed" | "pending_approval" | "rejected" | "failed",
    resultSummary: string,
  ): void {
    this.store.createToolCall({
      id: newId(),
      turnId: ctx.turn_id,
      toolName: call.name,
      argumentsJson: JSON.stringify(this.sanitizer.sanitizeObject(call.arguments)),
      riskLevel: definition?.risk ?? "read",
      status,
      resultSummary: this.sanitizer.capSummary(resultSummary),
    });
  }
}