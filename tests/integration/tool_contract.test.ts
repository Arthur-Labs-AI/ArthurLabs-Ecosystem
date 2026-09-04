/**
 * TASK-0010 integration tests: orchestrator boundary, audit trail, and
 * Phase 1 builtin regressions through the hardened contracts (task sections
 * 14/15 N, P, T, U, V, W, X).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { ArthurMode } from "../../src/core/modes/mode";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelResult } from "../../src/models/contracts";
import { Logger } from "../../src/observability/logging";
import { InMemoryMetrics } from "../../src/observability/metrics";
import { SecretSanitizer } from "../../src/security/sanitize";
import { SessionStore } from "../../src/sessions/store";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { registerBuiltinTools } from "../../src/tools/builtin";
import type { ApprovalToken, ToolExecutionContext } from "../../src/tools/contracts";
import { ToolOrchestrator } from "../../src/tools/orchestrator";
import { argumentsDigest, PermissionService, signApprovalToken } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import { buildTestApp, validTurn } from "../helpers";

const SIGNING_SECRET = "tool-contract-integration-secret";

function buildWorld(mode: ArthurMode = ArthurMode.PERSONAL): {
  registry: ToolRegistry;
  harness: HarnessStubAdapter;
  store: SessionStore;
  orchestrator: ToolOrchestrator;
  execution: ReturnType<ToolRegistry["createExecutionService"]>;
  ctx: ToolExecutionContext;
  close: () => void;
} {
  const registry = new ToolRegistry();
  const harness = new HarnessStubAdapter({ verificationSecret: SIGNING_SECRET });
  registerBuiltinTools(registry, harness);
  registry.register(
    {
      name: "broken.output",
      version: "1.0.0",
      description: "executor lies about its output shape",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output_schema: {
        type: "object",
        properties: { branch: { type: "string" } },
        required: ["branch"],
        additionalProperties: false,
      },
      risk: "read",
      allowed_modes: [ArthurMode.PERSONAL, ArthurMode.BUSINESS],
    },
    () => ({ ok: true, summary: "looks done", data: { branch: 123 } }),
  );
  const permissions = new PermissionService();
  const store = new SessionStore(":memory:", new SecretSanitizer([]));
  const execution = registry.createExecutionService(permissions);
  const orchestrator = new ToolOrchestrator({
    registry,
    execution,
    store,
    permissions,
    sanitizer: new SecretSanitizer([]),
    approvalTtlSeconds: 300,
    approvalSigningSecret: SIGNING_SECRET,
    logger: new Logger("error"),
    metrics: new InMemoryMetrics(),
  });
  store.createSession("s1", mode);
  store.createTurn({ id: "t1", sessionId: "s1", role: "user", text: "go", traceId: "tr1", status: "completed", mode });
  return {
    registry,
    harness,
    store,
    orchestrator,
    execution,
    ctx: { session_id: "s1", turn_id: "t1", trace_id: "tr1", mode, approved: false },
    close: () => store.close(),
  };
}

// ---- N: malformed output never reaches the model as success ----------------

test("N: TOOL_OUTPUT_INVALID never produces a model follow-up message", async () => {
  const w = buildWorld();
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-n", name: "broken.output", arguments: {} }],
      w.ctx,
    );
    assert.equal(handling.toolResultMessages.length, 0, "no tool result message may be built");
    assert.equal(handling.needsApproval, false);
    assert.equal(handling.summaries.length, 1);
    assert.equal(handling.summaries[0]?.status, "rejected");
    assert.ok(handling.summaries[0]?.result_summary?.includes("invalid output"));
    const records = w.store.getToolCallsForTurn("t1");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "failed", "the tool call is audited as failed, not completed");
  } finally {
    w.close();
  }
});

// ---- T: rejected/failed calls remain auditable ------------------------------

test("T: rejected and failed tool calls remain auditable", async () => {
  const w = buildWorld();
  try {
    await w.orchestrator.handleProposed(
      [
        { id: "c-unknown", name: "ghost.tool", arguments: {} },
        { id: "c-badargs", name: "system.echo", arguments: { wrong: 1 } },
        { id: "c-broken", name: "broken.output", arguments: {} },
        { id: "c-ok", name: "system.echo", arguments: { text: "ping" } },
      ],
      w.ctx,
    );
    const records = w.store.getToolCallsForTurn("t1");
    assert.equal(records.length, 4);
    const byId = new Map(records.map((r) => [r.id, r]));
    // Records are keyed by store ids; assert the four statuses are present.
    const statuses = records.map((r) => r.status).sort();
    assert.deepEqual(statuses, ["completed", "failed", "rejected", "rejected"]);
    for (const record of records) {
      assert.equal(typeof record.tool_name, "string");
      assert.ok(record.arguments_json.length > 0);
      assert.ok(JSON.parse(record.arguments_json) !== undefined, "arguments persisted as JSON");
    }
    const completed = records.find((r) => r.status === "completed");
    assert.equal(completed?.tool_name, "system.echo");
  } finally {
    w.close();
  }
});

// ---- P: model proposal alone cannot bypass permissions ----------------------

test("P: a model proposal has zero authority over the permission boundary", async () => {
  const w = buildWorld(ArthurMode.PERSONAL);
  try {
    // Business-only tool proposed in personal mode: rejected, never executed.
    const rejected = await w.orchestrator.handleProposed(
      [{ id: "call-p1", name: "harness.create_job", arguments: { kind: "deploy" } }],
      w.ctx,
    );
    assert.equal(rejected.needsApproval, false);
    assert.equal(rejected.summaries[0]?.status, "rejected");
    assert.equal(rejected.toolResultMessages.length, 0);
    const status = await w.harness.getStatus();
    assert.equal(status.jobs_active, 0, "nothing was executed");

    // Same proposal in business mode goes to pending approval, still executes nothing.
    w.store.createSession("s2", ArthurMode.BUSINESS);
    w.store.createTurn({ id: "t2", sessionId: "s2", role: "user", text: "go", traceId: "tr2", status: "completed", mode: ArthurMode.BUSINESS });
    const businessCtx: ToolExecutionContext = { session_id: "s2", turn_id: "t2", trace_id: "tr2", mode: ArthurMode.BUSINESS, approved: false };
    const pending = await w.orchestrator.handleProposed(
      [{ id: "call-p2", name: "harness.create_job", arguments: { kind: "deploy" } }],
      businessCtx,
    );
    assert.equal(pending.needsApproval, true);
    assert.equal(pending.summaries[0]?.status, "pending_approval");
    assert.equal(pending.toolResultMessages.length, 0);
    const approvalId = pending.summaries[0]?.approval_id;
    assert.ok(approvalId);
    assert.equal(w.store.getApproval(approvalId)?.status, "pending");
    assert.equal((await w.harness.getStatus()).jobs_active, 0, "approval is not execution");
  } finally {
    w.close();
  }
});

// ---- U/V/W/X: Phase 1 builtin regressions through the hardened contracts -----

test("U: system.echo still works end to end", async () => {
  const w = buildWorld();
  try {
    const handling = await w.orchestrator.handleProposed(
      [{ id: "call-u", name: "system.echo", arguments: { text: "ping" } }],
      w.ctx,
    );
    assert.equal(handling.summaries[0]?.status, "completed");
    assert.equal(handling.toolResultMessages.length, 1);
    const message = handling.toolResultMessages[0];
    assert.equal(message?.role, "tool");
    assert.equal(message?.tool_call_id, "call-u");
    assert.equal(message?.name, "system.echo");
    assert.equal(message?.content, "ping");
    const records = w.store.getToolCallsForTurn("t1");
    assert.equal(records[0]?.status, "completed");
  } finally {
    w.close();
  }
});

test("V: harness.status still works with enforced output_schema", async () => {
  const w = buildWorld();
  try {
    const result = await w.execution.execute("harness.status", {}, w.ctx);
    assert.equal(result.ok, true);
    assert.equal(result.data && (result.data as { status: string }).status, "online");
  } finally {
    w.close();
  }
});

test("W: harness.create_job still requires approval and works with signed evidence", async () => {
  const w = buildWorld(ArthurMode.BUSINESS);
  try {
    // No approval evidence: fail closed before the executor.
    await assert.rejects(
      () => w.execution.execute("harness.create_job", { kind: "deploy" }, w.ctx),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_REQUIRED",
    );
    assert.equal((await w.harness.getStatus()).jobs_active, 0);

    // Valid signed approval token bound to the exact tool + arguments: works.
    const args = { kind: "deploy" };
    const signable = {
      approval_id: "ap-w",
      tool_name: "harness.create_job",
      session_id: "s1",
      turn_id: "t1",
      arguments_hash: argumentsDigest(args),
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const token: ApprovalToken = { ...signable, signature: signApprovalToken(signable, SIGNING_SECRET) };
    const result = await w.execution.execute("harness.create_job", args, {
      ...w.ctx,
      approved: true,
      approvalToken: token,
    });
    assert.equal(result.ok, true);
    const job = result.data as { id: string; status: string };
    assert.ok(job.id.startsWith("job-"));
    assert.equal(job.status, "queued");
  } finally {
    w.close();
  }
});

test("X: Personal/Business mode restrictions remain unchanged", async () => {
  const w = buildWorld();
  try {
    // Mode mapping of the PHASE 1 BUILTINS is unchanged; broken.output is a
    // deterministic test tool registered by this suite. TASK-0011 added the
    // real machine-local system.status builtin (read, both modes).
    const builtinNames = (mode: ArthurMode) =>
      w.registry
        .listAllowedForMode(mode)
        .map((d) => d.name)
        .filter((name) => name.startsWith("system.") || name.startsWith("harness."))
        .sort();
    assert.deepEqual(builtinNames(ArthurMode.PERSONAL), ["harness.status", "system.echo", "system.status"]);
    assert.deepEqual(
      builtinNames(ArthurMode.BUSINESS),
      ["harness.create_job", "harness.status", "system.echo", "system.status"],
    );

    await w.execution.execute("harness.status", {}, w.ctx); // read in personal: fine
    await assert.rejects(
      () => w.execution.execute("harness.create_job", { kind: "deploy" }, w.ctx),
      (err: unknown) => err instanceof ArthurError && err.code === "MODE_VIOLATION",
    );
  } finally {
    w.close();
  }
});

// ---- End-to-end through the real conversation service ------------------------

test("system.echo flows through the full conversation tool round-trip", async () => {
  let round = 0;
  const provider = new FakeProvider({
    responder: (): ModelResult => {
      round += 1;
      if (round === 1) {
        return {
          assistant_text: "",
          tool_calls: [{ id: "call-e2e", name: "system.echo", arguments: { text: "ping" } }],
          finish_reason: "tool_calls",
        };
      }
      return { assistant_text: "echoed: ping", tool_calls: [], finish_reason: "stop" };
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "echo ping" }));
    assert.equal(response.display_text, "echoed: ping");
    const records = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, "completed");
    assert.equal(records[0]?.tool_name, "system.echo");
  } finally {
    app.close();
  }
});
