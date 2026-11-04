import { test } from "node:test";
import assert from "node:assert/strict";

import { startServer } from "../../apps/api/server";
import { FakeProvider } from "../../src/models/providers/fake";
import type { HarnessAdapter } from "../../src/tools/contracts";
import { buildTestApp, validTurn } from "../helpers";

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("HTTP API serves health, status, turns, sessions, mode change, and errors", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;

  try {
    // Health (no secrets).
    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(health.status, "ok");
    assert.equal(health.model_provider, "fake");
    assert.equal(JSON.stringify(health).includes("api_key"), false);

    // Status.
    const status = (await (await fetch(`${base}/v1/status`)).json()) as Record<string, unknown>;
    assert.equal(status.provider, "fake");

    // Create turn.
    const turn = (await (await postJson(`${base}/v1/turns`, validTurn())).json()) as Record<string, unknown>;
    assert.equal(turn.status, "completed");
    const sessionId = turn.session_id as string;

    // Read session history.
    const session = (await (await fetch(`${base}/v1/sessions/${sessionId}`)).json()) as { turns: unknown[] };
    assert.ok(session.turns.length >= 2);

    // Change mode.
    const mode = (await (await postJson(`${base}/v1/sessions/${sessionId}/mode`, { mode: "business" })).json()) as {
      to: string;
    };
    assert.equal(mode.to, "business");

    // Validation error is a stable machine-readable code.
    const badTurn = await postJson(`${base}/v1/turns`, { mode: "personal", message: "hi" });
    assert.equal(badTurn.status, 400);
    const badBody = (await badTurn.json()) as { error: { code: string } };
    assert.equal(badBody.error.code, "INVALID_REQUEST");

    // Unknown session -> 404 SESSION_NOT_FOUND.
    const notFound = await fetch(`${base}/v1/sessions/nope`);
    assert.equal(notFound.status, 404);
    const notFoundBody = (await notFound.json()) as { error: { code: string } };
    assert.equal(notFoundBody.error.code, "SESSION_NOT_FOUND");

    // Unknown route.
    const missing = await fetch(`${base}/v1/nope`);
    assert.equal(missing.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

test("HTTP approval and rejection routes preserve secured execution", async () => {
  const provider = new FakeProvider({ responder: () => ({ assistant_text: "", tool_calls: [{ id: "call", name: "harness.create_job", arguments: { kind: "deploy" } }], finish_reason: "tool_calls" }) });
  const app = buildTestApp({}, { provider });
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const first = (await (await postJson(`${base}/v1/turns`, validTurn({ mode: "business", client_request_id: "api-approve" }))).json()) as { tool_calls: Array<{ approval_id?: string }> };
    const approveId = first.tool_calls[0]?.approval_id;
    assert.ok(approveId);
    const approved = await fetch(`${base}/v1/approvals/${approveId}/approve`, { method: "POST" });
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as { status: string }).status, "approved");

    const second = (await (await postJson(`${base}/v1/turns`, validTurn({ mode: "business", client_request_id: "api-reject" }))).json()) as { tool_calls: Array<{ approval_id?: string }> };
    const rejectId = second.tool_calls[0]?.approval_id;
    assert.ok(rejectId);
    const rejected = await fetch(`${base}/v1/approvals/${rejectId}/reject`, { method: "POST" });
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { status: string }).status, "rejected");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});



test("HTTP enforces JSON media types strict bodies and route identifiers", async () => {
  const app = buildTestApp();
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const plain = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(validTurn()),
    });
    assert.equal(plain.status, 415);
    assert.equal(((await plain.json()) as { error: { code: string } }).error.code, "UNSUPPORTED_MEDIA_TYPE");

    const missing = await fetch(`${base}/v1/turns`, { method: "POST" });
    assert.equal(missing.status, 415);

    const charset = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(validTurn({ client_request_id: "charset-json" })),
    });
    assert.equal(charset.status, 200);

    const strict = await postJson(`${base}/v1/turns`, validTurn({ unexpected: true }));
    assert.equal(strict.status, 400);
    assert.equal(((await strict.json()) as { error: { code: string } }).error.code, "INVALID_REQUEST");

    const nestedStrict = await postJson(`${base}/v1/turns`, validTurn({ metadata: { client_type: "web", extra: true } }));
    assert.equal(nestedStrict.status, 400);

    const oversized = "a".repeat(129);
    for (const url of [
      `${base}/v1/sessions/${oversized}`,
      `${base}/v1/approvals/${oversized}/approve`,
      `${base}/v1/approvals/%00bad/reject`,
    ]) {
      const response = await fetch(url, { method: url.includes("approvals") ? "POST" : "GET" });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "INVALID_REQUEST");
    }

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

test("HTTP public errors redact configured and generic credentials", async () => {
  const configured = "configured-secret-value-987";
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const provider = new FakeProvider({ responder: () => { throw new Error(`provider ${configured} ${github}`); } });
  const app = buildTestApp({ deepseekApiKey: configured }, { provider });
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const sessionError = await fetch(`${base}/v1/sessions/${configured}`);
    const sessionText = await sessionError.text();
    assert.equal(sessionError.status, 404);
    assert.ok(!sessionText.includes(configured));
    assert.ok(!sessionText.includes("stack"));

    const first = await postJson(`${base}/v1/turns`, validTurn({ client_request_id: github, message: "one" }));
    assert.equal(first.status, 503);
    const providerText = await first.text();
    assert.ok(!providerText.includes(configured));
    assert.ok(!providerText.includes(github));

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});



test("HTTP tool errors are sanitized before response logs and persistence", async () => {
  const configured = "tool-configured-secret-987";
  const github = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const provider = new FakeProvider({ responder: () => ({
    assistant_text: "",
    tool_calls: [{ id: "call", name: "harness.create_job", arguments: { kind: "deploy" } }],
    finish_reason: "tool_calls",
  }) });
  const harness: HarnessAdapter = {
    getStatus: async () => ({ status: "online", version: "test", jobs_active: 0 }),
    createJob: async () => { throw new Error(`tool ${configured} ${github} password=hunter2`); },
    getJob: async () => { throw new Error("unused"); },
    cancelJob: async () => {},
  };
  const app = buildTestApp({ deepseekApiKey: configured }, { provider, harness });
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const pending = await postJson(`${base}/v1/turns`, validTurn({ mode: "business", client_request_id: "tool-error-http" }));
    const approvalId = ((await pending.json()) as { tool_calls: Array<{ approval_id?: string }> }).tool_calls[0]?.approval_id;
    assert.ok(approvalId);
    const failed = await fetch(`${base}/v1/approvals/${approvalId}/approve`, { method: "POST" });
    const responseText = await failed.text();
    assert.equal(failed.status, 500);
    assert.ok(!responseText.includes(configured));
    assert.ok(!responseText.includes(github));
    assert.ok(!responseText.includes("hunter2"));
    assert.ok(!responseText.includes("stack"));

    const approval = app.store.getApproval(approvalId);
    const toolCall = approval ? app.store.getToolCall(approval.tool_call_id) : undefined;
    const persisted = toolCall?.result_summary ?? "";
    assert.ok(!persisted.includes(configured));
    assert.ok(!persisted.includes(github));
    assert.ok(!persisted.includes("hunter2"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

test("HTTP session and turn responses never serialize pasted credentials", async () => {
  const secret = "sk-http-secret-123456";
  const provider = new FakeProvider({ responder: (request) => ({ assistant_text: request.userMessage, tool_calls: [], finish_reason: "stop" }) });
  const app = buildTestApp({ deepseekApiKey: secret }, { provider });
  const { server, port } = await startServer(app, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const turnResponse = await postJson(`${base}/v1/turns`, validTurn({ message: `DEEPSEEK_API_KEY=${secret} password=hunter2`, client_request_id: "api-secret" }));
    const turnText = await turnResponse.text();
    assert.ok(!turnText.includes(secret));
    assert.ok(!turnText.includes("hunter2"));
    const turn = JSON.parse(turnText) as { session_id: string };
    const sessionText = await (await fetch(`${base}/v1/sessions/${turn.session_id}`)).text();
    assert.ok(!sessionText.includes(secret));
    assert.ok(!sessionText.includes("hunter2"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});
