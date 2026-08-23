import { test } from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/models/contracts";
import {
  backoffDelay,
  buildDeepSeekPayload,
  isTransientHttpStatus,
  normalizeDeepSeekResponse,
  reasoningParams,
} from "../../src/models/providers/deepseek";
import { ProviderBadResponseError } from "../../src/models/contracts";

function baseRequest(partial: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemContract: "system",
    modeContract: "mode",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "deepseek-chat",
    reasoningProfile: "normal",
    ...partial,
  };
}

test("buildDeepSeekPayload assembles system + mode + user messages", () => {
  const payload = buildDeepSeekPayload(baseRequest(), "deepseek-chat", "normal");
  const messages = payload.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.map((m) => m.role), ["system", "system", "user"]);
  assert.equal(payload.model, "deepseek-chat");
  assert.equal(payload.stream, false);
  assert.equal(payload.tools, undefined);
});

test("buildDeepSeekPayload includes tool schemas in OpenAI format", () => {
  const payload = buildDeepSeekPayload(
    baseRequest({ toolSchemas: [{ name: "system.echo", description: "echo", parameters: { type: "object" } }] }),
    "deepseek-chat",
    "normal",
  );
  const tools = payload.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.type, "function");
  assert.equal(tools[0]?.function.name, "system.echo");
});

test("reasoningParams maps fast/normal/deep", () => {
  assert.deepEqual(reasoningParams("fast"), { temperature: 0, max_tokens: 512 });
  assert.deepEqual(reasoningParams("normal"), { temperature: 0.7 });
  assert.deepEqual(reasoningParams("deep"), { temperature: 0.7, max_tokens: 8192 });
});

test("isTransientHttpStatus recognizes retryable statuses", () => {
  assert.equal(isTransientHttpStatus(429), true);
  assert.equal(isTransientHttpStatus(500), true);
  assert.equal(isTransientHttpStatus(503), true);
  assert.equal(isTransientHttpStatus(401), false);
  assert.equal(isTransientHttpStatus(400), false);
  assert.equal(isTransientHttpStatus(undefined), true);
});

test("backoffDelay grows exponentially and stays positive", () => {
  const d0 = backoffDelay(0, 100);
  const d1 = backoffDelay(1, 100);
  const d2 = backoffDelay(2, 100);
  assert.ok(d0 >= 100);
  assert.ok(d1 >= 200);
  assert.ok(d2 >= 400);
});

test("normalizeDeepSeekResponse normalizes text + usage + tool calls", () => {
  const body = {
    id: "cmpl-1",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "partial",
          tool_calls: [{ id: "tc-1", type: "function", function: { name: "system.echo", arguments: '{"text":"hi"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 } },
  };
  const result = normalizeDeepSeekResponse(body);
  assert.equal(result.assistant_text, "partial");
  assert.equal(result.finish_reason, "tool_calls");
  assert.equal(result.raw_provider_id, "cmpl-1");
  assert.equal(result.usage?.input_tokens, 10);
  assert.equal(result.usage?.output_tokens, 5);
  assert.equal(result.usage?.cached_tokens, 3);
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0]?.name, "system.echo");
  assert.deepEqual(result.tool_calls[0]?.arguments, { text: "hi" });
});

test("normalizeDeepSeekResponse rejects malformed bodies", () => {
  assert.throws(() => normalizeDeepSeekResponse(null), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ choices: [] }), ProviderBadResponseError);
  assert.throws(
    () => normalizeDeepSeekResponse({ choices: [{ message: { tool_calls: [{ function: {} }] } }] }),
    ProviderBadResponseError,
  );
  assert.throws(
    () =>
      normalizeDeepSeekResponse({
        choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "not-json" } }] } }],
      }),
    ProviderBadResponseError,
  );
});
