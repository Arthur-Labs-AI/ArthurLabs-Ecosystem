import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { ModelGateway } from "../../src/models/gateway";
import { ProviderBadResponseError, ProviderUnavailableError } from "../../src/models/contracts";
import {
  DeepSeekProvider,
  DeepSeekProviderConfig,
  DeepSeekRequestRejectedError,
  normalizeDeepSeekResponse,
  parseDeepSeekStreamChunk,
  ToolCallAccumulator,
} from "../../src/models/providers/deepseek";
import type { ModelRequest } from "../../src/models/contracts";

// The EXACT real DeepSeek V4 non-stream response captured from the live API
// (same key/model as ARTHUR's failing deployment).
import v4Completion from "../fixtures/deepseek_v4_completion.json";

function baseRequest(): ModelRequest {
  return {
    systemContract: "system",
    modeContract: "mode",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "deepseek-v4-flash",
    reasoningProfile: "normal",
  };
}

function config(overrides: Partial<DeepSeekProviderConfig> = {}): DeepSeekProviderConfig {
  return {
    apiKey: "sk-test",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    timeoutMs: 1000,
    retryMaxAttempts: 0,
    retryBaseDelayMs: 5,
    reasoningProfile: "normal",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---- The exact real response must PASS --------------------------------

test("real DeepSeek V4 non-stream response (exact fixture) normalizes", () => {
  const result = normalizeDeepSeekResponse(v4Completion);
  assert.equal(result.assistant_text, "Hello! How can I assist you today?");
  assert.equal(result.finish_reason, "stop");
  assert.equal(result.raw_provider_id, "97d8c765-9f18-4b1b-8a43-250a78e71a42");
  assert.deepEqual(result.tool_calls, []);
  assert.equal(result.usage?.input_tokens, 6);
  assert.equal(result.usage?.output_tokens, 9);
  assert.equal(result.usage?.total_tokens, 15);
  // prompt_tokens_details.cached_tokens is folded into cached_tokens.
  assert.equal(result.usage?.cached_tokens, 0);
});

test("fixture additive metadata is tolerated (system_fingerprint, cache detail fields)", () => {
  // The fixture already carries system_fingerprint, prompt_tokens_details,
  // prompt_cache_hit_tokens and prompt_cache_miss_tokens; it must parse.
  const result = normalizeDeepSeekResponse(v4Completion);
  assert.equal(result.assistant_text, "Hello! How can I assist you today?");
});

test("unknown additive top-level fields never fail validation", () => {
  const body = {
    ...v4Completion,
    future_top_level_meta: { anything: [1, 2, 3] },
    another_future_flag: "x",
  };
  const result = normalizeDeepSeekResponse(body);
  assert.equal(result.assistant_text, "Hello! How can I assist you today?");
});

test("unknown additive usage fields never fail validation", () => {
  const body = {
    ...v4Completion,
    usage: {
      ...v4Completion.usage,
      completion_tokens_details: { reasoning_tokens: 3 },
      future_usage_meta: { nested: true },
    },
  };
  const result = normalizeDeepSeekResponse(body);
  assert.equal(result.usage?.output_tokens, 9);
  assert.equal(result.usage?.total_tokens, 15);
});

test("logprobs null is accepted; logprobs object is accepted; non-object logprobs rejected", () => {
  assert.equal(normalizeDeepSeekResponse(v4Completion).assistant_text, "Hello! How can I assist you today?");
  const withObject = {
    ...v4Completion,
    choices: [{ ...v4Completion.choices[0], logprobs: { tokens: ["a"], token_logprobs: [-0.5] } }],
  };
  assert.equal(normalizeDeepSeekResponse(withObject).assistant_text, "Hello! How can I assist you today?");
  const withBad = {
    ...v4Completion,
    choices: [{ ...v4Completion.choices[0], logprobs: "nope" }],
  };
  assert.throws(() => normalizeDeepSeekResponse(withBad), ProviderBadResponseError);
});

test("reasoning_content is tolerated but NEVER becomes assistant text", () => {
  const body = {
    ...v4Completion,
    choices: [
      {
        ...v4Completion.choices[0],
        message: {
          role: "assistant",
          content: "Visible answer",
          reasoning_content: "Internal chain of thought that must never leak",
        },
      },
    ],
  };
  const result = normalizeDeepSeekResponse(body);
  assert.equal(result.assistant_text, "Visible answer");
  assert.ok(!result.assistant_text.includes("Internal chain"));
  assert.ok(!JSON.stringify(result).includes("Internal chain of thought"));
});

test("reasoning_content null is accepted; non-string reasoning_content rejected", () => {
  const bodyNull = {
    ...v4Completion,
    choices: [{ ...v4Completion.choices[0], message: { role: "assistant", content: "x", reasoning_content: null } }],
  };
  assert.equal(normalizeDeepSeekResponse(bodyNull).assistant_text, "x");
  const bodyBad = {
    ...v4Completion,
    choices: [{ ...v4Completion.choices[0], message: { role: "assistant", content: "x", reasoning_content: 42 } }],
  };
  assert.throws(() => normalizeDeepSeekResponse(bodyBad), ProviderBadResponseError);
});

test("content null with tool_calls is accepted and yields the tool calls only", () => {
  const body = {
    ...v4Completion,
    choices: [
      {
        ...v4Completion.choices[0],
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "system.echo", arguments: '{"text":"hi"}' } },
          ],
        },
      },
    ],
  };
  const result = normalizeDeepSeekResponse(body);
  assert.equal(result.assistant_text, "");
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0]?.name, "system.echo");
  assert.deepEqual(result.tool_calls[0]?.arguments, { text: "hi" });
});

test("content null WITHOUT tool_calls is rejected", () => {
  const body = {
    ...v4Completion,
    choices: [{ ...v4Completion.choices[0], message: { role: "assistant", content: null } }],
  };
  assert.throws(() => normalizeDeepSeekResponse(body), ProviderBadResponseError);
});

// ---- Required subset is enforced (malformed responses rejected) --------

test("malformed: missing choices rejected", () => {
  assert.throws(() => normalizeDeepSeekResponse({ ...v4Completion, choices: undefined }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ ...v4Completion, choices: [] }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ ...v4Completion, choices: "nope" }), ProviderBadResponseError);
});

test("malformed: missing/wrong id, object, created, model rejected", () => {
  assert.throws(() => normalizeDeepSeekResponse({ ...v4Completion, id: 42 }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ ...v4Completion, object: undefined }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ ...v4Completion, created: "now" }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ ...v4Completion, model: undefined }), ProviderBadResponseError);
});

test("malformed: message rejected (missing, not object, wrong role)", () => {
  assert.throws(
    () => normalizeDeepSeekResponse({ ...v4Completion, choices: [{ ...v4Completion.choices[0], message: null }] }),
    ProviderBadResponseError,
  );
  assert.throws(
    () => normalizeDeepSeekResponse({ ...v4Completion, choices: [{ ...v4Completion.choices[0], message: { content: "x" } }] }),
    ProviderBadResponseError,
  );
  assert.throws(
    () =>
      normalizeDeepSeekResponse({
        ...v4Completion,
        choices: [{ ...v4Completion.choices[0], message: { role: "user", content: "x" } }],
      }),
    ProviderBadResponseError,
  );
});

test("malformed: content type rejected", () => {
  assert.throws(
    () => normalizeDeepSeekResponse({ ...v4Completion, choices: [{ ...v4Completion.choices[0], message: { role: "assistant", content: 123 } }] }),
    ProviderBadResponseError,
  );
  assert.throws(
    () =>
      normalizeDeepSeekResponse({
        ...v4Completion,
        choices: [{ ...v4Completion.choices[0], message: { role: "assistant", content: ["a"] } }],
      }),
    ProviderBadResponseError,
  );
});

test("malformed: missing content rejected", () => {
  assert.throws(
    () => normalizeDeepSeekResponse({ ...v4Completion, choices: [{ ...v4Completion.choices[0], message: { role: "assistant" } }] }),
    ProviderBadResponseError,
  );
});

test("malformed: bad index / missing finish_reason / bad usage rejected", () => {
  assert.throws(
    () => normalizeDeepSeekResponse({ ...v4Completion, choices: [{ ...v4Completion.choices[0], index: -1 }] }),
    ProviderBadResponseError,
  );
  const noFinish = { ...v4Completion, choices: [{ ...v4Completion.choices[0], finish_reason: undefined }] };
  assert.throws(() => normalizeDeepSeekResponse(noFinish), ProviderBadResponseError);
  assert.throws(
    () => normalizeDeepSeekResponse({ ...v4Completion, usage: { prompt_tokens: 6 } }),
    ProviderBadResponseError,
  );
});

// ---- HTTP non-2xx responses are classified, never MODEL_BAD_RESPONSE ----

test("HTTP 400 is parsed and classified as request-rejected, NOT MODEL_BAD_RESPONSE", async () => {
  const fetchFn: typeof fetch = async () =>
    jsonResponse(400, {
      error: {
        message: "Invalid 'tools[0].function.name': string does not match pattern.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
      },
    });
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    () => provider.generate(baseRequest()),
    (err: unknown) => err instanceof DeepSeekRequestRejectedError && !(err instanceof ProviderBadResponseError),
  );
});

test("HTTP error detail is sanitized (secrets never leak into the error)", async () => {
  const secret = "sk-live-secret-abcdef123456";
  const fetchFn: typeof fetch = async () =>
    jsonResponse(400, { error: { message: `bad key ${secret} here` } });
  const provider = new DeepSeekProvider(config({ apiKey: secret }), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    () => provider.generate(baseRequest()),
    (err: unknown) => err instanceof DeepSeekRequestRejectedError && !String(err.message).includes(secret),
  );
});

test("gateway maps HTTP 400 to MODEL_UNAVAILABLE, never MODEL_BAD_RESPONSE", async () => {
  const fetchFn: typeof fetch = async () => jsonResponse(422, { error: { message: "bad body" } });
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  const gateway = new ModelGateway(provider);
  await assert.rejects(
    () => gateway.generate(baseRequest()),
    (err: unknown) => err instanceof ArthurError && err.code === "MODEL_UNAVAILABLE",
  );
});

test("HTTP 401 still maps to auth failure (not bad response)", async () => {
  const fetchFn: typeof fetch = async () => jsonResponse(401, { error: { message: "Authentication Fails" } });
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  const gateway = new ModelGateway(provider);
  await assert.rejects(
    () => gateway.generate(baseRequest()),
    (err: unknown) => err instanceof ArthurError && err.code === "MODEL_UNAVAILABLE",
  );
});

// ---- Streaming V4 parser: additive-schema tolerance (no redesign) ------

test("stream chunk tolerates additive top-level and usage fields", () => {
  const accumulators = new Map<number, ToolCallAccumulator>();
  const events = parseDeepSeekStreamChunk(
    {
      id: "chunk-1",
      object: "chat.completion.chunk",
      created: 1787514710,
      model: "deepseek-v4-flash",
      system_fingerprint: "a26a7955944dc5c60445bff77fac9c8e",
      future_chunk_meta: { x: 1 },
      choices: [{ index: 0, delta: { content: "hel" }, logprobs: null }],
      usage: {
        prompt_tokens: 6,
        completion_tokens: 9,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 3 },
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 6,
        future_usage_meta: true,
      },
    },
    accumulators,
  );
  assert.ok(events);
  assert.ok(events.some((e) => e.type === "text_delta" && e.text === "hel"));
  assert.ok(events.some((e) => e.type === "usage" && e.usage.total_tokens === 15));
});

test("stream chunk reasoning_content delta never becomes assistant text", () => {
  const accumulators = new Map<number, ToolCallAccumulator>();
  const events = parseDeepSeekStreamChunk(
    {
      choices: [{ index: 0, delta: { reasoning_content: "internal reasoning only", content: "" } }],
    },
    accumulators,
  );
  // No speakable text: reasoning deltas must not surface as text_delta.
  assert.equal(events, null);
});
