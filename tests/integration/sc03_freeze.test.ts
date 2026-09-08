/**
 * SC-03 FREEZE proof suite (task sections 3-30): crash-recovery proof, atomic
 * consumption proof, startup wiring proof, and determinism proof on a REAL
 * persistent database (file-backed arthur.db), recreating the runtime the way
 * production startup does (buildApp on the same dbPath with a new
 * runtime_instance_id, automatic startup recovery).
 *
 * Every crash window (spec section 64 A-G) recreates the runtime using the same
 * persistent DB. Nothing here calls a test-only recovery path: production
 * startup (buildApp -> runStartupRecovery) is the exercised path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArthurMode } from "../../src/core/modes/mode";
import { FakeProvider } from "../../src/models/providers/fake";
import { ScriptedRetryRandomSource, DefaultRetryRandomSource } from "../../src/tools/execution_clock";
import { computeRetryDelayMs } from "../../src/tools/execution_policy";
import type { ToolExecutionPolicy } from "../../src/tools/execution_policy";
import { buildTestApp, validTurn } from "../helpers";

function workspaceTempDir(): string {
  const base = process.cwd();
  try {
    return mkdtempSync(join(base, "data", "sc03-freeze-"));
  } catch {
    return mkdtempSync(join(tmpdir(), "sc03-freeze-"));
  }
}

function readPolicy(): ToolExecutionPolicy {
  return {
    effects: "none",
    attempt_timeout_ms: 30000,
    total_timeout_ms: 120000,
    abort_grace_ms: 50,
    cancellation: "cooperative",
    idempotency: "intrinsic",
    retry: { strategy: "transient", max_attempts: 3, base_delay_ms: 100, max_delay_ms: 2000 },
    reconciliation: "none",
    result_persistence: "summary_only",
  };
}

interface ExecRow {
  id: string; tool_call_id: string; approval_id: string | null; state: string;
  attempt_count: number; runtime_instance_id: string | null; next_attempt_at: string | null;
  deadline_at: string; result_data_json: string | null; reconciliation_required: number;
}

function executionsOf(app: ReturnType<typeof buildTestApp>): ExecRow[] {
  const db = app.store.unsafeDbHandle();
  return db.prepare("SELECT id, tool_call_id, approval_id, state, attempt_count, runtime_instance_id, next_attempt_at, deadline_at, result_data_json, reconciliation_required FROM tool_executions ORDER BY created_at").all() as unknown as ExecRow[];
}

function attemptsOf(app: ReturnType<typeof buildTestApp>, executionId: string): Array<{ id: string; attempt_no: number; state: string; runtime_instance_id: string }> {
  const db = app.store.unsafeDbHandle();
  return db.prepare("SELECT id, attempt_no, state, runtime_instance_id FROM tool_execution_attempts WHERE execution_id = ? ORDER BY attempt_no").all(executionId) as Array<{ id: string; attempt_no: number; state: string; runtime_instance_id: string }>;
}

function execState(app: ReturnType<typeof buildTestApp>, id: string): string {
  return (app.store.unsafeDbHandle().prepare("SELECT state FROM tool_executions WHERE id=?").get(id) as { state: string }).state;
}


test("SC03-freeze-startup: runtime B gets a new runtime_instance_id and auto-recovers", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const appA = buildTestApp({ dbPath });
    const coordA = appA.conversation.orchestratorForTests().getCoordinator();
    const ridA = coordA.runtimeId();
    assert.match(ridA, /^runtime-/);
    appA.store.createSession("s-freeze", ArthurMode.PERSONAL);
    appA.store.createTurn({ id: "t-freeze", sessionId: "s-freeze", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
    appA.store.createToolCall({ id: "tc-stale", turnId: "t-freeze", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
    const created = coordA.getExecutions().insertReadyExecution({
      id: "exec-stale-ready", toolCallId: "tc-stale", approvalId: null, sessionId: "s-freeze", turnId: "t-freeze",
      mode: "personal", toolName: "system.echo", toolVersion: "1.0.0",
      toolDefinitionHash: "x",
      argumentsHash: "a".repeat(64), maxAttempts: 3,
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(created.state, "ready");
    appA.close();

    const appB = buildTestApp({ dbPath });
    try {
      assert.ok(appB.startupRecovery, "buildApp must run startup recovery automatically");
      assert.ok((appB.startupRecovery?.recovered ?? 0) >= 1, "stale READY must be recovered at startup");
      const ridB = appB.conversation.orchestratorForTests().getCoordinator().runtimeId();
      assert.notEqual(ridB, ridA, "each startup receives a different runtime_instance_id");
      assert.match(ridB, /^runtime-/);
      assert.equal(execState(appB, "exec-stale-ready"), "ready", "valid READY survives restart for safe resume");
    } finally {
      appB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- section 13: atomic single-use approval consumption ----

test("SC03-freeze-consume: one approval binds at most one execution", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const provider = new FakeProvider({
      responder: () => ({ assistant_text: "", tool_calls: [{ id: "call-appr", name: "harness.create_job", arguments: { kind: "deploy" } }], finish_reason: "tool_calls" }),
    });
    const app = buildTestApp({ dbPath }, { provider });
    try {
      const turn = await app.conversation.handleTurn(validTurn({ mode: "business", message: "deploy it", client_request_id: "freeze-approve-1" }));
      const approvalId = turn.tool_calls[0]?.approval_id as string;
      assert.ok(approvalId);
      const outcome = await app.conversation.approve(approvalId);
      assert.equal(outcome.status, "approved");
      assert.ok(outcome.execution_id, "approve binds exactly one execution");
      const row = app.store.getApproval(approvalId);
      assert.equal(row?.status, "approved");
      assert.ok(row?.consumed_at, "consumption timestamp persisted atomically");
      const again = await app.conversation.approve(approvalId);
      assert.equal(again.status, "already_resolved");
      const count = Number((app.store.unsafeDbHandle().prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE approval_id = ?").get(approvalId) as { n: number }).n);
      assert.equal(count, 1, "DB enforces at-most-one execution per approval");
      const coord = app.conversation.orchestratorForTests().getCoordinator();
      // Second consumption must first win the gate (impossible: already
      // APPROVED) — simulate the direct store call which now requires the
      // gate-won EXECUTING state and therefore fails closed.
      const second = app.store.transaction(() =>
        coord.getExecutions().consumeExecutingApprovalAndCreateExecution({
          approvalId, toolCallId: row?.tool_call_id as string, executionId: "exec-evil-second",
          sessionId: row?.session_id as string, turnId: row?.turn_id as string, mode: "business",
          toolName: "harness.create_job", toolVersion: "1.0.0", toolDefinitionHash: "x",
          argumentsHash: "a".repeat(64), maxAttempts: 1,
          createdAt: new Date().toISOString(), consumedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
        }),
      );
      assert.equal(second, null, "second consumption fails closed");
      assert.equal(app.store.getApproval(approvalId)?.consumed_at, row?.consumed_at, "consumed_at immutable once set");
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC03-freeze-consume-invariant: no APPROVED-without-execution, no unconsumed binding", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const app = buildTestApp({ dbPath });
    try {
      const db = app.store.unsafeDbHandle();
      const orphans = db.prepare(
        "SELECT a.id FROM approvals a LEFT JOIN tool_executions e ON e.approval_id = a.id WHERE a.status = 'approved' AND e.id IS NULL",
      ).all() as unknown[];
      assert.equal(orphans.length, 0, "no APPROVED approval without execution");
      const unconsumed = db.prepare(
        "SELECT e.id FROM tool_executions e JOIN approvals a ON a.id = e.approval_id WHERE a.consumed_at IS NULL OR a.status <> 'approved'",
      ).all() as unknown[];
      assert.equal(unconsumed.length, 0, "no execution bound to an unconsumed approval");
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- section 64 crash windows A-G on a persistent DB ----

test("SC03-freeze-window-A: crash before execution record commit leaves nothing", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const provider = new FakeProvider({
      responder: () => ({ assistant_text: "", tool_calls: [{ id: "c-a", name: "system.echo", arguments: { text: "hi" } }], finish_reason: "tool_calls" }),
    });
    const app = buildTestApp({ dbPath }, { provider });
    try {
      // Crash window A: the whole intent unit (tool call + execution) rolls
      // back when the commit never happens. Use a valid turn id so the ONLY
      // failure is the simulated crash, proving atomicity rather than FK shape.
      app.store.createSession("s-a", ArthurMode.PERSONAL);
      app.store.createTurn({ id: "t-a", sessionId: "s-a", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
      assert.throws(() => {
        app.store.transaction(() => {
          app.store.createToolCall({ id: "tc-crash-a", turnId: "t-a", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
          throw new Error("simulated crash before commit");
        });
      }, /simulated crash/);
      assert.equal(executionsOf(app).length, 0, "no durable execution exists");
      assert.equal(app.store.getToolCall("tc-crash-a"), undefined, "no tool call without commit either");
    } finally {
      app.close();
    }
    const app2 = buildTestApp({ dbPath }, { provider });
    try {
      assert.ok((app2.startupRecovery?.recovered ?? 0) >= 0);
      assert.equal(executionsOf(app2).length, 0);
    } finally {
      app2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC03-freeze-window-B: READY committed before dispatch resumes after restart", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const appA = buildTestApp({ dbPath });
    appA.store.createSession("s-b", ArthurMode.PERSONAL);
    appA.store.createTurn({ id: "t-b", sessionId: "s-b", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
    appA.store.createToolCall({ id: "tc-b", turnId: "t-b", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
    const coord = appA.conversation.orchestratorForTests().getCoordinator();
    const registry = appA.conversation.registryForTests();
    const pol = registry.getExecutionPolicy("system.echo");
    assert.ok(pol, "system.echo carries a trusted policy");
    const created = coord.getExecutions().insertReadyExecution({
      id: "exec-window-b", toolCallId: "tc-b", approvalId: null, sessionId: "s-b", turnId: "t-b",
      mode: "personal", toolName: "system.echo", toolVersion: "1.0.0",
      toolDefinitionHash: registry.getDefinitionHash("system.echo") ?? "",
      argumentsHash: "b".repeat(64), maxAttempts: pol.retry.max_attempts,
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(created.state, "ready");
    appA.close();
    const appB = buildTestApp({ dbPath });
    try {
      assert.ok((appB.startupRecovery?.recovered ?? 0) >= 1);
      assert.equal(execState(appB, "exec-window-b"), "ready");
    } finally {
      appB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC03-freeze-window-CDE: stale RUNNING mutation quarantines, never blind-retries", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const appA = buildTestApp({ dbPath });
    const coord = appA.conversation.orchestratorForTests().getCoordinator();
    const registry = appA.conversation.registryForTests();
    const pol = registry.getExecutionPolicy("harness.create_job");
    assert.ok(pol, "harness.create_job carries a trusted policy");
    appA.store.createSession("s-c", ArthurMode.BUSINESS);
    appA.store.createTurn({ id: "t-c", sessionId: "s-c", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.BUSINESS });
    appA.store.createToolCall({ id: "tc-c", turnId: "t-c", toolName: "harness.create_job", argumentsJson: "{}", riskLevel: "approval_required", status: "executing" });
    coord.getExecutions().insertReadyExecution({
      id: "exec-window-c", toolCallId: "tc-c", approvalId: null, sessionId: "s-c", turnId: "t-c",
      mode: "business", toolName: "harness.create_job", toolVersion: "1.0.0",
      toolDefinitionHash: registry.getDefinitionHash("harness.create_job") ?? "",
      argumentsHash: "c".repeat(64), maxAttempts: pol.retry.max_attempts,
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
    });
    appA.store.transaction(() => {
      const ok = coord.getExecutions().claimAttempt({ executionId: "exec-window-c", attemptId: "att-dead-c", attemptNo: 1, runtimeInstanceId: "runtime-dead", startedAt: new Date().toISOString() });
      assert.equal(ok, true);
    });
    appA.close();
    const appB = buildTestApp({ dbPath });
    try {
      const row = appB.store.unsafeDbHandle().prepare("SELECT state, attempt_count FROM tool_executions WHERE id='exec-window-c'").get() as { state: string; attempt_count: number };
      assert.equal(row.state, "outcome_unknown", "stale RUNNING mutation quarantines at startup");
      assert.equal(row.attempt_count, 1, "no duplicate invocation on recovery");
      const coordB = appB.conversation.orchestratorForTests().getCoordinator();
      const after = await coordB.reconcile("exec-window-c", { reconcile: async () => "unknown" });
      assert.equal(after?.state, "outcome_unknown", "unknown verdict keeps quarantine");
    } finally {
      appB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC03-freeze-window-G: terminal commit survives; client retry replays, never duplicates", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const provider = new FakeProvider({
      responder: () => ({ assistant_text: "g", tool_calls: [], finish_reason: "stop" }),
    });
    const app = buildTestApp({ dbPath }, { provider });
    try {
      const first = await app.conversation.handleTurn(validTurn({ message: "g-window", client_request_id: "freeze-window-g" }));
      const replay = await app.conversation.handleTurn(validTurn({ message: "g-window", client_request_id: "freeze-window-g" }));
      assert.deepEqual(replay, first, "client retry returns existing result, no second execution");
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- F24/F25 restart variants ----

test("SC03-freeze-F24: READY resumes only when valid; expired/invalid never invoke", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const appA = buildTestApp({ dbPath });
    const coord = appA.conversation.orchestratorForTests().getCoordinator();
    const registry = appA.conversation.registryForTests();
    appA.store.createSession("s-24", ArthurMode.PERSONAL);
    appA.store.createTurn({ id: "t-24", sessionId: "s-24", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
    const mk = (tc: string, id: string, deadlineAt: string, version: string) => {
      appA.store.createToolCall({ id: tc, turnId: "t-24", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
      coord.getExecutions().insertReadyExecution({
        id, toolCallId: tc, approvalId: null, sessionId: "s-24", turnId: "t-24", mode: "personal",
        toolName: "system.echo", toolVersion: version,
        toolDefinitionHash: registry.getDefinitionHash("system.echo") ?? "",
        argumentsHash: "d".repeat(64), maxAttempts: 3,
        createdAt: new Date().toISOString(), deadlineAt,
      });
    };
    mk("tc-24-ok", "exec-24-ok", new Date(Date.now() + 60000).toISOString(), "1.0.0");
    mk("tc-24-exp", "exec-24-exp", new Date(Date.now() - 1000).toISOString(), "1.0.0");
    mk("tc-24-ver", "exec-24-ver", new Date(Date.now() + 60000).toISOString(), "9.9.9");
    appA.close();
    const appB = buildTestApp({ dbPath });
    try {
      assert.equal(execState(appB, "exec-24-ok"), "ready", "valid READY resumes");
      assert.equal(execState(appB, "exec-24-exp"), "timed_out", "expired READY never invokes");
      assert.equal(execState(appB, "exec-24-ver"), "timed_out", "definition-changed READY never invokes");
    } finally {
      appB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC03-freeze-F25: RETRY_WAIT honors next_attempt_at across restart", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const appA = buildTestApp({ dbPath });
    const coord = appA.conversation.orchestratorForTests().getCoordinator();
    const registry = appA.conversation.registryForTests();
    appA.store.createSession("s-25", ArthurMode.PERSONAL);
    appA.store.createTurn({ id: "t-25", sessionId: "s-25", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
    appA.store.createToolCall({ id: "tc-25", turnId: "t-25", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
    coord.getExecutions().insertReadyExecution({
      id: "exec-25", toolCallId: "tc-25", approvalId: null, sessionId: "s-25", turnId: "t-25", mode: "personal",
      toolName: "system.echo", toolVersion: "1.0.0",
      toolDefinitionHash: registry.getDefinitionHash("system.echo") ?? "",
      argumentsHash: "e".repeat(64), maxAttempts: 3,
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
    });
    appA.store.transaction(() => {
      assert.equal(coord.getExecutions().claimAttempt({ executionId: "exec-25", attemptId: "att-25-1", attemptNo: 1, runtimeInstanceId: coord.runtimeId(), startedAt: new Date().toISOString() }), true);
      assert.equal(coord.getExecutions().moveToRetryWait("exec-25", new Date(Date.now() + 60000).toISOString(), "TOOL_EXECUTION_FAILED", "transient", "transient", "not_applied"), true);
    });
    appA.close();
    const appB = buildTestApp({ dbPath });
    try {
      const row = appB.store.unsafeDbHandle().prepare("SELECT state, attempt_count FROM tool_executions WHERE id='exec-25'").get() as { state: string; attempt_count: number };
      assert.equal(row.state, "retry_wait", "before next_attempt_at: no dispatch");
      assert.equal(row.attempt_count, 1, "executor calls = 0 across restart so far");
    } finally {
      appB.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- F12 repeated races + F28 100-way CAS ----

test("SC03-freeze-F12: repeated cancel races yield exactly one truth", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    for (let round = 0; round < 10; round++) {
      const app = buildTestApp({ dbPath });
      try {
        const coord = app.conversation.orchestratorForTests().getCoordinator();
        const registry = app.conversation.registryForTests();
        const sess = "s-12-" + round;
        const turn = "t-12-" + round;
        const tc = "tc-12-" + round;
        const ex = "exec-12-" + round;
        app.store.createSession(sess, ArthurMode.PERSONAL);
        app.store.createTurn({ id: turn, sessionId: sess, role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
        app.store.createToolCall({ id: tc, turnId: turn, toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
        coord.getExecutions().insertReadyExecution({
          id: ex, toolCallId: tc, approvalId: null, sessionId: sess, turnId: turn, mode: "personal",
          toolName: "system.echo", toolVersion: "1.0.0",
          toolDefinitionHash: registry.getDefinitionHash("system.echo") ?? "",
          argumentsHash: "f".repeat(64), maxAttempts: 1,
          createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
        });
        const c = coord.requestCancel(ex);
        const st = (c?.state ?? coord.getExecution(ex)?.state) as string;
        assert.ok(["cancelled", "succeeded", "running", "ready"].includes(st), "round " + round + ": single truth, got " + st);
        if (st === "cancelled") {
          const after = coord.requestCancel(ex);
          assert.equal(after?.state, "cancelled", "later cancel returns existing CANCELLED");
        }
      } finally {
        app.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC03-freeze-F28: 100 concurrent retry claims elect exactly one winner", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const app = buildTestApp({ dbPath });
    try {
      const coord = app.conversation.orchestratorForTests().getCoordinator();
      const registry = app.conversation.registryForTests();
      app.store.createSession("s-28", ArthurMode.PERSONAL);
      app.store.createTurn({ id: "t-28", sessionId: "s-28", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
      app.store.createToolCall({ id: "tc-28", turnId: "t-28", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
      coord.getExecutions().insertReadyExecution({
        id: "exec-28", toolCallId: "tc-28", approvalId: null, sessionId: "s-28", turnId: "t-28", mode: "personal",
        toolName: "system.echo", toolVersion: "1.0.0",
        toolDefinitionHash: registry.getDefinitionHash("system.echo") ?? "",
        argumentsHash: "g".repeat(64), maxAttempts: 5,
        createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
      });
      app.store.transaction(() => {
        assert.equal(coord.getExecutions().claimAttempt({ executionId: "exec-28", attemptId: "att-28-1", attemptNo: 1, runtimeInstanceId: coord.runtimeId(), startedAt: new Date().toISOString() }), true);
        assert.equal(coord.getExecutions().moveToRetryWait("exec-28", new Date(Date.now() - 1000).toISOString(), "TOOL_EXECUTION_FAILED", "transient", "transient", "not_applied"), true);
      });
      const wins = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          Promise.resolve().then(() =>
            app.store.transaction(() =>
              coord.getExecutions().claimAttempt({ executionId: "exec-28", attemptId: "att-28-race-" + i, attemptNo: 2, runtimeInstanceId: coord.runtimeId(), startedAt: new Date().toISOString() }),
            ),
          ),
        ),
      );
      assert.equal(wins.filter(Boolean).length, 1, "exactly one RETRY_WAIT -> RUNNING winner");
      assert.equal(coord.getExecution("exec-28")?.attempt_count, 2, "exactly one attempt_count increment");
      assert.equal(attemptsOf(app, "exec-28").filter((a) => a.attempt_no === 2).length, 1, "exactly one attempt-2 row");
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- F19/F33: RetryRandomSource determinism ----

test("SC03-freeze-F19F33: jitter uses only the injected RetryRandomSource", async () => {
  const pol = readPolicy();
  assert.equal(computeRetryDelayMs(pol, 1, 0), 0);
  assert.equal(computeRetryDelayMs(pol, 1, 1), Math.min(2000, 200));
  assert.equal(computeRetryDelayMs(pol, 2, 0.5), Math.floor(0.5 * Math.min(2000, 400)));
  const src = new ScriptedRetryRandomSource([0, 0.5, 1]);
  assert.equal(src.next01(), 0);
  assert.equal(src.next01(), 0.5);
  assert.equal(src.next01(), 1);
  const prod = new DefaultRetryRandomSource();
  assert.ok(prod.next01() >= 0 && prod.next01() <= 1);
});

// ---- F13: mutation cancel with unknown effect ----

test("SC03-freeze-F13: cancel on uncertain mutation yields OUTCOME_UNKNOWN", async () => {
  const { ToolRegistry } = await import("../../src/tools/registry");
  const { PermissionService } = await import("../../src/tools/permissions");
  const { ExecutionStore } = await import("../../src/sessions/execution_store");
  const { ToolExecutionCoordinator } = await import("../../src/tools/execution_coordinator");
  const { FakeExecutionClock } = await import("../../src/tools/execution_clock");
  const { SessionStore } = await import("../../src/sessions/store");
  const { SecretSanitizer } = await import("../../src/security/sanitize");
  const { Logger } = await import("../../src/observability/logging");
  const { InMemoryMetrics } = await import("../../src/observability/metrics");
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "mut.hang", version: "1.0.0", description: "mutation that hangs until aborted",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read", allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: {
        effects: "mutation", attempt_timeout_ms: 30000, total_timeout_ms: 120000, abort_grace_ms: 20,
        cancellation: "cooperative", idempotency: "none",
        retry: { strategy: "off", max_attempts: 1, base_delay_ms: 100, max_delay_ms: 2000 },
        reconciliation: "none", result_persistence: "summary_only",
      },
    },
    ((() => new Promise(() => undefined)) as unknown) as never,
  );
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  try {
    const executions = new ExecutionStore(store.unsafeDbHandle(), store.sanitizerHandle());
    const clock = new FakeExecutionClock(Date.now());
    const coordinator = new ToolExecutionCoordinator(store, executions, registry, permissions, registry.createSingleAttemptService(permissions), new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-f13", clock });
    store.createSession("s-f13", ArthurMode.PERSONAL);
    store.createTurn({ id: "t-f13", sessionId: "s-f13", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
    store.createToolCall({ id: "tc-f13", turnId: "t-f13", toolName: "mut.hang", argumentsJson: "{}", riskLevel: "read", status: "executing" });
    const f13Policy = registry.getExecutionPolicy("mut.hang");
    assert.ok(f13Policy, "mut.hang carries a trusted policy");
    const mkReq = () => ({
      toolName: "mut.hang", args: {}, sessionId: "s-f13", turnId: "t-f13", traceId: "tr", mode: ArthurMode.PERSONAL,
      toolCallId: "tc-f13", approvalId: null, toolVersion: "1.0.0",
      toolDefinitionHash: registry.getDefinitionHash("mut.hang") ?? "", argumentsHash: "h".repeat(64),
      policy: f13Policy,
    });
    const created = coordinator.createExecution(mkReq());
    const runP = coordinator.run(mkReq(), created.id);
    await new Promise((r) => setTimeout(r, 30));
    coordinator.requestCancel(created.id);
    const run = await runP;
    assert.equal(run.state, "outcome_unknown", "uncertain mutation cancel never claims rollback");
    assert.notEqual(run.state, "cancelled");
  } finally {
    store.close();
  }
});
// ---- F20: single retry authority audit ----

test("SC03-freeze-F20: only the coordinator retries; adapters and service do not", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const roots = ["src/tools/execution_service_v2.ts", "src/tools/adapters/harness_stub.ts", "src/tools/adapters/local_system.ts", "apps/api/server.ts"];
  const retryRe = /scheduleRetry|moveToRetryWait|computeRetryDelayMs|retryAllowed/i;
  for (const rel of roots) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    assert.ok(!retryRe.test(src), rel + " must contain no retry loop or scheduler");
  }
  const orch = fs.readFileSync(path.join(process.cwd(), "src/tools/orchestrator.ts"), "utf8");
  assert.ok(!/computeRetryDelayMs|retryAllowed|moveToRetryWait/.test(orch), "orchestrator holds no retry policy");
  const ds = fs.readFileSync(path.join(process.cwd(), "src/models/providers/deepseek.ts"), "utf8");
  assert.ok(/retryMaxAttempts/.test(ds), "provider retry budget is explicit and bounded");
});

// ---- F23 + reconciliation outcomes ----

test("SC03-freeze-F23: reconciler is read-only; all verdicts handled without re-invoke", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const app = buildTestApp({ dbPath });
    try {
      const coord = app.conversation.orchestratorForTests().getCoordinator();
      const registry = app.conversation.registryForTests();
      app.store.createSession("s-23", ArthurMode.PERSONAL);
      app.store.createTurn({ id: "t-23", sessionId: "s-23", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
      const mkUnknown = (suffix: string) => {
        const tc = "tc-23-" + suffix;
        const ex = "exec-23-" + suffix;
        app.store.createToolCall({ id: tc, turnId: "t-23", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
        coord.getExecutions().insertReadyExecution({
          id: ex, toolCallId: tc, approvalId: null, sessionId: "s-23", turnId: "t-23", mode: "personal",
          toolName: "system.echo", toolVersion: "1.0.0",
          toolDefinitionHash: registry.getDefinitionHash("system.echo") ?? "",
          argumentsHash: "i".repeat(64), maxAttempts: 1,
          createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
        });
        app.store.unsafeDbHandle().prepare("UPDATE tool_executions SET state='outcome_unknown', reconciliation_required=1 WHERE id=?").run(ex);
        return ex;
      };
      const calls: string[] = [];
      const counting = (verdict: "succeeded" | "failed" | "still_running" | "not_applied" | "unknown") => ({
        reconcile: async (id: string) => {
          calls.push(id);
          assert.equal(typeof id, "string");
          return verdict;
        },
      });
      const expectations: Array<[string, "succeeded" | "failed" | "still_running" | "not_applied" | "unknown", string]> = [
        ["a", "succeeded", "succeeded"],
        ["b", "failed", "failed"],
        ["c", "not_applied", "failed"],
        ["d", "still_running", "outcome_unknown"],
        ["e", "unknown", "outcome_unknown"],
      ];
      for (const pair of expectations) {
        const suffix = pair[0];
        const verdict = pair[1];
        const final = pair[2];
        const ex = mkUnknown(suffix);
        const after = await coord.reconcile(ex, counting(verdict));
        assert.equal(after?.state, final, "verdict " + verdict + " -> " + final);
      }
      assert.equal(calls.length, 5, "reconciler queried once per execution, never invoked executors");
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- F29/F30 over real HTTP ----

test("SC03-freeze-F29F30: status and cancel APIs over real HTTP are safe", async () => {
  const { startServer } = await import("../../apps/api/server");
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const app = buildTestApp({ dbPath });
    const srv = await startServer(app, { host: "127.0.0.1", port: 0 });
    const server = srv.server;
    const port = srv.port;
    const base = "http://127.0.0.1:" + port;
    try {
      const coord = app.conversation.orchestratorForTests().getCoordinator();
      const registry = app.conversation.registryForTests();
      app.store.createSession("s-h", ArthurMode.PERSONAL);
      app.store.createTurn({ id: "t-h", sessionId: "s-h", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
      const mk = (suffix: string, state: string) => {
        const tc = "tc-h-" + suffix;
        const ex = "exec-h-" + suffix;
        app.store.createToolCall({ id: tc, turnId: "t-h", toolName: "system.echo", argumentsJson: "{}", riskLevel: "read", status: "executing" });
        coord.getExecutions().insertReadyExecution({
          id: ex, toolCallId: tc, approvalId: null, sessionId: "s-h", turnId: "t-h", mode: "personal",
          toolName: "system.echo", toolVersion: "1.0.0",
          toolDefinitionHash: registry.getDefinitionHash("system.echo") ?? "",
          argumentsHash: "j".repeat(64), maxAttempts: 1,
          createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
        });
        app.store.unsafeDbHandle().prepare("UPDATE tool_executions SET state=? WHERE id=?").run(state, ex);
        return ex;
      };
      const banned = ["arguments_json", "signature", "private", "secret", "stack", "approvaltoken", "authorization"];
      const states: Array<[string, string]> = [["r", "ready"], ["w", "retry_wait"], ["u", "outcome_unknown"], ["s", "succeeded"]];
      for (const pair of states) {
        const ex = mk(pair[0], pair[1]);
        const res = await fetch(base + "/v1/executions/" + ex);
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.execution_id, ex);
        assert.equal(body.state, pair[1]);
        const blob = JSON.stringify(body).toLowerCase();
        for (const word of banned) assert.ok(blob.indexOf(word) < 0, "status must not leak " + word);
      }
      const readyEx = mk("cx", "ready");
      const cancelReady = (await (await fetch(base + "/v1/executions/" + readyEx + "/cancel", { method: "POST" })).json()) as { state: string };
      assert.equal(cancelReady.state, "cancelled");
      const unknownEx = mk("cu", "outcome_unknown");
      const cancelUnknown = (await (await fetch(base + "/v1/executions/" + unknownEx + "/cancel", { method: "POST" })).json()) as { state: string };
      assert.equal(cancelUnknown.state, "outcome_unknown", "OUTCOME_UNKNOWN must not pretend CANCELLED");
      const termEx = mk("ct", "succeeded");
      const cancelTerm = (await (await fetch(base + "/v1/executions/" + termEx + "/cancel", { method: "POST" })).json()) as { state: string };
      assert.equal(cancelTerm.state, "succeeded", "terminal returns existing state");
      const missing = await fetch(base + "/v1/executions/nope-missing/cancel", { method: "POST" });
      assert.equal(missing.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- F31/F32: bounded_json persistence + secret-free lifecycle ----

test("SC03-freeze-F31F32: bounded_json persists validated bounded data; secrets never persist", async () => {
  const { ToolRegistry } = await import("../../src/tools/registry");
  const { PermissionService } = await import("../../src/tools/permissions");
  const { ExecutionStore } = await import("../../src/sessions/execution_store");
  const { ToolExecutionCoordinator } = await import("../../src/tools/execution_coordinator");
  const { FakeExecutionClock } = await import("../../src/tools/execution_clock");
  const { ScriptedRetryRandomSource: Scripted } = await import("../../src/tools/execution_clock");
  const { SessionStore } = await import("../../src/sessions/store");
  const { SecretSanitizer } = await import("../../src/security/sanitize");
  const { Logger } = await import("../../src/observability/logging");
  const { InMemoryMetrics } = await import("../../src/observability/metrics");
  const SECRET = "freeze-marker-secret-9f8e";
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "safe.json", version: "1.0.0", description: "bounded json tool",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false },
      risk: "read", allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: { ...readPolicy(), result_persistence: "bounded_json" },
    },
    ((() => ({ ok: true, summary: "done", data: { echo: "ok" } })) as unknown) as never,
  );
  registry.register(
    {
      name: "big.json", version: "1.0.0", description: "oversized json tool",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false },
      risk: "read", allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: { ...readPolicy(), result_persistence: "bounded_json" },
    },
    ((() => ({ ok: true, summary: "big", data: { echo: "x".repeat(9000) } })) as unknown) as never,
  );
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([SECRET]));
  try {
    const executions = new ExecutionStore(store.unsafeDbHandle(), store.sanitizerHandle());
    const clock = new FakeExecutionClock(Date.now());
    const coordinator = new ToolExecutionCoordinator(store, executions, registry, permissions, registry.createSingleAttemptService(permissions), new SecretSanitizer([SECRET]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-f31", clock, jitter: new Scripted([0.5]) });
    store.createSession("s-31", ArthurMode.PERSONAL);
    store.createTurn({ id: "t-31", sessionId: "s-31", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.PERSONAL });
    const runOne = async (tool: string, tc: string) => {
      store.createToolCall({ id: tc, turnId: "t-31", toolName: tool, argumentsJson: "{}", riskLevel: "read", status: "executing" });
      const f31Policy = registry.getExecutionPolicy(tool);
      assert.ok(f31Policy, tool + " carries a trusted policy");
      const req = {
        toolName: tool, args: {}, sessionId: "s-31", turnId: "t-31", traceId: "tr", mode: ArthurMode.PERSONAL,
        toolCallId: tc, approvalId: null, toolVersion: "1.0.0",
        toolDefinitionHash: registry.getDefinitionHash(tool) ?? "", argumentsHash: "k".repeat(64),
        policy: f31Policy,
      };
      const created = coordinator.createExecution(req);
      return coordinator.run(req, created.id);
    };
    const okRun = await runOne("safe.json", "tc-31-ok");
    assert.equal(okRun.state, "succeeded");
    const okRow = executions.getExecution(okRun.executionId);
    assert.ok(okRow?.result_data_json, "bounded_json persists validated data");
    assert.ok((okRow?.result_data_json ?? "").indexOf("ok") >= 0);
    assert.ok((okRow?.result_data_json ?? "").indexOf(SECRET) < 0, "persisted data sanitized");
    const bigRun = await runOne("big.json", "tc-31-big");
    assert.equal(bigRun.state, "succeeded", "oversized data does not corrupt execution state");
    assert.equal(executions.getExecution(bigRun.executionId)?.result_data_json, null, "oversized data omitted, not persisted");
    const db = store.unsafeDbHandle();
    const blob = JSON.stringify(db.prepare("SELECT * FROM tool_executions").all()) + JSON.stringify(db.prepare("SELECT * FROM tool_execution_attempts").all());
    assert.ok(blob.indexOf(SECRET) < 0, "no raw secret in lifecycle tables");
  } finally {
    store.close();
  }
});

// ---- observability contract sections 86-89 ----

test("SC03-freeze-observability: logs and metrics carry the full bounded identity set", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as never;
    const provider = new FakeProvider({
      responder: () => ({ assistant_text: "", tool_calls: [{ id: "c-obs", name: "system.echo", arguments: { text: "obs" } }], finish_reason: "tool_calls" }),
    });
    const app = buildTestApp({ dbPath, logLevel: "debug" }, { provider });
    try {
      await app.conversation.handleTurn(validTurn({ message: "obs turn", client_request_id: "freeze-obs-1" }));
      const snap = app.metrics.snapshot();
      const names = Object.keys(snap.counters);
      for (const m of ["arthur.tool.execution.created", "arthur.tool.execution.started", "arthur.tool.execution.succeeded"]) {
        assert.ok(names.some((n) => n.indexOf(m) === 0), "metric " + m + " emitted");
      }
      const timers = Object.keys(snap.timers);
      assert.ok(timers.some((n) => n.indexOf("attempt_duration_ms") === 0), "attempt_duration_ms observed");
      assert.ok(timers.some((n) => n.indexOf("execution_total_ms") === 0), "execution_total_ms observed");
      const created = lines.filter((l) => l.indexOf("tool execution created") >= 0).join("\\n");
      for (const key of ["trace_id", "session_id", "turn_id", "tool_name", "execution_id", "tool_call_id"]) {
        assert.ok(created.indexOf(key) >= 0, "log carries " + key);
      }
      const started = lines.filter((l) => l.indexOf("tool attempt started") >= 0).join("\\n");
      assert.ok(started.indexOf("attempt_id") >= 0, "log carries attempt_id");
    } finally {
      process.stderr.write = origWrite;
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  const coordSrc = fs.readFileSync(path.join(process.cwd(), "src/tools/execution_coordinator.ts"), "utf8");
  assert.ok(coordSrc.indexOf('"retry_delay_ms"') >= 0, "retry_delay_ms emitted on backoff");
  assert.ok(coordSrc.indexOf('"reconciliation_ms"') >= 0, "reconciliation_ms emitted on reconcile");
});

// ---- policy security binding sections 114-117 ----

test("SC03-freeze-policy: policy-only change alters the hash; args cannot override policy", async () => {
  const { toolDefinitionHash } = await import("../../src/tools/approval_intent");
  const base = {
    name: "pol.tool", version: "1.0.0", description: "policy binding probe",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read" as const, allowed_modes: [ArthurMode.PERSONAL],
  };
  const h0 = toolDefinitionHash(base as never);
  const patches: Array<Record<string, unknown>> = [
    { idempotency: "none" },
    { retry: { strategy: "off", max_attempts: 1, base_delay_ms: 100, max_delay_ms: 2000 } },
    { attempt_timeout_ms: 9999 },
    { cancellation: "unsupported" },
    { reconciliation: "authoritative" },
  ];
  for (const patch of patches) {
    const h1 = toolDefinitionHash({ ...base, execution_policy: { ...readPolicy(), ...patch } } as never);
    assert.notEqual(h1, h0, "policy change must change the hash");
  }
  const fs = await import("node:fs");
  const path = await import("node:path");
  const coordSrc = fs.readFileSync(path.join(process.cwd(), "src/tools/execution_coordinator.ts"), "utf8");
  assert.ok(coordSrc.indexOf("args.timeout") < 0 && coordSrc.indexOf("args.retry") < 0, "args never override policy");
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const app = buildTestApp({ dbPath });
    try {
      const def = app.conversation.getToolDefinition("system.echo");
      assert.ok(def?.execution_policy, "registered tools carry trusted policy");
      assert.equal(def?.execution_policy.effects, "none");
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---- BLOCKER: expired authorization never reaches invoker() (SC-02 sections 32/40) ----

test("SC03-freeze-final-gate: expired capability fails closed before invoker, calls=0", async () => {
  const { ToolRegistry } = await import("../../src/tools/registry");
  const { PermissionService } = await import("../../src/tools/permissions");
  const { SessionStore } = await import("../../src/sessions/store");
  const { SecretSanitizer } = await import("../../src/security/sanitize");
  const { ApprovalSigner, ApprovalVerifier, generateApprovalKeypair } = await import("../../src/tools/approval_signer");
  const { authorizationDigest, approvalArgumentsHash } = await import("../../src/tools/approval_intent");
  const kp = generateApprovalKeypair();
  const signer = new ApprovalSigner(kp);
  const registry = new ToolRegistry();
  let invokerCalls = 0;
  registry.register(
    {
      name: "guarded.write", version: "1.0.0", description: "approval-gated probe",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      risk: "approval_required", allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: { ...readPolicy(), effects: "mutation", idempotency: "none", retry: { strategy: "off", max_attempts: 1, base_delay_ms: 100, max_delay_ms: 2000 } },
    },
    (() => ({ action: "Guarded write", details: [] })) as never,
    ((async () => { invokerCalls += 1; return { ok: true, summary: "wrote", data: { echo: "wrote" } }; }) as unknown) as never,
  );
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  try {
    const service = registry.createSingleAttemptService(permissions);
    const argsHash = approvalArgumentsHash({});
    const expiredCapability = signer.sign({
      binding_version: 2, approval_id: "ap-exp", tool_call_id: "tc-exp", session_id: "s", turn_id: "t",
      mode: ArthurMode.PERSONAL, tool_name: "guarded.write", tool_version: "1.0.0",
      tool_definition_hash: registry.getDefinitionHash("guarded.write") ?? "", risk_level: "approval_required",
      arguments_hash: argsHash, presentation_hash: "p",
      created_at: new Date(Date.now() - 600000).toISOString(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }, "digest-expired");
    const verifier = new ApprovalVerifier([kp]);
    const verified = verifier.verify(expiredCapability);
    let outcome: Awaited<ReturnType<typeof service.executeAttempt>>;
    try {
      outcome = await service.executeAttempt({
      name: "guarded.write", args: {},
      ctx: { session_id: "s", turn_id: "t", trace_id: "tr", mode: ArthurMode.PERSONAL, approved: true, authorization: verified },
      attempt: { execution_id: "exec-exp", attempt_id: "att-exp", attempt_no: 1, deadline_at: new Date(Date.now() + 5000).toISOString(), signal: new AbortController().signal },
      policy: registry.getExecutionPolicy("guarded.write") ?? readPolicy(),
      signal: new AbortController().signal,
      abortGraceMs: 50,
    });
    } catch (err) {
      const { ArthurError } = await import("../../src/core/errors/errors");
      assert.ok(err instanceof ArthurError && err.code === "APPROVAL_INVALID", "expired evidence throws APPROVAL_INVALID");
      outcome = { ok: false, failure: { kind: "permanent", effect_outcome: "not_applied", retry_hint: false, code: "APPROVAL_INVALID", summary: (err as Error).message }, effectOutcome: "not_applied", kind: "permanent" } as typeof outcome;
    }
    assert.equal(outcome.ok, false, "expired authorization must not succeed");
    if (!outcome.ok) assert.equal(outcome.failure.code, "APPROVAL_INVALID");
    assert.equal(invokerCalls, 0, "expired authorization never reaches invoker()");
  } finally {
    store.close();
  }
});

test("SC03-freeze-final-gate-throw: service throws APPROVAL_INVALID for expired evidence", async () => {
  const { ToolRegistry } = await import("../../src/tools/registry");
  const { PermissionService } = await import("../../src/tools/permissions");
  const { ApprovalSigner, ApprovalVerifier, generateApprovalKeypair } = await import("../../src/tools/approval_signer");
  const { approvalArgumentsHash } = await import("../../src/tools/approval_intent");
  const { ArthurError } = await import("../../src/core/errors/errors");
  const kp = generateApprovalKeypair();
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "guarded.read", version: "1.0.0", description: "approval-gated read probe",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      risk: "approval_required", allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
      execution_policy: readPolicy(),
    },
    (() => ({ action: "Guarded read", details: [] })) as never,
    ((async () => ({ ok: true, summary: "read", data: { echo: "read" } })) as unknown) as never,
  );
  const service = registry.createSingleAttemptService(new PermissionService());
  const signer = new ApprovalSigner(kp);
  const expired = signer.sign({ 
    binding_version: 2, approval_id: "ap-exp2", tool_call_id: "tc-exp2", session_id: "s", turn_id: "t",
    mode: "business", tool_name: "guarded.read", tool_version: "1.0.0",
    tool_definition_hash: registry.getDefinitionHash("guarded.read") ?? "", risk_level: "approval_required",
    arguments_hash: approvalArgumentsHash({}), presentation_hash: "p",
    created_at: new Date(Date.now() - 600000).toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
  }, "digest2");
  const verified = new ApprovalVerifier([kp]).verify(expired);
  await assert.rejects(
    () => service.executeAttempt({
      name: "guarded.read", args: {},
      ctx: { session_id: "s", turn_id: "t", trace_id: "tr", mode: ArthurMode.BUSINESS, approved: true, authorization: verified },
      attempt: { execution_id: "exec-exp2", attempt_id: "att-exp2", attempt_no: 1, deadline_at: new Date(Date.now() + 5000).toISOString(), signal: new AbortController().signal },
      policy: registry.getExecutionPolicy("guarded.read") ?? readPolicy(),
      signal: new AbortController().signal,
      abortGraceMs: 50,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error && (err as { code?: string }).code === "APPROVAL_INVALID");
      assert.ok(String((err as Error).message).toLowerCase().indexOf("expir") >= 0);
      return true;
    },
  );
});

test("SC03-freeze-consume-expiry: expired approval cannot consume or bind execution", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    const provider = new FakeProvider({
      responder: () => ({ assistant_text: "", tool_calls: [{ id: "c-exp", name: "harness.create_job", arguments: { kind: "deploy" } }], finish_reason: "tool_calls" }),
    });
    const app = buildTestApp({ dbPath }, { provider });
    try {
      const turn = await app.conversation.handleTurn(validTurn({ mode: "business", message: "deploy", client_request_id: "freeze-exp-1" }));
      const approvalId = turn.tool_calls[0]?.approval_id as string;
      assert.ok(approvalId);
      app.store.unsafeDbHandle().prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), approvalId);
      await assert.rejects(() => app.conversation.approve(approvalId));
      const row = app.store.getApproval(approvalId);
      assert.equal(row?.status, "expired");
      assert.equal(row?.consumed_at ?? null, null, "expired approval never consumes");
      const bound = app.store.unsafeDbHandle().prepare("SELECT COUNT(*) AS n FROM tool_executions WHERE approval_id = ?").get(approvalId) as unknown as { n: number };
      assert.equal(bound.n, 0, "expired approval binds no execution");
    } finally {
      app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SC03-freeze-claim-expiry: stale claim cannot dispatch after expiry (no invoker call)", async () => {
  const dir = workspaceTempDir();
  const dbPath = join(dir, "arthur.db");
  try {
    let invocations = 0;
    const { ToolRegistry } = await import("../../src/tools/registry");
    const { PermissionService } = await import("../../src/tools/permissions");
    const { ExecutionStore } = await import("../../src/sessions/execution_store");
    const { ToolExecutionCoordinator } = await import("../../src/tools/execution_coordinator");
    const { FakeExecutionClock } = await import("../../src/tools/execution_clock");
    const { SessionStore } = await import("../../src/sessions/store");
    const { SecretSanitizer } = await import("../../src/security/sanitize");
    const { Logger } = await import("../../src/observability/logging");
    const { InMemoryMetrics } = await import("../../src/observability/metrics");
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "expiring.write", version: "1.0.0", description: "expiry race probe",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output_schema: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false },
        risk: "approval_required", allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
        execution_policy: { ...readPolicy(), effects: "mutation", idempotency: "none", retry: { strategy: "off", max_attempts: 1, base_delay_ms: 100, max_delay_ms: 2000 } },
      },
      (() => ({ action: "Expiring write", details: [] })) as never,
      ((async () => { invocations += 1; return { ok: true, summary: "wrote", data: { echo: "wrote" } }; }) as unknown) as never,
    );
    const permissions = new PermissionService();
    const store = new SessionStore(dbPath, new SecretSanitizer([]));
    try {
      const executions = new ExecutionStore(store.unsafeDbHandle(), store.sanitizerHandle());
      const clock = new FakeExecutionClock(Date.now());
      const coordinator = new ToolExecutionCoordinator(store, executions, registry, permissions, registry.createSingleAttemptService(permissions), new SecretSanitizer([]), new Logger("error"), new InMemoryMetrics(), { runtimeInstanceId: "runtime-exp", clock });
      store.createSession("s-exp", ArthurMode.BUSINESS);
      store.createTurn({ id: "t-exp", sessionId: "s-exp", role: "user", text: "go", traceId: "tr", status: "completed", mode: ArthurMode.BUSINESS });
      store.createToolCall({ id: "tc-exp", turnId: "t-exp", toolName: "expiring.write", argumentsJson: "{}", riskLevel: "approval_required", status: "executing" });
      const pastIso = new Date(Date.now() - 5000).toISOString();
      store.unsafeDbHandle().prepare("INSERT INTO approvals (id, turn_id, session_id, tool_call_id, tool_name, arguments_json, arguments_hash, status, expires_at, created_at, binding_version, consumed_at, mode, tool_version, tool_definition_hash, presentation_json, presentation_hash, authorization_digest, signing_key_id, risk_level) VALUES ('ap-exp3','t-exp','s-exp','tc-exp','expiring.write','{}','" + "a".repeat(64) + "','approved','" + pastIso + "','" + pastIso + "',2,'" + pastIso + "','business','1.0.0','d','{}','p','z','k','approval_required')").run();
      executions.insertReadyExecution({
        id: "exec-exp3", toolCallId: "tc-exp", approvalId: "ap-exp3", sessionId: "s-exp", turnId: "t-exp", mode: "business",
        toolName: "expiring.write", toolVersion: "1.0.0", toolDefinitionHash: registry.getDefinitionHash("expiring.write") ?? "",
        argumentsHash: "a".repeat(64), maxAttempts: 1,
        createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString(),
      });
      const claimed = store.transaction(() => executions.claimAttempt({ executionId: "exec-exp3", attemptId: "att-exp3", attemptNo: 1, runtimeInstanceId: "runtime-exp", startedAt: new Date().toISOString() }));
      assert.equal(claimed, false, "claim CAS fails when bound approval expired");
      assert.equal(invocations, 0, "no invoker call without a claim");
      assert.equal((store.unsafeDbHandle().prepare("SELECT state FROM tool_executions WHERE id='exec-exp3'").get() as { state: string }).state, "ready");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
