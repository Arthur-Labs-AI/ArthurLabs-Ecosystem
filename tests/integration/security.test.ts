import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { TurnResponse } from "../../src/core/conversation/models";
import type { ModelRequest } from "../../src/models/contracts";
import { FakeProvider } from "../../src/models/providers/fake";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { registerBuiltinTools } from "../../src/tools/builtin";
import { ApprovalToken, HarnessAdapter, HarnessJob, HarnessJobSpec, HarnessStatus, ToolExecutionContext } from "../../src/tools/contracts";
import { argumentsDigest, PermissionService } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import { buildTestApp, validTurn } from "../helpers";

function countingHarness(): { harness: HarnessAdapter; jobCount: () => number } {
  let count = 0;
  const harness: HarnessAdapter = {
    getStatus: async (): Promise<HarnessStatus> => ({ status: "online", version: "stub", jobs_active: 0 }),
    createJob: async (spec: HarnessJobSpec, _approval: ApprovalToken): Promise<HarnessJob> => {
      count += 1;
      return { id: "job-" + count, status: "queued", spec };
    },
    getJob: async (jobId: string): Promise<HarnessJob> => {
      throw new Error("not used: " + jobId);
    },
    cancelJob: async (): Promise<void> => {},
  };
  return { harness, jobCount: () => count };
}

function createJobProvider(): FakeProvider {
  return new FakeProvider({
    responder: () => ({
      assistant_text: "",
      tool_calls: [{ id: "call-1", name: "harness.create_job", arguments: { kind: "deploy" } }],
      finish_reason: "tool_calls",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
}

async function pendingApproval(app: { conversation: { handleTurn: (r: unknown) => Promise<TurnResponse> } }): Promise<{ sessionId: string; approvalId: string }> {
  const response = await app.conversation.handleTurn(validTurn({ mode: "business" }));
  const approvalId = response.tool_calls[0]?.approval_id;
  assert.ok(approvalId, "expected a pending approval");
  return { sessionId: response.session_id, approvalId: approvalId as string };
}

// ---- BLOCKER 1: approval atomic claim + crash recovery -------------------

test("concurrent approval requests execute the action exactly once", async () => {
  const h = countingHarness();
  const app = buildTestApp({}, { harness: h.harness, provider: createJobProvider() });
  try {
    const { approvalId } = await pendingApproval(app);
    const results = await Promise.allSettled([
      app.conversation.approve(approvalId),
      app.conversation.approve(approvalId),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 1);
    assert.equal(h.jobCount(), 1);
    assert.equal(app.store.getApproval(approvalId)?.status, "approved");
  } finally {
    app.close();
  }
});

test("claimApproval is an atomic compare-and-swap", async () => {
  const app = buildTestApp({}, { provider: createJobProvider() });
  try {
    const { approvalId } = await pendingApproval(app);
    assert.equal(app.store.claimApproval(approvalId), true);
    assert.equal(app.store.claimApproval(approvalId), false);
  } finally {
    app.close();
  }
});

test("an executing approval with unknown crash outcome is never automatically retried", async () => {
  const h = countingHarness();
  const app = buildTestApp({}, { harness: h.harness, provider: createJobProvider() });
  try {
    const { approvalId } = await pendingApproval(app);
    assert.equal(app.store.claimApproval(approvalId), true);
    assert.equal(app.store.getApproval(approvalId)?.status, "executing");
    await assert.rejects(
      () => app.conversation.approve(approvalId),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_INVALID",
    );
    assert.equal(h.jobCount(), 0);
    assert.equal(app.store.getApproval(approvalId)?.status, "executing");
  } finally {
    app.close();
  }
});

// ---- BLOCKER 2: approval re-enforcement --------------------------------

test("approval is rejected after the session changes mode", async () => {
  const h = countingHarness();
  const app = buildTestApp({}, { harness: h.harness, provider: createJobProvider() });
  try {
    const { sessionId, approvalId } = await pendingApproval(app);
    await app.conversation.changeMode(sessionId, { mode: "personal" });
    await assert.rejects(
      () => app.conversation.approve(approvalId),
      (err: unknown) => err instanceof ArthurError && err.code === "MODE_VIOLATION",
    );
    assert.equal(h.jobCount(), 0);
    assert.equal(app.store.getApproval(approvalId)?.status, "failed");
  } finally {
    app.close();
  }
});

test("approval with a mismatched argument digest is rejected", async () => {
  const app = buildTestApp();
  try {
    app.store.createSession("s1", "business");
    app.store.createTurn({ id: "t1", sessionId: "s1", role: "user", text: "x", traceId: "tr", status: "completed", mode: "business" });
    app.store.createToolCall({
      id: "tc1",
      turnId: "t1",
      toolName: "harness.create_job",
      argumentsJson: JSON.stringify({ kind: "deploy" }),
      riskLevel: "approval_required",
      status: "pending_approval",
    });
    app.store.createApproval({
      id: "ap1",
      turnId: "t1",
      sessionId: "s1",
      toolCallId: "tc1",
      toolName: "harness.create_job",
      argumentsJson: JSON.stringify({ kind: "deploy" }),
      argumentsHash: argumentsDigest({ kind: "OTHER" }),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await assert.rejects(
      () => app.conversation.approve("ap1"),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_INVALID",
    );
  } finally {
    app.close();
  }
});

test("approval for a no-longer-registered tool is rejected", async () => {
  const app = buildTestApp();
  try {
    app.store.createSession("s1", "business");
    app.store.createTurn({ id: "t1", sessionId: "s1", role: "user", text: "x", traceId: "tr", status: "completed", mode: "business" });
    app.store.createToolCall({
      id: "tc1",
      turnId: "t1",
      toolName: "ghost.tool",
      argumentsJson: JSON.stringify({}),
      riskLevel: "approval_required",
      status: "pending_approval",
    });
    app.store.createApproval({
      id: "ap1",
      turnId: "t1",
      sessionId: "s1",
      toolCallId: "tc1",
      toolName: "ghost.tool",
      argumentsJson: JSON.stringify({}),
      argumentsHash: argumentsDigest({}),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    await assert.rejects(
      () => app.conversation.approve("ap1"),
      (err: unknown) => err instanceof ArthurError && err.code === "TOOL_NOT_FOUND",
    );
  } finally {
    app.close();
  }
});

// ---- HIGH 3: idempotency -------------------------------------------------

test("concurrent identical requests create a single session and turn", async () => {
  const app = buildTestApp();
  try {
    const req = validTurn({ client_request_id: "conc-1", message: "hello" });
    const results = await Promise.allSettled([
      app.conversation.handleTurn(req),
      app.conversation.handleTurn(req),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as ArthurError;
    assert.equal(reason.code, "INVALID_REQUEST");
    assert.equal(app.store.listSessions().length, 1);
    const resp = (fulfilled[0] as PromiseFulfilledResult<TurnResponse>).value;
    const summary = await app.conversation.getSession(resp.session_id);
    assert.equal(summary.turns.filter((t) => t.role === "user").length, 1);
  } finally {
    app.close();
  }
});

test("reusing a client_request_id with different content is rejected", async () => {
  const app = buildTestApp();
  try {
    await app.conversation.handleTurn(validTurn({ client_request_id: "k1", message: "one" }));
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn({ client_request_id: "k1", message: "two" })),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn({ client_request_id: "k1", message: "one", mode: "business" })),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
  } finally {
    app.close();
  }
});

test("idempotency state machine terminalizes stale and failed records", async () => {
  const app = buildTestApp();
  try {
    const store = app.store;
    assert.equal(store.beginIdempotency("new:xyz", "xyz", "hashA", 1000).kind, "proceed");
    assert.equal(store.beginIdempotency("new:xyz", "xyz", "hashA", 1000).kind, "in_progress");
    assert.equal(store.beginIdempotency("new:xyz", "xyz", "hashB", 1000).kind, "conflict");
    store.completeIdempotency("new:xyz", "s1", "t1", JSON.stringify({ ok: true }));
    assert.equal(store.beginIdempotency("new:xyz", "xyz", "hashA", 1000).kind, "replay");

    // Stale and failed records are terminal: blindly adopting them could
    // duplicate an external side effect whose outcome is unknown.
    assert.equal(store.beginIdempotency("new:stale", "stale", "hashS", 1).kind, "proceed");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.beginIdempotency("new:stale", "stale", "hashS", 1).kind, "failed");

    store.beginIdempotency("new:fail", "fail", "hashF", 1000);
    store.failIdempotency("new:fail");
    assert.equal(store.beginIdempotency("new:fail", "fail", "hashF", 1000).kind, "failed");
  } finally {
    app.close();
  }
});

// ---- HIGH 4: mode-partitioned history ------------------------------------

test("personal and business history stay isolated across mode changes", async () => {
  const requests: ModelRequest[] = [];
  const provider = new FakeProvider({
    responder: (req) => {
      requests.push(req);
      return { assistant_text: "reply", tool_calls: [], finish_reason: "stop", usage: {} };
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const first = await app.conversation.handleTurn(validTurn({ mode: "personal", message: "PERSONAL_SECRET_777" }));
    await app.conversation.changeMode(first.session_id, { mode: "business" });
    await app.conversation.handleTurn(validTurn({ session_id: first.session_id, mode: "business", message: "business question", client_request_id: "b1" }));

    const bizReq = requests[requests.length - 1];
    assert.ok(bizReq);
    assert.ok(!bizReq.history.some((m) => m.content.includes("PERSONAL_SECRET_777")));

    await app.conversation.changeMode(first.session_id, { mode: "personal" });
    await app.conversation.handleTurn(validTurn({ session_id: first.session_id, mode: "personal", message: "personal again", client_request_id: "p2" }));

    const personalReq = requests[requests.length - 1];
    assert.ok(personalReq);
    assert.ok(personalReq.history.some((m) => m.content.includes("PERSONAL_SECRET_777")));
    assert.ok(!personalReq.history.some((m) => m.content.includes("business question")));
  } finally {
    app.close();
  }
});

// ---- HIGH 5: secret safety across boundaries -----------------------------

test("secrets are redacted across persistence, model payload, and response", async () => {
  const captured: ModelRequest[] = [];
  const provider = new FakeProvider({
    responder: (req) => {
      captured.push(req);
      return { assistant_text: req.userMessage, tool_calls: [], finish_reason: "stop", usage: {} };
    },
  });
  const app = buildTestApp({ deepseekApiKey: "sk-super-secret-1234567890" }, { provider });
  try {
    const resp = await app.conversation.handleTurn(
      validTurn({ message: "my key is sk-super-secret-1234567890 and password=hunter2" }),
    );
    assert.ok(!resp.display_text.includes("sk-super-secret-1234567890"));
    assert.ok(!resp.display_text.includes("hunter2"));
    assert.ok(resp.display_text.includes("[REDACTED]"));

    const req = captured[0];
    assert.ok(req);
    assert.ok(!req.userMessage.includes("sk-super-secret-1234567890"));
    assert.ok(!req.userMessage.includes("hunter2"));

    const summary = await app.conversation.getSession(resp.session_id);
    const userText = summary.turns.find((t) => t.role === "user")?.text ?? "";
    assert.ok(!userText.includes("sk-super-secret-1234567890"));
    assert.ok(!userText.includes("hunter2"));
    assert.ok(userText.includes("[REDACTED]"));
  } finally {
    app.close();
  }
});

// ---- MEDIUM 6: transactional persistence ---------------------------------

test("store transaction rolls back on error", () => {
  const app = buildTestApp();
  try {
    assert.throws(() => {
      app.store.transaction(() => {
        app.store.createSession("sx", "personal");
        throw new Error("boom");
      });
    });
    assert.equal(app.store.getSession("sx"), undefined);
  } finally {
    app.close();
  }
});

test("pending approval persists tool call and approval atomically", async () => {
  const app = buildTestApp({}, { provider: createJobProvider() });
  try {
    const { approvalId } = await pendingApproval(app);
    const approval = app.store.getApproval(approvalId);
    assert.ok(approval);
    const toolCall = app.store.getToolCall(approval.tool_call_id);
    assert.ok(toolCall);
    assert.equal(toolCall.status, "pending_approval");
  } finally {
    app.close();
  }
});

// ---- MEDIUM 7: no raw executor bypass ------------------------------------

test("App exposes no raw tool registry or executor", () => {
  const app = buildTestApp();
  try {
    const surface = app as unknown as Record<string, unknown>;
    assert.equal(surface.registry, undefined);
    assert.equal(surface.execution, undefined);
    assert.equal(surface.orchestrator, undefined);
  } finally {
    app.close();
  }
  const registry = new ToolRegistry();
  assert.equal((registry as unknown as Record<string, unknown>).runExecutor, undefined);
});

test("secured execution facade rejects a business-only tool in personal mode", async () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: "x" }));
  const execution = registry.createExecutionService(new PermissionService());
  const ctx: ToolExecutionContext = { session_id: "s", turn_id: "t", trace_id: "tr", mode: "personal", approved: false };
  await assert.rejects(
    () => execution.execute("harness.create_job", { kind: "deploy" }, ctx),
    (err: unknown) => err instanceof ArthurError && err.code === "MODE_VIOLATION",
  );
});
