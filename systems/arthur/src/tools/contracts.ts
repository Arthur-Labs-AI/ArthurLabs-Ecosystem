/**
 * Tool system contracts (spec sections 10, 11, 12).
 */

import type { ArthurMode } from "../core/modes/mode";

export type ToolRisk = "read" | "low_write" | "approval_required" | "high_risk";

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  risk: ToolRisk;
  allowed_modes: ArthurMode[];
  /**
   * SC-03 execution policy: trusted registry metadata, never model/user
   * input. When omitted the risk-derived default applies (read ->
   * side-effect-free retryable; anything else -> mutation, no retry).
   * Part of the definition fingerprint (SC-03 section 114).
   */
  execution_policy?: import("./execution_policy").ToolExecutionPolicy;
}

/**
 * Execution context handed to a tool executor (SC-02 section 34).
 *
 * `approved` is a deprecated compat flag with NO authorization power: authority
 * comes exclusively from `authorization` (a centrally verified approval
 * capability). New code must read `authorization`; `approved`/`approvalToken`
 * remain only so existing executors/tests keep compiling during migration.
 */
export interface ToolExecutionContext {
  session_id: string;
  turn_id: string;
  trace_id: string;
  mode: ArthurMode;
  /** Deprecated: informational only, never authority (SC-02 section 34). */
  approved: boolean;
  /** Deprecated: superseded by `authorization` (SC-02 section 26). */
  approvalToken?: ApprovalToken;
  /** Centrally verified approval authority; required for approval tools. */
  authorization?: import("./approval_signer").VerifiedApproval;
  /** SC-03 v2 executor fields: stable operation identity + attempt scope. */
  execution_id?: string;
  attempt_id?: string;
  attempt_no?: number;
  /** Absolute attempt deadline (ISO); the composed AbortSignal enforces it. */
  deadline_at?: string;
  /** Composed signal: user cancellation + attempt timeout + overall deadline. */
  signal?: AbortSignal;
  /**
   * SC-06 §15-18/§92 loop protocol metadata (informational only, never
   * authority): provider correlation id + round/sequence. When present the
   * orchestrator persists them onto the durable tool-call row.
   */
  provider_call_id?: string;
  round_no?: number;
  sequence_no?: number;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export interface ToolAttemptContext {
  execution_id: string;
  attempt_id: string;
  attempt_no: number;
  deadline_at: string;
  signal: AbortSignal;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  attempt?: ToolAttemptContext,
) => Promise<ToolResult> | ToolResult;

// ---- Permission/approval -------------------------------------------------

export interface ApprovalToken {
  approval_id: string;
  tool_name: string;
  session_id: string;
  turn_id: string;
  arguments_hash: string;
  issued_at: string;
  expires_at: string;
  /**
   * HMAC signature over the binding fields above, keyed by the app-level
   * approval signing secret. The harness adapter refuses any token whose
   * signature does not verify, so a hand-crafted approved:true object can
   * never authorize an action (audit MEDIUM 7 / BLOCKER 2).
   */
  signature: string;
}

export type PermissionDecision = "auto" | "approval" | "reject";

// ---- Harness boundary (spec section 11) ----------------------------------

export interface HarnessStatus {
  status: "online" | "offline" | "degraded";
  version: string;
  jobs_active: number;
}

export interface HarnessJobSpec {
  kind: string;
  payload?: Record<string, unknown>;
}

export interface HarnessJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  spec: HarnessJobSpec;
}

export interface HarnessAdapter {
  getStatus(): Promise<HarnessStatus>;
  /**
   * Must treat approval.approval_id as a durable idempotency key. Repeating the
   * same authorized operation after an uncertain transport outcome must return
   * the same external job rather than create another one.
   */
  createJob(spec: HarnessJobSpec, approval: ApprovalToken): Promise<HarnessJob>;
  getJob(jobId: string): Promise<HarnessJob>;
  cancelJob(jobId: string, approval: ApprovalToken): Promise<void>;
}
