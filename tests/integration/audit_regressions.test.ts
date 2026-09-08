import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ArthurError } from "../../src/core/errors/errors";
import { requestHash } from "../../src/core/conversation/validation";
import type { TurnRequest } from "../../src/core/conversation/models";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelResult } from "../../src/models/contracts";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { registerBuiltinTools } from "../../src/tools/builtin";
import type { ApprovalToken, HarnessAdapter, HarnessJob, HarnessJobSpec, HarnessStatus, ToolExecutionContext } from "../../src/tools/contracts";
import { argumentsDigest, PermissionService, signApprovalToken } from "../../src/tools/permissions";
import { ToolRegistry } from "../../src/tools/registry";
import { buildTestApp, validTurn } from "../helpers";

const jobResult = (): ModelResult => ({
  assistant_text: "",
  tool_calls: [{ id: "call", name: "harness.create_job", arguments: { kind: "deploy" } }],
  finish_reason: "tool_calls",
});

async function makePending(app: ReturnType<typeof buildTestApp>): Promise<{ sessionId: string; approvalId: string }> {
  const response = await app.conversation.handleTurn(validTurn({
    mode: "business",
    client_request_id: "pending-" + Math.random(),
  }));
  const approvalId = response.tool_calls[0]?.approval_id;
  assert.ok(approvalId);
  return { sessionId: response.session_id, approvalId };
}

function countHarness(create: (spec: HarnessJobSpec, token: ApprovalToken) => Promise<HarnessJob>): HarnessAdapter {
  return {
    getStatus: async (): Promise<HarnessStatus> => ({ status: "online", version: "test", jobs_active: 0 }),
    createJob: create,
    getJob: async () => { throw new Error("unused"); },
    cancelJob: async () => {},
  };
}

test("approval remains non-retryable across restart when external outcome is unknown", async () => {
  const dataDir = join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  const dir = mkdtempSync(join(dataDir, "approval-crash-"));
  const dbPath = join(dir, "arthur.db");
  const provider = new FakeProvider({ responder: jobResult });
  const signingSecret = "crash-window-signing-secret";
  const firstHarness = new HarnessStubAdapter({ verificationSecret: signingSecret });
  const first = buildTestApp({ dbPath }, { provider, harness: firstHarness, approvalSigningSecret: signingSecret });
  const { approvalId } = await makePending(first);
  assert.equal(first.store.claimApproval(approvalId), true);
  const approval = first.store.getApproval(approvalId);
  assert.ok(approval);
  const unsigned = {
    approval_id: approval.id,
    tool_name: approval.tool_name,
    session_id: approval.session_id,
    turn_id: approval.turn_id,
    arguments_hash: approval.arguments_hash,
    issued_at: new Date().toISOString(),
    expires_at: approval.expires_at,
  };
  const token: ApprovalToken = { ...unsigned, signature: signApprovalToken(unsigned, signingSecret) };
  const external = await firstHarness.createJob(JSON.parse(approval.arguments_json) as HarnessJobSpec, token);
  assert.ok(external.id, "external job was created before the simulated crash");
  // Simulated process crash: close without persisting completeApproval.
  first.close();

  let calls = 0;
  const second = buildTestApp({ dbPath }, {
    provider,
    harness: countHarness(async (spec) => {
      calls += 1;
      return { id: "duplicate", status: "queued", spec };
    }),
  });
  try {
    await assert.rejects(
      () => second.conversation.approve(approvalId),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_INVALID",
    );
    assert.equal(calls, 0);
    assert.equal(second.store.getApproval(approvalId)?.status, "executing");
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval fails closed after its session is deleted", async () => {
  let calls = 0;
  const app = buildTestApp({}, {
    provider: new FakeProvider({ responder: jobResult }),
    harness: countHarness(async (spec) => {
      calls += 1;
      return { id: "job", status: "queued", spec };
    }),
  });
  try {
    const { sessionId, approvalId } = await makePending(app);
    assert.equal(app.store.deleteSession(sessionId), true);
    await assert.rejects(() => app.conversation.approve(approvalId), ArthurError);
    assert.equal(calls, 0);
  } finally { app.close(); }
});

test("approval binds persisted risk as well as tool, turn, and arguments", async () => {
  const app = buildTestApp();
  try {
    app.store.createSession("risk-s", "business");
    app.store.createTurn({ id: "risk-t", sessionId: "risk-s", role: "user", text: "x", traceId: "tr", status: "completed", mode: "business" });
    const args = { kind: "deploy" };
    app.store.createToolCall({ id: "risk-tc", turnId: "risk-t", toolName: "harness.create_job", argumentsJson: JSON.stringify(args), riskLevel: "approval_required", status: "pending_approval" });
    app.store.createApproval({ id: "risk-ap", turnId: "risk-t", sessionId: "risk-s", toolCallId: "risk-tc", toolName: "harness.create_job", argumentsJson: JSON.stringify(args), argumentsHash: argumentsDigest(args), riskLevel: "read", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await assert.rejects(
      () => app.conversation.approve("risk-ap"),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_INVALID",
    );
  } finally { app.close(); }
});

test("mode cannot change while an approved external action is executing", async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = countHarness(async (spec) => {
    started();
    await gate;
    return { id: "job", status: "queued", spec };
  });
  const app = buildTestApp({}, { provider: new FakeProvider({ responder: jobResult }), harness });
  try {
    const { sessionId, approvalId } = await makePending(app);
    const approving = app.conversation.approve(approvalId);
    await startedPromise;
    await assert.rejects(() => app.conversation.changeMode(sessionId, { mode: "personal" }), /while an approval is executing/);
    assert.equal(app.store.getSession(sessionId)?.mode, "business");
    release();
    assert.equal((await approving).status, "approved");
  } finally { app.close(); }
});

test("idempotency key reuse for another session is a conflict", async () => {
  const app = buildTestApp();
  try {
    app.store.createSession("idem-s1", "personal");
    app.store.createSession("idem-s2", "personal");
    await app.conversation.handleTurn(validTurn({ session_id: "idem-s1", client_request_id: "global-key", message: "one" }));
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn({ session_id: "idem-s2", client_request_id: "global-key", message: "one" })),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    assert.equal(app.store.getTurns("idem-s2").length, 0);
  } finally { app.close(); }
});

test("a crashed in-progress idempotency record never re-executes the model", async () => {
  let calls = 0;
  const provider = new FakeProvider({ responder: () => { calls += 1; return { assistant_text: "x", tool_calls: [], finish_reason: "stop" }; } });
  const app = buildTestApp({}, { provider });
  try {
    const req = validTurn({ client_request_id: "crashed-key", message: "do not replay" });
    const key = "request:crashed-key";
    assert.equal(app.store.beginIdempotency(key, "crashed-key", requestHash(req as unknown as TurnRequest), 0).kind, "proceed");
    await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(app.store.beginIdempotency(key, "crashed-key", requestHash(req as unknown as TurnRequest), 0).kind, "failed");
    await assert.rejects(() => app.conversation.handleTurn(req), ArthurError);
    assert.equal(calls, 0);
    assert.equal(app.store.listSessions().length, 0);
  } finally { app.close(); }
});

test("assistant persistence rolls back if idempotency completion cannot commit", () => {
  const app = buildTestApp();
  try {
    app.store.createSession("atomic-s", "personal");
    assert.throws(() => app.store.finalizeIdempotentTurn({
      idempotencyId: "missing",
      assistant: { id: "atomic-a", sessionId: "atomic-s", text: "reply", traceId: "tr", status: "completed", mode: "personal" },
      responseJson: JSON.stringify({ ok: true }),
    }));
    assert.equal(app.store.getTurn("atomic-a"), undefined);
  } finally { app.close(); }
});

test("mode update and boundary marker roll back while a turn is active", () => {
  const app = buildTestApp();
  try {
    app.store.createSession("mode-s", "personal");
    app.store.beginIdempotency("request:active", "active", "hash", 1000);
    app.store.bindIdempotency("request:active", "mode-s", "turn-id");
    assert.throws(() => app.store.changeModeAtomic("mode-s", "business", { id: "marker", text: "boundary", traceId: "tr" }));
    assert.equal(app.store.getSession("mode-s")?.mode, "personal");
    assert.equal(app.store.getTurn("marker"), undefined);
  } finally { app.close(); }
});

test("store boundary redacts direct turn, tool arguments, and long secret results", () => {
  const app = buildTestApp({ deepseekApiKey: "sk-store-secret-123456" });
  try {
    app.store.createSession("secret-s", "personal");
    app.store.createTurn({ id: "secret-t", sessionId: "secret-s", role: "user", text: "sk-store-secret-123456 password=hunter2", traceId: "tr", status: "completed", mode: "personal" });
    app.store.createToolCall({ id: "secret-tc", turnId: "secret-t", toolName: "system.echo", argumentsJson: JSON.stringify({ password: "opaque", text: "sk-store-secret-123456" }), riskLevel: "read", status: "completed", resultSummary: "token=abc123456 " + "x".repeat(1000) });
    const turn = app.store.getTurn("secret-t");
    const tool = app.store.getToolCall("secret-tc");
    assert.ok(!turn?.text.includes("hunter2"));
    assert.ok(!tool?.arguments_json.includes("opaque"));
    assert.ok(!tool?.arguments_json.includes("sk-store-secret-123456"));
    assert.ok((tool?.result_summary?.length ?? 0) < 600);
    assert.ok(!tool?.result_summary?.includes("abc123456"));
  } finally { app.close(); }
});

test("tool exception secrets are redacted before persistence", async () => {
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const harness = countHarness(async () => { throw new Error(`password=hunter2 sk-exception-secret-1234 ${github}`); });
  const app = buildTestApp({ deepseekApiKey: "sk-exception-secret-1234" }, { provider: new FakeProvider({ responder: jobResult }), harness });
  try {
    const { approvalId } = await makePending(app);
    await assert.rejects(() => app.conversation.approve(approvalId));
    const approval = app.store.getApproval(approvalId);
    const call = approval ? app.store.getToolCall(approval.tool_call_id) : undefined;
    assert.ok(call);
    assert.ok(!call.result_summary?.includes("hunter2"));
    assert.ok(!call.result_summary?.includes("sk-exception-secret-1234"));
    assert.ok(!call.result_summary?.includes(github));
  } finally { app.close(); }
});

test("forged approval evidence and high-risk tools fail through the secured facade", async () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new HarnessStubAdapter({ verificationSecret: "real-secret" }));
  let highRiskRan = false;
  registry.register({ name: "danger.tool", version: "1.0.0", description: "danger", input_schema: { type: "object", properties: {}, additionalProperties: false }, risk: "high_risk", allowed_modes: ["business"] }, async () => { highRiskRan = true; return { ok: true, summary: "bad" }; });
  const execution = registry.createExecutionService(new PermissionService());
  const forged: ApprovalToken = { approval_id: "ap", tool_name: "harness.create_job", session_id: "s", turn_id: "t", arguments_hash: argumentsDigest({ kind: "deploy" }), issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), signature: "0".repeat(64) };
  const ctx: ToolExecutionContext = { session_id: "s", turn_id: "t", trace_id: "tr", mode: "business", approved: true, approvalToken: forged };
  // SC-02: the central ToolExecutionService gate rejects a hand-crafted boolean
  // + token shape with NO verified capability before any executor runs.
  // (The legacy HMAC stub check still exists behind the capability boundary.)
  await assert.rejects(
    () => execution.execute("harness.create_job", { kind: "deploy" }, ctx),
    (err: unknown) => err instanceof ArthurError && (err.code === "APPROVAL_REQUIRED" || err.code === "APPROVAL_INVALID" || err.code === "TOOL_EXECUTION_FAILED"),
  );
  // TASK-0010: a high-risk policy rejection (mode IS allowed) is TOOL_PERMISSION_DENIED.
  await assert.rejects(() => execution.execute("danger.tool", {}, { ...ctx, approvalToken: { ...forged, tool_name: "danger.tool" } }), (err: unknown) => err instanceof ArthurError && err.code === "TOOL_PERMISSION_DENIED");
  assert.equal(highRiskRan, false);
});

test("registered security metadata is immutable", () => {
  const registry = new ToolRegistry();
  const definition = { name: "immutable.tool", version: "1.0.0", description: "x", input_schema: { type: "object", properties: {}, additionalProperties: false }, risk: "approval_required" as const, allowed_modes: ["business" as const] };
  registry.register(definition, () => ({ action: "Immutable test action", details: [] }), async () => ({ ok: true, summary: "" }));
  definition.risk = "approval_required";
  const stored = registry.getDefinition("immutable.tool");
  assert.ok(stored);
  assert.throws(() => { (stored.allowed_modes as string[]).push("personal"); });
  assert.deepEqual(stored.allowed_modes, ["business"]);
});
