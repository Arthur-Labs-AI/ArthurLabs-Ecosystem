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

// ---- TASK-0007 follow-up: live streaming contract (voice path) -----------

/**
 * D: Directly invoke the same generateStream() path the voice runtime uses.
 *
 * Voice turns streamed through ConversationService repeatedly failed with
 * MODEL_UNAVAILABLE on real hardware while every non-streaming live test
 * passed. This contract test invokes the provider's streaming API directly
 * with production-shaped configuration (fast reasoning profile, tool
 * schemas, 60 s timeout, bounded retries) and requires at least one
 * assistant text event plus final completion.
 *
 * Diagnostics are failure-safe: only URL path, HTTP status, durations,
 * attempt counts and error NAMES/messages are recorded - never the API key,
 * authorization headers, request payloads, or response bodies.
 */
test(
  "D: live generateStream (voice path) streams assistant text and completes",
  { skip: apiKey ? false : "DEEPSEEK_API_KEY not set; skipping live contract test" },
  async () => {
    let attempts = 0;
    const attemptLog: Array<Record<string, unknown>> = [];
    const instrumentedFetch: typeof fetch = async (url, init) => {
      attempts += 1;
      const started = Date.now();
      try {
        const response = await fetch(url, init);
        attemptLog.push({
          attempt: attempts,
          path: new URL(url instanceof Request ? url.url : String(url)).pathname,
          status: response.status,
          ms: Date.now() - started,
        });
        return response;
      } catch (err) {
        attemptLog.push({
          attempt: attempts,
          path: new URL(url instanceof Request ? url.url : String(url)).pathname,
          error_name: err instanceof Error ? err.name : String(err),
          error_message: err instanceof Error ? err.message : String(err),
          aborted: Boolean(init?.signal?.aborted),
          ms: Date.now() - started,
        });
        throw err;
      }
    };
    const provider = new DeepSeekProvider(liveConfig({ retryMaxAttempts: 3 }), {
      fetchFn: instrumentedFetch,
    });
    // Production voice shape: fast reasoning profile, the canonical tool set
    // exposed by a voice session, 60 s timeout (liveConfig), bounded retries.
    const events: import("../../src/models/contracts").ModelStreamEvent[] = [];
    let text = "";
    let failure: string | undefined;
    try {
      for await (const event of provider.generateStream(
        liveRequest(
          ["system.echo", "harness.status", "harness.create_job", "memory.remember", "memory.search"],
          "Reply with exactly one short sentence: streaming works.",
          { reasoningProfile: "fast" },
        ),
      )) {
        events.push(event);
        if (event.type === "text_delta") text += event.text;
      }
    } catch (err) {
      failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    const diagnostics = JSON.stringify({ attempts, attemptLog, failure, events: events.length, text_chars: text.length });
    assert.ok(!failure, `streaming must not fail; diagnostics=${diagnostics}`);
    assert.ok(
      events.some((e) => e.type === "text_delta" && e.text !== ""),
      `at least one assistant text event is required; diagnostics=${diagnostics}`,
    );
    assert.ok(
      events.some((e) => e.type === "done"),
      `stream must complete with a done event; diagnostics=${diagnostics}`,
    );
    assert.ok(text.trim().length > 0, `streamed text must be non-empty; diagnostics=${diagnostics}`);
  },
);

/**
 * E: Full voice-shaped streaming turn through the app.
 *
 * The voice controller drives ConversationService.streamTurn (controller.ts
 * onFrame -> handleFinalTranscript -> streamTurn with a cancellation-scope
 * signal). That path differs from a raw provider stream: the context builder
 * assembles the system contract, session history, and the FULL session tool
 * registry, and the sanitizer wraps the built request. This test exercises
 * that exact pipeline with the real provider and production settings
 * (60 s timeout, 3 retries). A turn_failed event is a hard failure.
 */
test(
  "E: live voice-shaped streamTurn through the app streams text and completes",
  { skip: apiKey ? false : "DEEPSEEK_API_KEY not set; skipping live contract test" },
  async () => {
    const app = buildApp({
      dbPath: ":memory:",
      modelProvider: "deepseek",
      modelName: model,
      deepseekApiKey: apiKey as string,
      deepseekBaseUrl: baseUrl,
      memoryPersonalDbPath: ":memory:",
      memoryBusinessDbPath: ":memory:",
      embeddingProvider: "fake",
      logLevel: "error",
      modelTimeoutSeconds: 60,
      retryMaxAttempts: 3,
      retryBaseDelayMs: 250,
      approvalTtlSeconds: 300,
    });
    try {
      // Voice.enable() binds an existing session created by a first turn.
      const first = await app.conversation.handleTurn({
        mode: "personal",
        message: "setup",
        client_request_id: `live-e-${Date.now()}-1`,
      });
      const events: Array<Record<string, unknown>> = [];
      let text = "";
      let failed: string | undefined;
      for await (const event of app.conversation.streamTurn({
        mode: "personal",
        message: "Do not call any tools. Answer with plain text only, exactly one short sentence: voice streaming works.",
        session_id: first.session_id,
        client_request_id: `live-e-${Date.now()}-2`,
      })) {
        events.push(event as Record<string, unknown>);
        if ((event as { type?: string }).type === "text_delta") {
          text += (event as { text: string }).text;
        }
        if ((event as { type?: string }).type === "turn_failed") {
          const f = event as { code?: string; message?: string };
          failed = `${f.code}: ${f.message}`;
        }
      }
      const kinds = events.map((e) => e.type).join(",");
      assert.ok(!failed, `voice-shaped streaming must not fail; got ${failed}; events=${kinds}`);
      assert.ok(kinds.includes("turn_started"), `turn_started expected; events=${kinds}`);
      // The voice-path contract is that the streaming turn completes without
      // a model-generation failure. With the full session tool registry the
      // model may legitimately answer with tool calls instead of text; when
      // it answers with text, the text must be non-empty.
      const calledTools = kinds.includes("tool_call");
      if (!calledTools) {
        assert.ok(text.trim().length > 0, `assistant text expected; events=${kinds}`);
      }
      // ConversationService consumes the provider's raw done event and
      // emits its own terminal turn_completed (with usage); the raw done
      // event is asserted at the provider level in test D.
      assert.ok(kinds.includes("turn_completed"), `turn_completed expected; events=${kinds}`);
    } finally {
      app.close();
    }
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