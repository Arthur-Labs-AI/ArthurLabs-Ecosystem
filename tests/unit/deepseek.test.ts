import { test } from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest } from "../../src/models/contracts";
import { ProviderBadResponseError } from "../../src/models/contracts";
import {
  backoffDelay,
  buildDeepSeekPayload,
  isTransientHttpStatus,
  normalizeDeepSeekResponse,
  reasoningParams,
} from "../../src/models/providers/deepseek";
import { DeepSeekProvider, DeepSeekProviderConfig } from "../../src/models/providers/deepseek";
import {
  encodeProviderName,
  ToolNameAliasCollisionError,
  ToolNameAliasMap,
} from "../../src/models/providers/tool_name_alias";

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

function config(overrides: Partial<DeepSeekProviderConfig> = {}): DeepSeekProviderConfig {
  return {
    apiKey: "sk-test",
    model: "deepseek-chat",
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

const NO_TOOLS_ALIASES = ToolNameAliasMap.fromExposedNames([]);

test("buildDeepSeekPayload assembles system + mode + user messages", () => {
  const payload = buildDeepSeekPayload(baseRequest(), "deepseek-chat", "normal", false, NO_TOOLS_ALIASES);
  const messages = payload.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.map((m) => m.role), ["system", "system", "user"]);
  assert.equal(payload.model, "deepseek-chat");
  assert.equal(payload.stream, false);
  assert.equal(payload.tools, undefined);
});

test("buildDeepSeekPayload aliases tool schemas to DeepSeek-safe names", () => {
  const payload = buildDeepSeekPayload(
    baseRequest({ toolSchemas: [{ name: "system.echo", description: "echo", parameters: { type: "object" } }] }),
    "deepseek-chat",
    "normal",
    false,
    ToolNameAliasMap.fromExposedNames(["system.echo"]),
  );
  const tools = payload.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.type, "function");
  // The provider sees the alias, never the canonical dotted name.
  assert.equal(tools[0]?.function.name, "system__echo");
});

test("outbound tool schemas contain no dots and match the provider pattern", () => {
  const exposed = ["system.echo", "harness.create_job", "harness.get_job", "memory.remember", "memory.search"];
  const aliasMap = ToolNameAliasMap.fromExposedNames(exposed);
  assert.equal(aliasMap.size, 5);
  const payload = buildDeepSeekPayload(
    baseRequest({
      toolSchemas: exposed.map((name) => ({ name, description: "d", parameters: { type: "object" } })),
    }),
    "deepseek-chat",
    "normal",
    false,
    aliasMap,
  );
  const tools = payload.tools as Array<{ function: { name: string } }>;
  assert.equal(tools.length, 5);
  const names = tools.map((t) => t.function.name);
  assert.deepEqual(new Set(names).size, 5, "aliases must be unique");
  for (const name of names) {
    assert.ok(!name.includes("."), `alias must not contain dots: ${name}`);
    assert.match(name, /^[a-zA-Z0-9_-]+$/);
  }
  assert.deepEqual(names.sort(), ["harness__create_job", "harness__get_job", "memory__remember", "memory__search", "system__echo"].sort());
});

test("history tool messages and assistant tool_calls are aliased outbound", () => {
  const aliasMap = ToolNameAliasMap.fromExposedNames(["system.echo"]);
  const payload = buildDeepSeekPayload(
    baseRequest({
      history: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "tc-1", name: "system.echo", arguments: { text: "hi" } }],
        },
        { role: "tool", content: "hi", name: "system.echo", tool_call_id: "tc-1" },
      ],
    }),
    "deepseek-chat",
    "normal",
    false,
    aliasMap,
  );
  const messages = payload.messages as Array<{
    role: string;
    name?: string;
    tool_calls?: Array<{ function: { name: string } }>;
  }>;
  const assistant = messages.find((m) => m.role === "assistant");
  const tool = messages.find((m) => m.role === "tool");
  assert.equal(assistant?.tool_calls?.[0]?.function.name, "system__echo");
  assert.equal(tool?.name, "system__echo");
});

test("inbound non-stream tool call restores the canonical name", async () => {
  const fetchFn: typeof fetch = async () =>
    jsonResponse(200, {
      id: "c-1",
      object: "chat.completion",
      created: 1787514710,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "system__echo", arguments: '{"text":"hi"}' } }],
          },
        },
      ],
    });
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  const result = await provider.generate(
    baseRequest({ toolSchemas: [{ name: "system.echo", description: "echo", parameters: {} }] }),
  );
  assert.equal(result.tool_calls.length, 1);
  assert.equal(result.tool_calls[0]?.name, "system.echo");
  assert.deepEqual(result.tool_calls[0]?.arguments, { text: "hi" });
});

test("unknown provider alias is rejected fail-closed", async () => {
  const fetchFn: typeof fetch = async () =>
    jsonResponse(200, {
      id: "c-1",
      object: "chat.completion",
      created: 1787514710,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "never__exposed", arguments: "{}" } }],
          },
        },
      ],
    });
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    () => provider.generate(baseRequest({ toolSchemas: [{ name: "system.echo", description: "echo", parameters: {} }] })),
    (err: unknown) => err instanceof ProviderBadResponseError,
  );
});

test("a regex-valid alias for a tool NOT exposed in this request is rejected", async () => {
  // system.echo is exposed; system__echo is its alias. The model instead
  // returns memory__remember (regex-valid, but memory.remember was not in the
  // exposed set of THIS request): must fail closed, never execute.
  const fetchFn: typeof fetch = async () =>
    jsonResponse(200, {
      id: "c-1",
      object: "chat.completion",
      created: 1787514710,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "memory__remember", arguments: "{}" } }],
          },
        },
      ],
    });
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    () => provider.generate(baseRequest({ toolSchemas: [{ name: "system.echo", description: "echo", parameters: {} }] })),
    (err: unknown) => err instanceof ProviderBadResponseError,
  );
});

test("alias collision fails closed BEFORE the provider request is sent", async () => {
  // a.b and a__b both encode to a__b: the map must refuse to build, and the
  // provider must never invoke fetch.
  assert.throws(
    () => ToolNameAliasMap.fromExposedNames(["a.b", "a__b"]),
    (err: unknown) => err instanceof ToolNameAliasCollisionError,
  );
  let fetched = false;
  const fetchFn: typeof fetch = async () => {
    fetched = true;
    return jsonResponse(200, {});
  };
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    () =>
      provider.generate(
        baseRequest({
          toolSchemas: [
            { name: "a.b", description: "d", parameters: {} },
            { name: "a__b", description: "d", parameters: {} },
          ],
        }),
      ),
    ToolNameAliasCollisionError,
  );
  assert.equal(fetched, false, "fetch must never be called when aliases collide");
});

test("encodeProviderName is deterministic and reversible in the map", () => {
  assert.equal(encodeProviderName("system.echo"), "system__echo");
  assert.equal(encodeProviderName("harness.create_job"), "harness__create_job");
  assert.equal(encodeProviderName("memory.remember"), "memory__remember");
  assert.equal(encodeProviderName("simple_tool"), "simple_tool");
  assert.equal(encodeProviderName("a.b.c"), "a__b__c");
  const map = ToolNameAliasMap.fromExposedNames(["system.echo", "simple_tool"]);
  assert.equal(map.canonicalToProvider("system.echo"), "system__echo");
  assert.equal(map.providerToCanonical("system__echo"), "system.echo");
  assert.equal(map.canonicalToProvider("simple_tool"), "simple_tool");
  assert.equal(map.providerToCanonical("simple_tool"), "simple_tool");
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
    object: "chat.completion",
    created: 1787514710,
    model: "deepseek-v4-flash",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
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
  // normalizeDeepSeekResponse is a pure parser: it returns the wire name as-is.
  // Alias resolution happens at the provider boundary (generate/generateStream).
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
