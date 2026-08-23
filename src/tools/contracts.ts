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
}

/**
 * Execution context handed to a tool executor. `approvalToken` is present only
 * when an `approval_required` action is being executed with explicit approval.
 */
export interface ToolExecutionContext {
  session_id: string;
  turn_id: string;
  trace_id: string;
  mode: ArthurMode;
  approved: boolean;
  approvalToken?: ApprovalToken;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
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
