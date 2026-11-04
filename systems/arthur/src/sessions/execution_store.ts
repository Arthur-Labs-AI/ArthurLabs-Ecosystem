/**
 * Durable execution persistence (SC-03 sections 15-17, 64-69, 91-96).
 *
 * Tables tool_executions + tool_execution_attempts live in arthur.db so that
 * approval consumption, tool call state, and execution creation share ONE
 * SQLite transaction. Every state transition uses conditional SQL (CAS):
 * the UPDATE carries the expected source state(s) in its WHERE clause and the
 * caller requires changes === 1. Invalid transitions are rejected by the
 * database, not by read-then-write application logic.
 */

import type { DatabaseSync } from "node:sqlite";

import type { SecretSanitizer } from "../security/sanitize";
import type {
  AttemptRecordStatus,
  ExecutionRecordStatus,
  ToolExecutionAttemptRow,
  ToolExecutionRow,
} from "./models";

export const TOOL_EXECUTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS tool_executions (
    id TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL UNIQUE,
    approval_id TEXT UNIQUE,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    tool_definition_hash TEXT NOT NULL,
    arguments_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ready'
      CHECK(state IN ('ready','running','retry_wait','cancel_requested','reconciling','succeeded','failed','cancelled','timed_out','outcome_unknown')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 1 CHECK(max_attempts >= 1),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    deadline_at TEXT NOT NULL,
    next_attempt_at TEXT,
    cancel_requested_at TEXT,
    result_summary TEXT,
    last_error_code TEXT,
    last_error_summary TEXT,
    runtime_instance_id TEXT,
    reconciliation_required INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_required IN (0, 1)),
    result_data_json TEXT,
    FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_tool_call ON tool_executions(tool_call_id);
  CREATE INDEX IF NOT EXISTS idx_executions_state ON tool_executions(state);
  CREATE TABLE IF NOT EXISTS tool_execution_attempts (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
    runtime_instance_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    state TEXT NOT NULL DEFAULT 'running'
      CHECK(state IN ('running','succeeded','failed','cancelled','timed_out','outcome_unknown')),
    failure_kind TEXT,
    effect_outcome TEXT,
    error_code TEXT,
    error_summary TEXT,
    FOREIGN KEY (execution_id) REFERENCES tool_executions(id) ON DELETE CASCADE,
    UNIQUE (execution_id, attempt_no)
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_execution ON tool_execution_attempts(execution_id, attempt_no);
`;

export interface CreateExecutionInput {
  id: string;
  toolCallId: string;
  approvalId?: string | null;
  sessionId: string;
  turnId: string;
  mode: string;
  toolName: string;
  toolVersion: string;
  toolDefinitionHash: string;
  argumentsHash: string;
  maxAttempts: number;
  createdAt: string;
  deadlineAt: string;
}

export interface ClaimAttemptInput {
  executionId: string;
  attemptId: string;
  attemptNo: number;
  runtimeInstanceId: string;
  startedAt: string;
}

function rowToExecution(row: ToolExecutionRow): ToolExecutionRow {
  return { ...row };
}

/** Execution persistence bound to an existing DatabaseSync handle. */
export class ExecutionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sanitizer: SecretSanitizer,
  ) {}

  getExecution(id: string): ToolExecutionRow | undefined {
    return this.db.prepare("SELECT * FROM tool_executions WHERE id = ?").get(id) as unknown as
      | ToolExecutionRow
      | undefined;
  }

  getExecutionByToolCall(toolCallId: string): ToolExecutionRow | undefined {
    return this.db.prepare("SELECT * FROM tool_executions WHERE tool_call_id = ?").get(toolCallId) as unknown as
      | ToolExecutionRow
      | undefined;
  }

  getExecutionByApproval(approvalId: string): ToolExecutionRow | undefined {
    return this.db.prepare("SELECT * FROM tool_executions WHERE approval_id = ?").get(approvalId) as unknown as
      | ToolExecutionRow
      | undefined;
  }

  /**
   * SC-03 section 13 atomic single-use consumption: in ONE caller-owned
   * transaction, consume the gate-winner approval (EXECUTING -> APPROVED +
   * consumed_at) and insert the bound READY execution. The caller must have
   * won the claimApprovalBound contention gate first; this CAS additionally
   * requires the executing row (exactly one winner can hold it) and the
   * UNIQUE(approval_id) binding enforces at-most-one execution at the DB
   * level. Returns null when the approval is not in the gate-won state so
   * callers fail closed without throwing.
   *
   * SC-02 section 40 freshness (NOT weakened by the SC-03 race fix): the
   * consume CAS also requires expires_at > now. An approval that expired
   * before consumption can never bind an execution; the winner's own dispatch
   * then runs under the same validity window (see claimAttemptWithFreshness).
   * Wall-clock skew between concurrent winners cannot starve anyone HERE:
   * every contender evaluates the same persisted expires_at in its own
   * transaction, and exactly one CAS can win regardless of clock skew.
   */
  consumeExecutingApprovalAndCreateExecution(input: {
    approvalId: string;
    toolCallId: string;
    executionId: string;
    sessionId: string;
    turnId: string;
    mode: string;
    toolName: string;
    toolVersion: string;
    toolDefinitionHash: string;
    argumentsHash: string;
    maxAttempts: number;
    createdAt: string;
    consumedAt: string;
    deadlineAt: string;
  }): ToolExecutionRow | null {
    const consumed = this.db
      .prepare(
        `UPDATE approvals SET status = 'approved', consumed_at = ?
         WHERE id = ? AND tool_call_id = ? AND status = 'executing' AND consumed_at IS NULL
         AND expires_at > ?`,
      )
      .run(input.consumedAt, input.approvalId, input.toolCallId, input.consumedAt);
    if (Number(consumed.changes) !== 1) return null;
    try {
      this.db
        .prepare(
          `INSERT INTO tool_executions
           (id, tool_call_id, approval_id, session_id, turn_id, mode, tool_name, tool_version,
            tool_definition_hash, arguments_hash, state, attempt_count, max_attempts,
            created_at, deadline_at, reconciliation_required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?, 0)`,
        )
        .run(
          input.executionId,
          input.toolCallId,
          input.approvalId,
          input.sessionId,
          input.turnId,
          input.mode,
          input.toolName,
          input.toolVersion,
          input.toolDefinitionHash,
          input.argumentsHash,
          input.maxAttempts,
          input.createdAt,
          input.deadlineAt,
        );
    } catch {
      return null;
    }
    const row = this.getExecution(input.executionId);
    if (!row) return null;
    return rowToExecution(row);
  }

  listAttempts(executionId: string): ToolExecutionAttemptRow[] {
    return this.db
      .prepare("SELECT * FROM tool_execution_attempts WHERE execution_id = ? ORDER BY attempt_no ASC")
      .all(executionId) as unknown as ToolExecutionAttemptRow[];
  }

  getAttempt(attemptId: string): ToolExecutionAttemptRow | undefined {
    return this.db.prepare("SELECT * FROM tool_execution_attempts WHERE id = ?").get(attemptId) as unknown as
      | ToolExecutionAttemptRow
      | undefined;
  }

  listNonTerminalExecutions(limit = 500): ToolExecutionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM tool_executions WHERE state NOT IN ('succeeded','failed','cancelled','timed_out') ORDER BY created_at ASC LIMIT ?",
      )
      .all(limit) as unknown as ToolExecutionRow[];
  }

  /** Insert a READY execution. Caller owns the surrounding transaction. */
  insertReadyExecution(input: CreateExecutionInput): ToolExecutionRow {
    this.db
      .prepare(
        `INSERT INTO tool_executions
         (id, tool_call_id, approval_id, session_id, turn_id, mode, tool_name, tool_version,
          tool_definition_hash, arguments_hash, state, attempt_count, max_attempts,
          created_at, deadline_at, reconciliation_required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?, 0)`,
      )
      .run(
        input.id,
        input.toolCallId,
        input.approvalId ?? null,
        input.sessionId,
        input.turnId,
        input.mode,
        input.toolName,
        input.toolVersion,
        input.toolDefinitionHash,
        input.argumentsHash,
        input.maxAttempts,
        input.createdAt,
        input.deadlineAt,
      );
    const row = this.getExecution(input.id);
    if (!row) throw new Error("execution insert failed");
    return rowToExecution(row);
  }

  /**
   * Critical atomic boundary (SC-03 section 65): READY/RETRY_WAIT -> RUNNING,
   * create the attempt row, increment attempt_count, record runtime identity.
   * Returns false when the CAS precondition fails (duplicate retry race loses).
   *
   * SC-02 section 32 freshness (final-gate invariant): for approval-bound
   * executions the SAME conditional UPDATE additionally requires the bound
   * approval to be consumed-and-fresh (APPROVED + consumed_at + expires_at >
   * now) at claim time. An expired authorization can therefore never reach
   * dispatch: the claim CAS fails and no attempt row is created. AUTO
   * executions (approval_id IS NULL) skip the approval leg. All contenders
   * evaluate the same persisted expires_at, so clock skew cannot elect two
   * winners — exactly one conditional UPDATE can match.
   */
  claimAttempt(input: ClaimAttemptInput): boolean {
    const exec = this.getExecution(input.executionId);
    if (!exec) return false;
    const expectedNo = exec.attempt_count + 1;
    if (input.attemptNo !== expectedNo) return false;
    const now = input.startedAt;
    const updated = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'running', attempt_count = ?, started_at = COALESCE(started_at, ?),
           runtime_instance_id = ?, next_attempt_at = NULL
         WHERE id = ? AND state IN ('ready','retry_wait') AND attempt_count = ?
         AND (approval_id IS NULL OR EXISTS (
           SELECT 1 FROM approvals a
           WHERE a.id = tool_executions.approval_id
             AND a.status = 'approved' AND a.consumed_at IS NOT NULL AND a.expires_at > ?
         ))`,
      )
      .run(input.attemptNo, now, input.runtimeInstanceId, input.executionId, exec.attempt_count, now);
    if (Number(updated.changes) !== 1) return false;
    try {
      this.db
        .prepare(
          `INSERT INTO tool_execution_attempts
           (id, execution_id, attempt_no, runtime_instance_id, started_at, state)
           VALUES (?, ?, ?, ?, ?, 'running')`,
        )
        .run(input.attemptId, input.executionId, input.attemptNo, input.runtimeInstanceId, now);
    } catch {
      return false;
    }
    return true;
  }

  /**
   * SC-03 section 79 bounded structured result data: validated (output_schema
   * checked at the service boundary), JSON-safe snapshot, sanitized, and
   * size-bounded (4 KiB). Oversized data persists NULL rather than corrupting
   * state; summary_only tools always persist NULL.
   */
  static boundResultData(data: unknown, sanitizer: SecretSanitizer, maxChars = 4096): string | null {
    if (data === undefined) return null;
    let json: string;
    try {
      json = JSON.stringify(sanitizer.sanitizeValue(data));
    } catch {
      return null;
    }
    if (typeof json !== "string" || json.length > maxChars) return null;
    return json;
  }

  /** Terminal commit (SC-03 66): attempt + execution + tool call in one unit. */
  completeSucceeded(executionId: string, attemptId: string, summary: string, finishedAt: string, resultData?: unknown): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    // Attempt CAS verifies ownership (id + execution_id + running): a commit
    // can never terminalize another execution's attempt row.
    const attempt = this.db
      .prepare("UPDATE tool_execution_attempts SET state = 'succeeded', finished_at = ? WHERE id = ? AND execution_id = ? AND state = 'running'")
      .run(finishedAt, attemptId, executionId);
    if (Number(attempt.changes) !== 1) return false;
    const capped = this.sanitizer.capSummary(summary);
    const bounded = ExecutionStore.boundResultData(resultData, this.sanitizer);
    const updated = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'succeeded', finished_at = ?, result_summary = ?,
           last_error_code = NULL, last_error_summary = NULL, reconciliation_required = 0,
           result_data_json = COALESCE(?, result_data_json)
         WHERE id = ? AND state IN ('running','cancel_requested','reconciling')`,
      )
      .run(finishedAt, capped, bounded, executionId);
    if (Number(updated.changes) !== 1) return false;
    this.db
      .prepare("UPDATE tool_calls SET status = 'completed', result_summary = ?, updated_at = ? WHERE id = ?")
      .run(capped, finishedAt, exec.tool_call_id);
    return true;
  }

  completeFailed(
    executionId: string,
    attemptId: string,
    code: string,
    summary: string,
    finishedAt: string,
    exhausted: boolean,
  ): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    const attempt = this.db
      .prepare(
        "UPDATE tool_execution_attempts SET state = 'failed', finished_at = ?, error_code = ?, error_summary = ? WHERE id = ? AND execution_id = ? AND state = 'running'",
      )
      .run(finishedAt, code, this.sanitizer.capSummary(summary), attemptId, executionId);
    if (Number(attempt.changes) !== 1) return false;
    const capped = this.sanitizer.capSummary(summary);
    if (exhausted) {
      const updated = this.db
        .prepare(
          `UPDATE tool_executions SET state = 'failed', finished_at = ?, last_error_code = ?, last_error_summary = ?,
             reconciliation_required = 0
           WHERE id = ? AND state IN ('running','cancel_requested','reconciling')`,
        )
        .run(finishedAt, code, capped, executionId);
      if (Number(updated.changes) !== 1) return false;
      this.db
        .prepare("UPDATE tool_calls SET status = 'failed', result_summary = ?, updated_at = ? WHERE id = ?")
        .run(capped, finishedAt, exec.tool_call_id);
      return true;
    }
    return true;
  }

  /** Retry commit (SC-03 67): attempt FAILED, execution RETRY_WAIT with backoff. */
  moveToRetryWait(
    executionId: string,
    nextAttemptAt: string,
    code: string,
    summary: string,
    failureKind?: string | null,
    effectOutcome?: string | null,
  ): boolean {
    const attempt = this.db
      .prepare(
        `UPDATE tool_execution_attempts SET state = 'failed', finished_at = ?,
           error_code = ?, error_summary = ?, failure_kind = ?, effect_outcome = ?
         WHERE execution_id = ? AND state = 'running'`,
      )
      .run(
        nextAttemptAt,
        code,
        this.sanitizer.capSummary(summary),
        failureKind ?? null,
        effectOutcome ?? null,
        executionId,
      );
    if (Number(attempt.changes) !== 1) return false;
    const updated = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'retry_wait', next_attempt_at = ?,
           last_error_code = ?, last_error_summary = ?
         WHERE id = ? AND state IN ('running','cancel_requested')`,
      )
      .run(nextAttemptAt, code, this.sanitizer.capSummary(summary), executionId);
    return Number(updated.changes) === 1;
  }

  /** Unknown-outcome commit (SC-03 68): quarantine, no retry timer. */
  moveToOutcomeUnknown(
    executionId: string,
    code: string,
    summary: string,
    finishedAt: string,
    failureKind?: string | null,
    effectOutcome?: string | null,
  ): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    this.db
      .prepare(
        `UPDATE tool_execution_attempts SET state = 'outcome_unknown', finished_at = ?,
           error_code = ?, error_summary = ?, failure_kind = ?, effect_outcome = ?
         WHERE execution_id = ? AND state = 'running'`,
      )
      .run(finishedAt, code, this.sanitizer.capSummary(summary), failureKind ?? null, effectOutcome ?? null, executionId);
    const updated = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'outcome_unknown', finished_at = ?,
           last_error_code = ?, last_error_summary = ?, reconciliation_required = 1
         WHERE id = ? AND state IN ('running','cancel_requested','reconciling')`,
      )
      .run(finishedAt, code, this.sanitizer.capSummary(summary), executionId);
    if (Number(updated.changes) !== 1) return false;
    this.db
      .prepare("UPDATE tool_calls SET status = 'outcome_unknown', result_summary = ?, updated_at = ? WHERE id = ?")
      .run(this.sanitizer.capSummary(summary), finishedAt, exec.tool_call_id);
    return true;
  }

  moveToTimedOut(executionId: string, code: string, summary: string, finishedAt: string): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    this.db
      .prepare("UPDATE tool_execution_attempts SET state = 'timed_out', finished_at = ?, error_code = ?, error_summary = ? WHERE execution_id = ? AND state = 'running'")
      .run(finishedAt, code, this.sanitizer.capSummary(summary), executionId);
    const updated = this.db
      .prepare(
        "UPDATE tool_executions SET state = 'timed_out', finished_at = ?, last_error_code = ?, last_error_summary = ? WHERE id = ? AND state IN ('ready','retry_wait','running','cancel_requested')",
      )
      .run(finishedAt, code, this.sanitizer.capSummary(summary), executionId);
    if (Number(updated.changes) !== 1) return false;
    this.db
      .prepare("UPDATE tool_calls SET status = 'timed_out', result_summary = ?, updated_at = ? WHERE id = ?")
      .run(this.sanitizer.capSummary(summary), finishedAt, exec.tool_call_id);
    return true;
  }

  /**
   * SC-03 section 104 retry exhaustion for known-not-applied outcomes:
   * execution -> FAILED + TOOL_RETRY_EXHAUSTED + tool_call failed, in one
   * caller-owned transaction. No attempt row is touched (the last attempt
   * already carries its own terminal state); no retry timer is created.
   */
  moveToFailedExhausted(executionId: string, code: string, summary: string, finishedAt: string): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    const capped = this.sanitizer.capSummary(summary);
    const updated = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'failed', finished_at = ?, last_error_code = ?, last_error_summary = ?,
           reconciliation_required = 0
         WHERE id = ? AND state IN ('ready','retry_wait','running','cancel_requested','reconciling')`,
      )
      .run(finishedAt, code, capped, executionId);
    if (Number(updated.changes) !== 1) return false;
    this.db
      .prepare("UPDATE tool_calls SET status = 'failed', result_summary = ?, updated_at = ? WHERE id = ?")
      .run(capped, finishedAt, exec.tool_call_id);
    return true;
  }

  moveToCancelled(executionId: string, summary: string, finishedAt: string): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    this.db
      .prepare("UPDATE tool_execution_attempts SET state = 'cancelled', finished_at = ?, error_summary = ? WHERE execution_id = ? AND state = 'running'")
      .run(finishedAt, this.sanitizer.capSummary(summary), executionId);
    // Pre-start cancel: READY/RETRY_WAIT -> CANCELLED with zero executor calls.
    const updated = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'cancelled', finished_at = ?,
           cancel_requested_at = COALESCE(cancel_requested_at, ?), result_summary = ?
         WHERE id = ? AND state IN ('ready','retry_wait','running','cancel_requested')`,
      )
      .run(finishedAt, finishedAt, this.sanitizer.capSummary(summary), executionId);
    if (Number(updated.changes) !== 1) return false;
    this.db
      .prepare("UPDATE tool_calls SET status = 'cancelled', result_summary = ?, updated_at = ? WHERE id = ?")
      .run(this.sanitizer.capSummary(summary), finishedAt, exec.tool_call_id);
    return true;
  }

  /** Cancellation persistence first (SC-03 69): RUNNING -> CANCEL_REQUESTED in DB. */
  requestCancel(executionId: string, requestedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE tool_executions SET state = 'cancel_requested', cancel_requested_at = ? WHERE id = ? AND state = 'running'")
      .run(requestedAt, executionId);
    return Number(result.changes) === 1;
  }

  moveToReconciling(executionId: string): boolean {
    const result = this.db
      .prepare("UPDATE tool_executions SET state = 'reconciling' WHERE id = ? AND state = 'outcome_unknown'")
      .run(executionId);
    return Number(result.changes) === 1;
  }

  /** Terminal reconcile commit: reconciling -> terminal + tool call mirror. */
  reconcileTerminal(
    executionId: string,
    state: ExecutionRecordStatus,
    toolCallStatus: "completed" | "failed" | "cancelled" | "outcome_unknown",
    summary: string,
    finishedAt: string,
  ): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    const capped = this.sanitizer.capSummary(summary);
    const updated = this.db
      .prepare(
        "UPDATE tool_executions SET state = ?, finished_at = ?, result_summary = ?, reconciliation_required = 0 WHERE id = ? AND state = 'reconciling'",
      )
      .run(state, finishedAt, capped, executionId);
    if (Number(updated.changes) !== 1) return false;
    this.db
      .prepare("UPDATE tool_calls SET status = ?, result_summary = ?, updated_at = ? WHERE id = ?")
      .run(toolCallStatus, capped, finishedAt, exec.tool_call_id);
    return true;
  }

  /**
   * Recovery helpers: execution-level transitions that do not depend on a
   * running attempt row (the orphan attempt was already terminalized by the
   * recovery scan). Used only by startup recovery for side-effect-free stale
   * RUNNING executions.
   */
  recoverToRetryWait(executionId: string, nextAttemptAt: string, code: string, summary: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'retry_wait', next_attempt_at = ?,
           last_error_code = ?, last_error_summary = ?
         WHERE id = ? AND state IN ('running','cancel_requested')`,
      )
      .run(nextAttemptAt, code, this.sanitizer.capSummary(summary), executionId);
    return Number(result.changes) === 1;
  }

  recoverToFailed(executionId: string, code: string, summary: string, finishedAt: string): boolean {
    const exec = this.getExecution(executionId);
    if (!exec) return false;
    const capped = this.sanitizer.capSummary(summary);
    const result = this.db
      .prepare(
        `UPDATE tool_executions SET state = 'failed', finished_at = ?,
           last_error_code = ?, last_error_summary = ?, reconciliation_required = 0
         WHERE id = ? AND state IN ('running','cancel_requested','reconciling')`,
      )
      .run(finishedAt, code, capped, executionId);
    if (Number(result.changes) !== 1) return false;
    this.db
      .prepare("UPDATE tool_calls SET status = 'failed', result_summary = ?, updated_at = ? WHERE id = ?")
      .run(capped, finishedAt, exec.tool_call_id);
    return true;
  }

  /** CAS helper for tests: attempt a raw state write with expected-source guard. */
  casExecutionState(id: string, from: ExecutionRecordStatus[], to: ExecutionRecordStatus): boolean {
    const placeholders = from.map(() => "?").join(",");
    const result = this.db
      .prepare(`UPDATE tool_executions SET state = ? WHERE id = ? AND state IN (${placeholders})`)
      .run(to, id, ...from);
    return Number(result.changes) === 1;
  }

  updateAttemptOutcome(
    attemptId: string,
    patch: { state: AttemptRecordStatus; code?: string; summary?: string; kind?: string; effect?: string; finishedAt?: string },
  ): void {
    this.db
      .prepare(
        "UPDATE tool_execution_attempts SET state = ?, finished_at = COALESCE(?, finished_at), error_code = COALESCE(?, error_code), error_summary = COALESCE(?, error_summary), failure_kind = COALESCE(?, failure_kind), effect_outcome = COALESCE(?, effect_outcome) WHERE id = ?",
      )
      .run(
        patch.state,
        patch.finishedAt ?? null,
        patch.code ?? null,
        patch.summary === undefined ? null : this.sanitizer.capSummary(patch.summary),
        patch.kind ?? null,
        patch.effect ?? null,
        attemptId,
      );
  }
}
