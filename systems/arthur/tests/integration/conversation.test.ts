import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { FakeProvider } from "../../src/models/providers/fake";
import { ProviderTimeoutError } from "../../src/models/contracts";
import type { ModelRequest, ModelResult } from "../../src/models/contracts";
import { argumentsDigest } from "../../src/tools/permissions";
import { buildTestApp, validTurn } from "../helpers";

function result(text: string, tool_calls: ModelResult["tool_calls"] = []): ModelResult {
  return { assistant_text: text, tool_calls, finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } };
}

test("basic chat creates session + turn + model_call records", async () => {
  const app = buildTestApp();
  try {
    const response = await app.conversation.handleTurn(validTurn());
    assert.equal(response.status, "completed");
    assert.equal(response.mode, "personal");
    assert.ok(response.session_id);
    assert.ok(response.turn_id);
    assert.ok(response.trace_id);
    assert.equal(response.display_text, "fake:hello");
    assert.equal(response.model.provider, "fake");

    const modelCalls = app.store.getModelCallsForTurn(response.turn_id);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0]?.provider, "fake");
    assert.ok((modelCalls[0]?.latency_ms ?? 0) >= 0);

    const summary = await app.conversation.getSession(response.session_id);
    assert.equal(summary.mode, "personal");
    assert.ok(summary.turns.some((t) => t.role === "user" && t.text === "hello"));
  } finally {
    app.close();
  }
});

test("existing session continues with correct mode and history", async () => {
  let captured: ModelRequest | undefined;
  const provider = new FakeProvider({
    responder: (req) => {
      captured = req;
      return result("ok");
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const first = await app.conversation.handleTurn(validTurn());
    const second = await app.conversation.handleTurn(
      validTurn({ session_id: first.session_id, message: "second question", client_request_id: "req-2" }),
    );
    assert.equal(second.session_id, first.session_id);
    assert.equal(second.mode, "personal");

    // The follow-up request should include the prior turn's messages in history.
    const roles = captured?.history.map((m) => m.role) ?? [];
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("assistant"));
  } finally {
    app.close();
  }
});

test("retrying with the same client_request_id does not duplicate state", async () => {
  const app = buildTestApp();
  try {
    const first = await app.conversation.handleTurn(validTurn({ client_request_id: "idem-1", message: "hello" }));
    const replay = await app.conversation.handleTurn(validTurn({ client_request_id: "idem-1", message: "hello" }));

    assert.equal(replay.session_id, first.session_id);
    assert.equal(replay.turn_id, first.turn_id);
    assert.equal(replay.display_text, first.display_text);

    const summary = await app.conversation.getSession(first.session_id);
    const userTurns = summary.turns.filter((t) => t.role === "user");
    assert.equal(userTurns.length, 1);
  } finally {
    app.close();
  }
});

test("mode mismatch on an existing session is rejected", async () => {
  const app = buildTestApp();
  try {
    const first = await app.conversation.handleTurn(validTurn({ mode: "personal" }));
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn({ session_id: first.session_id, mode: "business" })),
      (err: unknown) => err instanceof ArthurError && err.code === "MODE_VIOLATION",
    );
  } finally {
    app.close();
  }
});

test("provider timeout returns MODEL_TIMEOUT without corrupting session state", async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 2) throw new ProviderTimeoutError();
      return result(`round-${calls}`);
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const first = await app.conversation.handleTurn(validTurn({ message: "one" }));
    assert.equal(first.display_text, "round-1");

    await assert.rejects(
      () => app.conversation.handleTurn(validTurn({ session_id: first.session_id, message: "two", client_request_id: "req-2" })),
      (err: unknown) => err instanceof ArthurError && err.code === "MODEL_TIMEOUT",
    );

    // Session state remains usable; a retry succeeds.
    const third = await app.conversation.handleTurn(
      validTurn({ session_id: first.session_id, message: "three", client_request_id: "req-3" }),
    );
    assert.equal(third.display_text, "round-3");
    assert.equal(third.session_id, first.session_id);

    const summary = await app.conversation.getSession(first.session_id);
    assert.ok(summary.turns.some((t) => t.role === "assistant" && t.status === "failed"));
  } finally {
    app.close();
  }
});

test("model-proposed system.echo executes and feeds back to the response loop", async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      if (calls === 1) {
        return {
          assistant_text: "",
          tool_calls: [{ id: "call-1", name: "system.echo", arguments: { text: "hello" } }],
          finish_reason: "tool_calls",
        };
      }
      return result("echo complete");
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn());
    assert.equal(response.status, "completed");
    assert.equal(response.display_text, "echo complete");
    const completed = response.tool_calls.filter((t) => t.status === "completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.name, "system.echo");
    assert.equal(completed[0]?.result_summary, "hello");

    const stored = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, "completed");
  } finally {
    app.close();
  }
});

test("unknown tool is rejected without execution", async () => {
  const provider = new FakeProvider({
    responder: () => ({
      assistant_text: "trying something",
      tool_calls: [{ id: "call-1", name: "arbitrary.shell", arguments: { cmd: "rm -rf /" } }],
      finish_reason: "tool_calls",
    }),
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn());
    const rejected = response.tool_calls.filter((t) => t.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.name, "arbitrary.shell");

    const stored = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, "rejected");
  } finally {
    app.close();
  }
});

test("invalid tool arguments are rejected", async () => {
  const provider = new FakeProvider({
    responder: () => ({
      assistant_text: "",
      tool_calls: [{ id: "call-1", name: "system.echo", arguments: { text: 123 } }],
      finish_reason: "tool_calls",
    }),
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn());
    const rejected = response.tool_calls.filter((t) => t.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok((rejected[0]?.result_summary ?? "").includes("invalid arguments"));
  } finally {
    app.close();
  }
});

test("approval-required harness.create_job pauses and executes only on explicit approval", async () => {
  const provider = new FakeProvider({
    responder: () => ({
      assistant_text: "",
      tool_calls: [{ id: "call-1", name: "harness.create_job", arguments: { kind: "deploy" } }],
      finish_reason: "tool_calls",
    }),
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: "business" }));
    assert.equal(response.status, "needs_approval");
    const pending = response.tool_calls.filter((t) => t.status === "pending_approval");
    assert.equal(pending.length, 1);
    const approvalId = pending[0]?.approval_id;
    assert.ok(approvalId);

    // Not executed before approval.
    const stored = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(stored[0]?.status, "pending_approval");

    const outcome = await app.conversation.approve(approvalId as string);
    assert.equal(outcome.status, "approved");
    assert.ok((outcome.result_summary ?? "").includes("job created"));

    // Approval is single-use.
    const again = await app.conversation.approve(approvalId as string);
    assert.equal(again.status, "already_resolved");
  } finally {
    app.close();
  }
});

test("rejecting an approval marks it rejected", async () => {
  const provider = new FakeProvider({
    responder: () => ({
      assistant_text: "",
      tool_calls: [{ id: "call-1", name: "harness.create_job", arguments: { kind: "deploy" } }],
      finish_reason: "tool_calls",
    }),
  });
  const app = buildTestApp({}, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: "business" }));
    const approvalId = response.tool_calls[0]?.approval_id as string;
    const outcome = await app.conversation.reject(approvalId);
    assert.equal(outcome.status, "rejected");
  } finally {
    app.close();
  }
});

test("approving an unknown approval id fails with APPROVAL_INVALID", async () => {
  const app = buildTestApp();
  try {
    await assert.rejects(
      () => app.conversation.approve("does-not-exist"),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_INVALID",
    );
  } finally {
    app.close();
  }
});

test("expired approval is rejected", async () => {
  const app = buildTestApp();
  try {
    const sessionId = "s1";
    const turnId = "t1";
    app.store.createSession(sessionId, "business");
    app.store.createTurn({ id: turnId, sessionId, role: "user", text: "x", traceId: "tr", status: "completed", mode: "business" });
    app.store.createToolCall({
      id: "tc1",
      turnId,
      toolName: "harness.create_job",
      argumentsJson: JSON.stringify({ kind: "deploy" }),
      riskLevel: "approval_required",
      status: "pending_approval",
    });
    app.store.createApproval({
      id: "ap1",
      turnId,
      sessionId,
      toolCallId: "tc1",
      toolName: "harness.create_job",
      argumentsJson: JSON.stringify({ kind: "deploy" }),
      argumentsHash: argumentsDigest({ kind: "deploy" }),
      expiresAt: new Date(Date.now() + 20).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await assert.rejects(
      () => app.conversation.approve("ap1"),
      (err: unknown) => err instanceof ArthurError && err.code === "APPROVAL_INVALID",
    );
  } finally {
    app.close();
  }
});
