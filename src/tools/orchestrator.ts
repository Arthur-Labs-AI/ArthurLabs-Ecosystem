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
import { argumentsDigest, argumentsDigestV2, PermissionService, signApprovalToken } from "./permissions";
import { ToolRegistry } from "./registry";
import { snapshotJsonSafe, JsonSafeError } from "./json_safe";
import { canonicalizeJson } from "./canonical_json";
import {
  APPROVAL_BINDING_VERSION,
  approvalArgumentsHash,
  authorizationDigest,
  presentationHash,
  type ApprovalIntentV2,
  type ApprovalPresentation,
} from "./approval_intent";
import { validatePresentation } from "./approval_presenters";
import { ApprovalSigner, ApprovalVerifier, type ApprovalCapabilityV2 } from "./approval_signer";
import { EphemeralApprovalKeyProvider, type ApprovalKeyProvider } from "./approval_keys";
import type { ApprovalRecord } from "../sessions/models";

export interface ApprovalChallenge {
  approval_id: string;
  tool_call_id: string;
  mode: string;
  tool: { name: string; version: string };
  risk: string;
  presentation: ApprovalPresentation;
  expires_at: string;
}

export interface ToolOrchestratorDeps {
  registry: ToolRegistry;
  execution: ToolExecutionService;
  store: SessionStore;
  permissions: PermissionService;
  sanitizer: SecretSanitizer;
  approvalTtlSeconds: number;
  approvalSigningSecret: string;
  /** SC-02 signing identity; defaults to an ephemeral keypair (tests). */
  approvalKeyProvider?: ApprovalKeyProvider;
  /** Trust ring override (key rotation tests). */
  approvalTrustedKeys?: import("./approval_signer").ApprovalKeypair[];
  /** Audit-only decision channel recorded on approve/reject. */
  decisionChannel?: string;
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
  private readonly approvalKeyProvider: ApprovalKeyProvider;
  private readonly signer: ApprovalSigner;
  private readonly verifier: ApprovalVerifier;
  private readonly decisionChannel: string | undefined;
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
    this.approvalKeyProvider = deps.approvalKeyProvider ?? new EphemeralApprovalKeyProvider();
    const current = this.approvalKeyProvider.current();
    this.signer = new ApprovalSigner(current);
    this.verifier = new ApprovalVerifier(deps.approvalTrustedKeys ?? [current]);
    this.decisionChannel = deps.decisionChannel;
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
      // SC-02 sections 9-10: model arguments cross the JSON-safe TOCTOU
      // boundary FIRST (fresh independent snapshot), then sanitization, then
      // schema validation. The immutable execution snapshot below is exactly
      // what gets hashed AND executed - never validate A then execute B.
      let jsonSafeArgs: unknown;
      try {
        jsonSafeArgs = snapshotJsonSafe(call.arguments, "ToolCall.arguments");
      } catch (err) {
        const reason = err instanceof JsonSafeError ? err.message : "arguments are not JSON-safe";
        const summary = this.rejectedSummary(call, definition?.risk ?? "unknown_tool", `invalid arguments: ${reason}`);
        summaries.push(summary);
        this.recordToolCall(ctx, call, definition, "rejected", summary.result_summary ?? "invalid arguments");
        this.metrics.counter("arthur.tool.rejected", 1, { reason: "json_unsafe" });
        continue;
      }
      const safeArgs = this.sanitizer.sanitizeObject(jsonSafeArgs as Record<string, unknown>);
      let executionSnapshot: Record<string, unknown>;
      try {
        executionSnapshot = snapshotJsonSafe(safeArgs, "ToolCall.executionArgs") as Record<string, unknown>;
      } catch (err) {
        const reason = err instanceof JsonSafeError ? err.message : "arguments are not JSON-safe";
        const summary = this.rejectedSummary(call, definition?.risk ?? "unknown_tool", `invalid arguments: ${reason}`);
        summaries.push(summary);
        this.recordToolCall(ctx, call, definition, "rejected", summary.result_summary ?? "invalid arguments");
        this.metrics.counter("arthur.tool.rejected", 1, { reason: "json_unsafe" });
        continue;
      }

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

      const validation = this.registry.validateArgs(call.name, executionSnapshot ?? safeArgs);
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
        const { summary } = this.createPendingApproval(call, (executionSnapshot ?? safeArgs), definition, ctx);
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
      // The facade receives the SAME immutable snapshot that was validated.
      try {
        const result = await this.execution.execute(call.name, (executionSnapshot ?? safeArgs), ctx);
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
      case "invalidated":
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
      this.metrics.counter("arthur.approval.expired", 1);
      throw approvalInvalid("Approval expired", { approval_id: approvalId, expires_at: approval.expires_at });
    }

    // SC-02 section 44: v1 rows without a v2 binding fail closed, never upgrade.
    if ((approval.binding_version ?? 1) < APPROVAL_BINDING_VERSION) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "legacy v1 approval without v2 binding");
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval binding is from a legacy version and is no longer valid", { approval_id: approvalId });
    }

    // Session must still exist AND be active; fail closed rather than defaulting
    // to a mode (SC-02 section 32: "session exists / session active").
    const session = this.store.getSession(approval.session_id);
    if (!session) {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "session no longer exists");
      throw approvalInvalid("Approval session no longer exists", { approval_id: approvalId });
    }
    if (session.status !== "active") {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "session is no longer active");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval session is no longer active", { approval_id: approvalId });
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
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "tool risk no longer matches approval");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval risk binding does not match the registered tool", { approval_id: approvalId });
    }

    // SC-02 section 22 (mode binding): requested == current == execution.
    // A mode switch already invalidates pending rows atomically; this check
    // closes the race where execution starts with a stale session snapshot.
    if (!approval.mode || approval.mode !== session.mode) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "session mode no longer matches approval mode");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval mode binding does not match the current session mode", { approval_id: approvalId });
    }

    // SC-02 sections 13-14: version + definition fingerprint binding.
    if (!approval.tool_version || approval.tool_version !== definition.version) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "tool version no longer matches approval");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval tool version does not match the registered tool", { approval_id: approvalId });
    }
    const currentDefinitionHash = this.registry.getDefinitionHash(approval.tool_name);
    if (!approval.tool_definition_hash || approval.tool_definition_hash !== currentDefinitionHash) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "tool definition no longer matches approval");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval tool definition does not match the registered tool", { approval_id: approvalId });
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(approval.arguments_json) as Record<string, unknown>;
    } catch {
      this.store.failPendingApproval(approvalId, approval.tool_call_id, "stored arguments are malformed");
      throw approvalInvalid("Stored approval arguments are malformed", { approval_id: approvalId });
    }

    // Cryptographic binding: the recalculated digest must equal the stored hash.
    // V2 canonical form (JCS) is authoritative; the legacy key-sorted form is
    // accepted only for rows created before SC-02 (binding_version < 2 rows
    // already fail closed above, so legacy acceptance here is belt-and-braces).
    if (approvalArgumentsHash(args) !== approval.arguments_hash && argumentsDigest(args) !== approval.arguments_hash) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "argument digest mismatch");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval argument digest does not match", { approval_id: approvalId });
    }

    // Presentation binding: the exact WYSIWYS data the user saw is part of the
    // authorization identity (SC-02 section 19).
    if (!approval.presentation_hash || !approval.presentation_json) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "approval presentation is missing");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval presentation binding is missing", { approval_id: approvalId });
    }
    let storedPresentation: ApprovalPresentation;
    try {
      storedPresentation = JSON.parse(approval.presentation_json) as ApprovalPresentation;
    } catch {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "approval presentation is malformed");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      throw approvalInvalid("Approval presentation is corrupted", { approval_id: approvalId });
    }
    if (presentationHash(storedPresentation) !== approval.presentation_hash) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "presentation digest mismatch");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval presentation digest does not match", { approval_id: approvalId });
    }

    // Rebuild + verify the authorization digest (SC-02 section 25).
    const intent: ApprovalIntentV2 = {
      binding_version: APPROVAL_BINDING_VERSION,
      approval_id: approvalId,
      tool_call_id: approval.tool_call_id,
      session_id: approval.session_id,
      turn_id: approval.turn_id,
      mode: approval.mode as ApprovalIntentV2["mode"],
      tool_name: approval.tool_name,
      tool_version: approval.tool_version,
      tool_definition_hash: approval.tool_definition_hash,
      risk_level: approval.risk_level,
      arguments_hash: approval.arguments_hash,
      presentation_hash: approval.presentation_hash,
      created_at: approval.created_at,
      expires_at: approval.expires_at,
    };
    if (authorizationDigest(intent) !== approval.authorization_digest) {
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "authorization digest mismatch");
      this.metrics.counter("arthur.approval.binding_mismatch", 1);
      this.metrics.counter("arthur.approval.invalidated", 1);
      throw approvalInvalid("Approval authorization digest does not match", { approval_id: approvalId });
    }

    // Re-validate before execution (spec section 18) on the persisted snapshot.
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
      this.store.invalidatePendingApproval(approvalId, approval.tool_call_id, "tool is no longer approved for this session");
      this.metrics.counter("arthur.approval.invalidated", 1);
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
    // The CAS re-checks the FULL v2 binding in one SQL statement.
    const claimed = this.store.claimApprovalBound({
      id: approvalId,
      sessionId: approval.session_id,
      sessionMode: session.mode,
      turnId: approval.turn_id,
      toolCallId: approval.tool_call_id,
      toolName: approval.tool_name,
      toolVersion: approval.tool_version,
      toolDefinitionHash: approval.tool_definition_hash,
      presentationHash: approval.presentation_hash,
      authorizationDigest: approval.authorization_digest ?? undefined,
      argumentsJson: approval.arguments_json,
      argumentsHash: approval.arguments_hash,
      riskLevel: approval.risk_level,
    });
    if (!claimed) {
      const current = this.store.getApproval(approvalId);
      if (current?.status === "approved") {
        return { approval_id: approvalId, tool_name: approval.tool_name, status: "already_resolved" };
      }
      this.metrics.counter("arthur.approval.replay_blocked", 1);
      throw approvalInvalid("Approval is already being executed", { approval_id: approvalId });
    }

    // SC-02 section 26: executor-facing signed capability (Ed25519).
    // The legacy HMAC token is still minted for the harness stub boundary and
    // removed once the stub migrates to capability verification.
    const digest = authorizationDigest(intent);
    const capability: ApprovalCapabilityV2 = this.signer.sign(intent, digest);
    let verified: import("./approval_signer").VerifiedApproval;
    try {
      verified = this.verifier.verify(capability);
    } catch {
      this.metrics.counter("arthur.approval.signature_invalid", 1);
      throw approvalInvalid("Approval capability signature verification failed", { approval_id: approvalId });
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
      authorization: verified,
    };

    if (this.decisionChannel) {
      this.store.recordApprovalDecisionChannel(approvalId, this.decisionChannel);
    }
    const start = Date.now();
    try {
      const result = await this.execution.execute(approval.tool_name, args, ctx);
      const safeSummary = this.sanitizer.capSummary(result.summary);
      this.store.completeApproval(approvalId, approval.tool_call_id, safeSummary);
      this.logger.info("approved tool executed", {
        trace_id: ctx.trace_id,
        session_id: approval.session_id,
        turn_id: approval.turn_id,
        mode: session.mode,
        tool_name: approval.tool_name,
        tool_version: approval.tool_version,
        risk: approval.risk_level,
        approval_id: approvalId,
        tool_call_id: approval.tool_call_id,
        expires_at: approval.expires_at,
        binding_version: approval.binding_version,
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
        mode: session.mode,
        tool_name: approval.tool_name,
        tool_version: approval.tool_version,
        approval_id: approvalId,
        tool_call_id: approval.tool_call_id,
        error: message,
        cause: causeMessage,
      });
      this.metrics.counter("arthur.approval.failed", 1);
      throw toArthurError(err);
    }
  }

  /** Test/rotation hook: trust an additional signing key without restart. */
  addTrustedApprovalKey(keypair: Pick<import("./approval_signer").ApprovalKeypair, "kid" | "publicKeyPem">): void {
    this.verifier.addTrusted(keypair);
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

  /** Server-generated WYSIWYS challenge for a pending approval (SC-02 section 20). */
  getApprovalChallenge(approvalId: string): ApprovalChallenge {
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.status !== "pending") {
      throw approvalInvalid(`Approval not found or not pending: ${approvalId}`, { approval_id: approvalId });
    }
    let presentation: ApprovalPresentation;
    try {
      presentation = JSON.parse(approval.presentation_json ?? "") as ApprovalPresentation;
    } catch {
      throw approvalInvalid("Approval presentation is corrupted", { approval_id: approvalId });
    }
    return {
      approval_id: approval.id,
      tool_call_id: approval.tool_call_id,
      mode: approval.mode ?? "",
      tool: { name: approval.tool_name, version: approval.tool_version ?? "" },
      risk: approval.risk_level,
      presentation,
      expires_at: approval.expires_at,
    };
  }

  /** Trusted spoken summary derived from the presenter (SC-02 section 21), never model prose. */
  approvalVoicePrompt(approvalId: string): string {
    const challenge = this.getApprovalChallenge(approvalId);
    const first = challenge.presentation.details[0];
    const detail = first ? ` ${first.label}: ${first.value}.` : "";
    return `${challenge.presentation.action}.${detail}`.trim();
  }

  private createPendingApproval(
    call: ProposedToolCall,
    executionSnapshot: Record<string, unknown>,
    definition: ToolDefinition,
    ctx: ToolExecutionContext,
  ): { summary: ToolCallSummary } {
    const toolCallId = newId();
    // Canonical execution arguments: hash EXACTLY what the executor receives.
    const argumentsJson = canonicalizeJson(executionSnapshot);
    const argumentsHash = approvalArgumentsHash(executionSnapshot);
    const legacyHash = argumentsDigest(executionSnapshot);
    void legacyHash;
    const approvalId = newId();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.approvalTtlSeconds * 1000).toISOString();
    const definitionHash = this.registry.getDefinitionHash(call.name) ?? "";
    const presenter = this.registry.getPresenter(call.name);
    if (!presenter) {
      throw approvalInvalid(`Approval-required tool ${call.name} has no trusted presenter`, { tool: call.name });
    }
    const presentation = validatePresentation(presenter(executionSnapshot), this.sanitizer);
    const presentationJson = canonicalizeJson(presentation as unknown as Record<string, unknown>);
    const presHash = presentationHash(presentation);
    const intent: ApprovalIntentV2 = {
      binding_version: APPROVAL_BINDING_VERSION,
      approval_id: approvalId,
      tool_call_id: toolCallId,
      session_id: ctx.session_id,
      turn_id: ctx.turn_id,
      mode: ctx.mode,
      tool_name: call.name,
      tool_version: definition.version,
      tool_definition_hash: definitionHash,
      risk_level: definition.risk,
      arguments_hash: argumentsHash,
      presentation_hash: presHash,
      created_at: createdAt,
      expires_at: expiresAt,
    };
    const digest = authorizationDigest(intent);

    this.store.createPendingApprovalAtomic({
      // createdAt override keeps the persisted row byte-identical to the intent.

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
        createdAt,
        bindingVersion: APPROVAL_BINDING_VERSION,
        mode: ctx.mode,
        toolVersion: definition.version,
        toolDefinitionHash: definitionHash,
        presentationJson,
        presentationHash: presHash,
        authorizationDigest: digest,
        signingKeyId: this.signer.keyId,
      },
    });
    this.metrics.counter("arthur.approval.created", 1);

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
