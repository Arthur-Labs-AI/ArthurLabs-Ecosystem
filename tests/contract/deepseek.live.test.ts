import { test } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../../src/app";
import type { ModelRequest } from "../../src/models/contracts";
import { DeepSeekProvider, DeepSeekProviderConfig } from "../../src/models/providers/deepseek";
import { ApprovalToken, HarnessAdapter, HarnessJob, HarnessJobSpec, HarnessStatus } from "../../src/tools/contracts";
import { HarnessStubAdapter } from "../../src/tools/adapters/harness_stub";

/**
 * Optional live DeepSeek contract tests (spec section 19.3, TASK-0006).
 *
 * Disabled by default; run only when DEEPSEEK_API_KEY is present. Never make
 * the normal unit/integration suite depend on external API availability.
 *
 * TASK-0006 live acceptance: the prior HTTP 400
 *   Invalid 'tools[0].function.name': string does not match pattern
 * must be gone once canonical dotted names are aliased at the provider
 * boundary (system.echo -> system__echo on the wire, restored on the way back).
 */

const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.ARTHUR_MODEL_NAME || "deepseek-chat";
const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

function liveConfig(overrides: Partial<DeepSeekProviderConfig> = {}): DeepSeekProviderConfig {
  return {
    apiKey: apiKey as string,
    model,
    baseUrl,
    timeoutMs: 60000,
    retryMaxAttempts: 1,
    retryBaseDelayMs: 250,
    reasoningProfile: "normal",
    ...overrides,
  };
}

function liveRequest(toolNames: string[], userMessage: string, partial: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemContract: "You are a contract-test assistant. Follow the user's instructions exactly.",
    modeContract: "",
    history: [],
    toolSchemas: toolNames.map((name) => ({
      name,
      description: `Tool ${name} for contract testing.`,
      parameters: {
        type: "object",
        properties:
          name === "system.echo"
            ? { text: { type: "string", description: "Text to echo back." } }
            : name === "harness.create_job"
              ? { kind: { type: "string", description: "Job kind." }, payload: { type: "object" } }
              : {},
        ...(name === "system.echo" ? { required: ["text"] } : {}),
      },
    })),
    userMessage,
    model,
    reasoningProfile: "normal",
    ...partial,
  };
}

test(
  "DeepSeek live provider returns a valid normalized ModelResult",
  { skip: apiKey ? false : "DEEPSEEK_API_KEY not set; skipping live contract test" },
  async () => {
    const provider = new DeepSeekProvider(liveConfig());
    const result = await provider.generate({
      systemContract: "You are a contract-test assistant.",
      modeContract: "",
      history: [],
      toolSchemas: [],
      userMessage: "Reply with exactly the word: pong",
      model,
      reasoningProfile: "normal",
    });

    assert.equal(typeof result.assistant_text, "string");
    assert.ok(result.assistant_text.length > 0);
    assert.ok(Array.isArray(result.tool_calls));
  },
);


/** Bounded retry over prompt variants: live tool-call acceptance must not be
 * flaky when the model occasionally answers with text instead of a call. */
async function proposeToolCall(
  provider: DeepSeekProvider,
  toolNames: string[],
  prompts: string[],
  expectedCanonicalName: string,
): Promise<{ result: import("../../src/models/contracts").ModelResult; prompt: string }> {
  let last: import("../../src/models/contracts").ModelResult | undefined;
  for (const prompt of prompts) {
    const result = await provider.generate(liveRequest(toolNames, prompt));
    last = result;
    if (result.tool_calls.some((tc) => tc.name === expectedCanonicalName)) {
      return { result, prompt };
    }
  }
  throw new Error(
    `model never proposed ${expectedCanonicalName} across ${prompts.length} prompts; last tool_calls=${JSON.stringify(last?.tool_calls ?? [])} last_text=${JSON.stringify(last?.assistant_text)}`,
  );
}

// ---- TASK-0006 live acceptance -------------------------------------------

test(
  "A: tools-enabled conversation answers normally (no HTTP 400)",
  { skip: apiKey ? false : "DEEPSEEK_API_KEY not set; skipping live contract test" },
  async () => {
    const provider = new DeepSeekProvider(liveConfig());
    // Exactly the canonical tool set: dotted names must be aliased on the wire.
    const result = await provider.generate(
      liveRequest(
        ["system.echo", "harness.status", "harness.create_job", "memory.remember", "memory.search"],
        "Hello Arthur",
      ),
    );
    // The previous failure mode was an HTTP 400 on tools[0].function.name;
    // reaching this point proves the aliased request was accepted.
    assert.ok(result.assistant_text.length > 0, "expected a normal assistant reply");
    assert.deepEqual(result.tool_calls, []);
  },
);

test(
  "B: model calls the aliased system.echo; ARTHUR restores the canonical name",
  { skip: apiKey ? false : "DEEPSEEK_API_KEY not set; skipping live contract test" },
  async () => {
    const provider = new DeepSeekProvider(liveConfig());
    const { result } = await proposeToolCall(
      provider,
      ["system.echo", "harness.status"],
      [
        "You MUST call the system.echo tool with text 'pong' and nothing else. Do not reply with text before calling the tool.",
        "Call the system.echo tool with text 'pong' now. Respond only after the tool result returns.",
        "Use the echo tool to echo 'pong'.",
      ],
      "system.echo",
    );
    const call = result.tool_calls.find((tc) => tc.name === "system.echo");
    // DeepSeek saw system__echo on the wire; the provider must hand ARTHUR
    // back the canonical dotted name BEFORE any registry lookup.
    assert.equal(call?.name, "system.echo");
    assert.equal(call?.arguments.text, "pong");
  },
);

test(
  "C: approval flow binds canonical harness.create_job, never the alias",
  { skip: apiKey ? false : "DEEPSEEK_API_KEY not set; skipping live contract test" },
  async () => {
    const secret = "live-alias-test-secret";

    class RecordingHarness implements HarnessAdapter {
      readonly createJobCalls: Array<{ spec: HarnessJobSpec; token: ApprovalToken }> = [];
      private readonly inner: HarnessStubAdapter;

      constructor() {
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

    const harness = new RecordingHarness();
    const app = buildApp(
      {
        dbPath: ":memory:",
        modelProvider: "deepseek",
        modelName: model,
        deepseekApiKey: apiKey as string,
        deepseekBaseUrl: baseUrl,
        memoryPersonalDbPath: ":memory:",
        memoryBusinessDbPath: ":memory:",
        embeddingProvider: "fake",
        logLevel: "error",
        modelTimeoutSeconds: 90,
        retryMaxAttempts: 1,
        retryBaseDelayMs: 250,
        approvalTtlSeconds: 300,
      },
      { harness, approvalSigningSecret: secret },
    );

    try {
      // The app-level turn must end at the approval gate with the canonical
      // name bound to the approval; the harness adapter then verifies the
      // canonical token before dispatching the job.
      let response:
        | import("../../src/core/conversation/models").TurnResponse
        | undefined;
      const prompts = [
        "Create a job on the AI Harness with kind 'deploy' by calling the harness.create_job tool with arguments {\"kind\":\"deploy\"}. You MUST call the tool; do not answer with text.",
        "You must call the harness.create_job tool with kind 'deploy'. Call the tool now, then stop.",
        "Use the harness job tool to create a deploy job.",
      ];
      for (const prompt of prompts) {
        response = await app.conversation.handleTurn({
          mode: "business",
          message: prompt,
          client_request_id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        });
        if (response.status === "needs_approval") break;
        if (response.tool_calls.some((t) => t.status === "pending_approval")) break;
      }

      assert.equal(response?.status, "needs_approval");
      const pending = response?.tool_calls.filter((t) => t.status === "pending_approval") ?? [];
      assert.equal(pending.length, 1, "expected exactly one pending approval");
      // The approval surface must show the canonical name, never the alias.
      assert.equal(pending[0]?.name, "harness.create_job");
      assert.ok(!JSON.stringify(response?.tool_calls).includes("harness__create_job"));
      const approvalId = pending[0]?.approval_id;
      assert.ok(approvalId);

      const approval = app.store.getApproval(approvalId as string);
      assert.equal(approval?.tool_name, "harness.create_job");
      // Canonical arguments are bound to the approval; the model may add an
      // optional empty payload, so only the canonical kind is pinned.
      const approvalArgs = JSON.parse(approval?.arguments_json ?? "{}") as { kind?: string };
      assert.equal(approvalArgs.kind, "deploy");
      assert.ok(!JSON.stringify(approval).includes("harness__create_job"));

      const outcome = await app.conversation.approve(approvalId as string);
      assert.equal(outcome.status, "approved");
      assert.ok((outcome.result_summary ?? "").includes("job created"));

      // The Harness adapter received a token bound to the canonical name.
      assert.equal(harness.createJobCalls.length, 1);
      assert.equal(harness.createJobCalls[0]?.token.tool_name, "harness.create_job");
      assert.ok(!JSON.stringify(harness.createJobCalls[0]?.token).includes("harness__create_job"));
    } finally {
      app.close();
    }
  },
);