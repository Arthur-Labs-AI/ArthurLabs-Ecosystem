import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import type { ModelRequest, ModelResult } from "../../src/models/contracts";
import { DeepSeekProvider, DeepSeekProviderConfig } from "../../src/models/providers/deepseek";
import { ApprovalToken, HarnessAdapter, HarnessJob, HarnessJobSpec, HarnessStatus } from "../../src/tools/contracts";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";
import { buildTestApp, validTurn } from "../helpers";

/**
 * TASK-0006 integration coverage: the DeepSeek provider is the ONLY place
 * tool names are aliased. Everything downstream of the provider boundary
 * (gateway, ConversationService, ToolRegistry lookup, permission evaluation,
 * approval binding, persistence, Harness dispatch) must observe canonical
 * ARTHUR names (system.echo, harness.create_job) and NEVER provider aliases.
 *
 * The provider is real; the HTTP layer is scripted, so the whole conversation
 * path is exercised deterministically against DeepSeek-shaped wire payloads.
 */

function deepseekConfig(): DeepSeekProviderConfig {
  return {
    apiKey: "sk-test",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    timeoutMs: 1000,
    retryMaxAttempts: 0,
    retryBaseDelayMs: 5,
    reasoningProfile: "normal",
  };
}

function completionResponse(
  toolCalls: Array<{ name: string; arguments: string }>,
  text: string | null,
): Response {
  return new Response(
    JSON.stringify({
      id: "c-1",
      object: "chat.completion",
      created: 1787514710,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: text,
            ...(toolCalls.length > 0
              ? {
                  tool_calls: toolCalls.map((tc, i) => ({
                    id: `call_${i}`,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                  })),
                }
              : {}),
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Records exactly what crossed the Harness boundary (approval identity). */
class RecordingHarness implements HarnessAdapter {
  readonly createJobCalls: Array<{ spec: HarnessJobSpec; token: ApprovalToken }> = [];
  private readonly inner: HarnessStubAdapter;

  constructor(secret: string) {
    this.inner = new HarnessStubAdapter({ verificationSecret: secret });
  }

  async getStatus(): Promise<HarnessStatus> {
    return this.inner.getStatus();
  }

  async createJob(spec: HarnessJobSpec, approval: ApprovalToken): Promise<HarnessJob> {
    this.createJobCalls.push({ spec, token: approval });
    return this.inner.createJob(spec, approval);
  }

  async getJob(jobId: string): Promise<HarnessJob> {
    return this.inner.getJob(jobId);
  }

  async cancelJob(jobId: string, approval: ApprovalToken): Promise<void> {
    return this.inner.cancelJob(jobId, approval);
  }
}

test("DeepSeek alias executes as canonical system.echo through the full stack", async () => {
  const bodies: string[] = [];
  let calls = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    calls += 1;
    bodies.push(String(init?.body ?? ""));
    if (calls === 1) {
      // The model proposes the DeepSeek-safe alias.
      return completionResponse([{ name: "system__echo", arguments: '{"text":"hello"}' }], null);
    }
    // Follow-up round after the tool executed.
    return completionResponse([], "echo complete");
  };
  const provider = new DeepSeekProvider(deepseekConfig(), { fetchFn, sleepFn: async () => {} });
  const app = buildTestApp({}, { provider });
  try {
    const turnRequest = validTurn();
    const response = await app.conversation.handleTurn(turnRequest);

    // Outbound wire: only aliased names, never canonical dots.
    const outbound = bodies[0] ?? "";
    assert.ok(outbound.includes("system__echo"), "wire payload must carry the alias");
    assert.ok(!outbound.includes("system.echo"), "wire payload must never carry the canonical dotted name");

    // Follow-up wire (tool result + assistant tool_calls) is aliased too.
    const followup = bodies[1] ?? "";
    assert.ok(followup.includes("system__echo"));
    assert.ok(!followup.includes("system.echo"));

    // Inbound: canonical identity is restored before execution.
    assert.equal(response.status, "completed");
    assert.equal(response.display_text, "echo complete");
    const completed = response.tool_calls.filter((t) => t.status === "completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.name, "system.echo");
    assert.equal(completed[0]?.result_summary, "hello");

    // Persistence: canonical name only.
    const stored = app.store.getToolCallsForTurn(response.turn_id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.tool_name, "system.echo");

    // Idempotency binding: the cached response replays canonical names.
    const replay = await app.conversation.handleTurn(turnRequest);
    assert.equal(replay.status, "completed");
    const replayCompleted = replay.tool_calls.filter((t) => t.status === "completed");
    assert.equal(replayCompleted[0]?.name, "system.echo");
  } finally {
    app.close();
  }
});

test("approval flow binds and executes canonical harness.create_job", async () => {
  const secret = "alias-test-secret";
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    // The model proposes the aliased approval-required tool.
    return completionResponse([{ name: "harness__create_job", arguments: '{"kind":"deploy"}' }], null);
  };
  const provider = new DeepSeekProvider(deepseekConfig(), { fetchFn, sleepFn: async () => {} });
  const harness = new RecordingHarness(secret);
  const app = buildTestApp({}, { provider, harness, approvalSigningSecret: secret });
  try {
    const response = await app.conversation.handleTurn(validTurn({ mode: "business" }));
    assert.equal(response.status, "needs_approval");
    const pending = response.tool_calls.filter((t) => t.status === "pending_approval");
    assert.equal(pending.length, 1);
    // The approval surface shows the CANONICAL name, never the alias.
    assert.equal(pending[0]?.name, "harness.create_job");
    assert.ok(!JSON.stringify(response.tool_calls).includes("harness__create_job"));
    const approvalId = pending[0]?.approval_id;
    assert.ok(approvalId);

    // The persisted approval binds the canonical name.
    const approval = app.store.getApproval(approvalId as string);
    assert.equal(approval?.tool_name, "harness.create_job");
    assert.equal(approval?.arguments_json, '{"kind":"deploy"}');
    assert.ok(!JSON.stringify(approval).includes("harness__create_job"));

    // Approving executes through the Harness adapter with a canonical token.
    const outcome = await app.conversation.approve(approvalId as string);
    assert.equal(outcome.status, "approved");
    assert.ok((outcome.result_summary ?? "").includes("job created"));
    assert.equal(harness.createJobCalls.length, 1);
    assert.equal(harness.createJobCalls[0]?.token.tool_name, "harness.create_job");
    assert.deepEqual(harness.createJobCalls[0]?.spec, { kind: "deploy", payload: undefined });
    assert.ok(!JSON.stringify(harness.createJobCalls[0]?.token).includes("harness__create_job"));
  } finally {
    app.close();
  }
});

test("an alias DeepSeek never exposed fails the turn closed", async () => {
  const fetchFn: typeof fetch = async () =>
    completionResponse([{ name: "never__exposed", arguments: "{}" }], null);
  const provider = new DeepSeekProvider(deepseekConfig(), { fetchFn, sleepFn: async () => {} });
  const app = buildTestApp({}, { provider });
  try {
    // The unknown alias fails closed at the provider boundary: the turn is
    // rejected and the orchestrator never sees a tool call to execute.
    await assert.rejects(
      () => app.conversation.handleTurn(validTurn()),
      (err: unknown) => err instanceof ArthurError && err.code === "MODEL_BAD_RESPONSE",
    );
  } finally {
    app.close();
  }
});

test("internal ModelRequest keeps canonical names; only the wire carries aliases", async () => {
  // Wrap the provider to observe the exact ModelRequest it receives: it must
  // still carry canonical dotted names - aliasing is a wire-only transform.
  class RecordingProvider extends DeepSeekProvider {
    requests: ModelRequest[] = [];
    override async generate(request: ModelRequest): Promise<ModelResult> {
      this.requests.push(request);
      return super.generate(request);
    }
  }
  let wireBody = "";
  const fetchFn: typeof fetch = async (_url, init) => {
    wireBody = String(init?.body ?? "");
    return completionResponse([], "ok");
  };
  const provider = new RecordingProvider(deepseekConfig(), { fetchFn, sleepFn: async () => {} });
  const app = buildTestApp({}, { provider });
  try {
    await app.conversation.handleTurn(validTurn());

    // Internal boundary: canonical names are preserved in the ModelRequest.
    const internalNames = (provider.requests[0]?.toolSchemas ?? []).map((s) => s.name);
    assert.deepEqual(internalNames.sort(), ["harness.status", "system.echo"]);

    // Wire boundary: only aliases, no dots.
    const wireTools = (JSON.parse(wireBody) as { tools: Array<{ function: { name: string } }> }).tools;
    assert.deepEqual(wireTools.map((t) => t.function.name).sort(), ["harness__status", "system__echo"]);
    assert.ok(!wireBody.includes("system.echo"));
    assert.ok(!wireBody.includes("harness.status"));
  } finally {
    app.close();
  }
});