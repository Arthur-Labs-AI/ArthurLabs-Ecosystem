import { test } from "node:test";
import assert from "node:assert/strict";

import { ModelRequest, ModelStreamEvent } from "../../src/models/contracts";
import {
  ProviderAuthError,
  ProviderBadResponseError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "../../src/models/contracts";
import {
  DeepSeekProvider,
  DeepSeekProviderConfig,
  MAX_ASSISTANT_TEXT_CHARS,
  MAX_RESPONSE_BYTES,
  MAX_TOOL_CALLS,
  normalizeDeepSeekResponse,
  readBodyWithLimit,
} from "../../src/models/providers/deepseek";

function baseRequest(): ModelRequest {
  return {
    systemContract: "system",
    modeContract: "mode",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "deepseek-chat",
    reasoningProfile: "normal",
  };
}

function config(overrides: Partial<DeepSeekProviderConfig> = {}): DeepSeekProviderConfig {
  return {
    apiKey: "sk-test",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    timeoutMs: 1000,
    retryMaxAttempts: 1,
    retryBaseDelayMs: 5,
    reasoningProfile: "normal",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OK_BODY = {
  id: "c-1",
  object: "chat.completion",
  created: 1787514710,
  model: "deepseek-v4-flash",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
};

test("retries transient 5xx with backoff then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    if (calls <= 2) return jsonResponse(500, { error: "boom" });
    return jsonResponse(200, OK_BODY);
  };
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 2 }), {
    fetchFn,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await provider.generate(baseRequest());
  assert.equal(result.assistant_text, "hi");
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] !== undefined && sleeps[1] >= sleeps[0]!);
});

test("401 maps to ProviderAuthError without retry", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(401, { error: "unauthorized" });
  };
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(() => provider.generate(baseRequest()), ProviderAuthError);
  assert.equal(calls, 1);
});

test("non-retryable 400 maps to request-rejected (NOT ProviderBadResponseError) without retry", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(400, { error: { message: "invalid request" } });
  };
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    () => provider.generate(baseRequest()),
    (err: unknown) =>
      err instanceof ProviderUnavailableError && !(err instanceof ProviderBadResponseError),
  );
  assert.equal(calls, 1);
});

test("timeout maps to ProviderTimeoutError", async () => {
  const fetchFn: typeof fetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }
    });
  const provider = new DeepSeekProvider(config({ timeoutMs: 30, retryMaxAttempts: 0 }), { fetchFn });
  await assert.rejects(() => provider.generate(baseRequest()), ProviderTimeoutError);
});

test("oversized response body is rejected", async () => {
  const fetchFn: typeof fetch = async () =>
    new Response("x", { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } });
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(() => provider.generate(baseRequest()), ProviderBadResponseError);
});

test("readBodyWithLimit rejects oversized declared bodies", async () => {
  const big = new Response("a".repeat(100), { headers: { "content-length": "101" } });
  await assert.rejects(() => readBodyWithLimit(big, 50), ProviderBadResponseError);
  const small = new Response(JSON.stringify({ ok: true }));
  const text = await readBodyWithLimit(small, 1024);
  assert.ok(text.includes("ok"));
});

test("normalizeDeepSeekResponse rejects empty choices and non-string content", () => {
  assert.throws(() => normalizeDeepSeekResponse({ choices: [{}] }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ choices: [{ message: { content: 123 } }] }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ choices: [{ message: {} }] }), ProviderBadResponseError);
  assert.throws(() => normalizeDeepSeekResponse({ choices: [{ message: { tool_calls: "nope" } }] }), ProviderBadResponseError);
});

test("generate places authentication only in the header and sanitizes provider payloads", async () => {
  let observedHeaders: Headers | undefined;
  let observedBody = "";
  const fetchFn: typeof fetch = async (_url, init) => {
    observedHeaders = new Headers(init?.headers);
    observedBody = String(init?.body ?? "");
    return jsonResponse(200, OK_BODY);
  };
  const provider = new DeepSeekProvider(config({ apiKey: "sk-provider-secret-123456", retryMaxAttempts: 0 }), { fetchFn });
  await provider.generate({ ...baseRequest(), userMessage: "DEEPSEEK_API_KEY=sk-provider-secret-123456 password=hunter2" });
  assert.equal(observedHeaders?.get("authorization"), "Bearer sk-provider-secret-123456");
  assert.equal(observedHeaders?.get("content-type"), "application/json");
  assert.ok(!observedBody.includes("sk-provider-secret-123456"));
  assert.ok(!observedBody.includes("hunter2"));
  assert.ok(observedBody.includes("[REDACTED]"));
});

test("normalization rejects malformed nested provider values as bad responses", () => {
  const malformed: unknown[] = [
    { choices: [null] },
    { choices: [{ message: null }] },
    { id: 42, choices: [{ message: { content: "ok" } }] },
    { choices: [{ finish_reason: 42, message: { content: "ok" } }] },
    { choices: [{ message: { tool_calls: [null] } }] },
    { choices: [{ message: { tool_calls: [{ type: "other", function: { name: "x", arguments: "{}" } }] } }] },
    { choices: [{ message: { tool_calls: [{ id: 12, function: { name: "x", arguments: "{}" } }] } }] },
    { choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: 12 } }] } }] },
  ];
  for (const body of malformed) assert.throws(() => normalizeDeepSeekResponse(body), ProviderBadResponseError);
});

test("normalization validates usage counts strictly", () => {
  for (const usage of [
    { prompt_tokens: -1 },
    { completion_tokens: 1.5 },
    { total_tokens: Number.POSITIVE_INFINITY },
    { prompt_tokens: "1" },
    { prompt_tokens_details: "bad" },
    { prompt_tokens_details: { cached_tokens: -2 } },
  ]) {
    assert.throws(
      () => normalizeDeepSeekResponse({ choices: [{ message: { content: "ok" } }], usage }),
      ProviderBadResponseError,
    );
  }
});

test("normalization bounds assistant text, tool count, and identifiers", () => {
  assert.throws(
    () => normalizeDeepSeekResponse({ choices: [{ message: { content: "x".repeat(MAX_ASSISTANT_TEXT_CHARS + 1) } }] }),
    ProviderBadResponseError,
  );
  const calls = Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, i) => ({ id: "id-" + i, type: "function", function: { name: "x", arguments: "{}" } }));
  assert.throws(() => normalizeDeepSeekResponse({ choices: [{ message: { tool_calls: calls } }] }), ProviderBadResponseError);
  assert.throws(
    () => normalizeDeepSeekResponse({ choices: [{ message: { tool_calls: [{ id: "x".repeat(300), function: { name: "x", arguments: "{}" } }] } }] }),
    ProviderBadResponseError,
  );
  assert.throws(
    () => normalizeDeepSeekResponse({ choices: [{ message: { tool_calls: [{ id: "id", function: { name: "x".repeat(300), arguments: "{}" } }] } }] }),
    ProviderBadResponseError,
  );
});

test("streaming response limit rejects actual bytes without a content-length header", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
      controller.enqueue(new TextEncoder().encode("67890"));
      controller.close();
    },
  });
  const response = new Response(stream);
  await assert.rejects(() => readBodyWithLimit(response, 8), ProviderBadResponseError);
});

test("network failures exhaust exactly the bounded retry budget", async () => {
  let calls = 0;
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 2 }), {
    fetchFn: async () => { calls += 1; throw new Error("network down"); },
    sleepFn: async () => {},
  });
  await assert.rejects(() => provider.generate(baseRequest()));
  assert.equal(calls, 3);
});

// ---- TASK-0006: streaming tool name aliasing -----------------------------

function sseResponse(...dataLines: string[]): Response {
  const body = dataLines.map((d) => `data: ${d}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("streaming: payload sent to the provider uses aliased tool names only", async () => {
  let observedBody = "";
  const fetchFn: typeof fetch = async (_url, init) => {
    observedBody = String(init?.body ?? "");
    return sseResponse(
      JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      "[DONE]",
    );
  };
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  const events: ModelStreamEvent[] = [];
  for await (const e of provider.generateStream(
    { ...baseRequest(), toolSchemas: [{ name: "system.echo", description: "echo", parameters: {} }] },
  )) {
    events.push(e);
  }
  assert.ok(events.some((e) => e.type === "done"));
  const parsed = JSON.parse(observedBody) as { tools: Array<{ function: { name: string } }> };
  assert.equal(parsed.tools[0]?.function.name, "system__echo");
  assert.ok(!parsed.tools[0]?.function.name.includes("."));
  assert.ok(!observedBody.includes("system.echo"));
});

test("streaming: fragmented tool-call name resolves to canonical at completion", async () => {
  const fetchFn: typeof fetch = async () =>
    sseResponse(
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "system__", arguments: "" } }] } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "echo", arguments: "{\"text\":\"hi\"}" } }] } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }] }),
      "[DONE]",
    );
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  const toolCalls: ModelStreamEvent[] = [];
  for await (const e of provider.generateStream(
    { ...baseRequest(), toolSchemas: [{ name: "system.echo", description: "echo", parameters: {} }] },
  )) {
    if (e.type === "tool_call") toolCalls.push(e);
  }
  // The last tool_call event per call id is the complete, resolved call.
  const finalCall = toolCalls[toolCalls.length - 1];
  assert.ok(finalCall && finalCall.type === "tool_call");
  assert.equal(finalCall.call.name, "system.echo");
  assert.deepEqual(finalCall.call.arguments, { text: "hi" });
});

// ---- TASK-0007: streaming retry hardening --------------------------------

test("streaming: transient network failure before stream data is retried", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    return sseResponse(
      JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      "[DONE]",
    );
  };
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 2 }), {
    fetchFn,
    sleepFn: async () => {},
  });
  const events: ModelStreamEvent[] = [];
  for await (const e of provider.generateStream(baseRequest())) events.push(e);
  assert.equal(calls, 2);
  assert.ok(events.some((e) => e.type === "text_delta" && e.text === "ok"));
  assert.ok(events.some((e) => e.type === "done"));
});

test("streaming: timeout before stream data is retried with a fresh timeout per attempt", async () => {
  let calls = 0;
  const observedSignals: AbortSignal[] = [];
  const fetchFn: typeof fetch = (_url, init) => {
    calls += 1;
    const signal = init?.signal;
    observedSignals.push(signal as AbortSignal);
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    }
    // A retry attempt must receive a FRESH controller: the shared-controller
    // bug reuses an already-aborted signal, which fails this attempt instantly.
    assert.equal(signal?.aborted, false, "retry attempt must receive a fresh, non-aborted controller");
    return new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(sseResponse(
          JSON.stringify({ choices: [{ index: 0, delta: { content: "recovered" } }] }),
          "[DONE]",
        ));
      }, 25);
    });
  };
  const provider = new DeepSeekProvider(
    config({ timeoutMs: 50, retryMaxAttempts: 2, retryBaseDelayMs: 5 }),
    { fetchFn, sleepFn: async () => {} },
  );
  const events: ModelStreamEvent[] = [];
  for await (const e of provider.generateStream(baseRequest())) events.push(e);
  assert.equal(calls, 2, "a pre-data timeout must be retried within the bounded budget");
  assert.ok(observedSignals[0]?.aborted, "the first attempt's timeout must have fired");
  assert.ok(events.some((e) => e.type === "text_delta" && e.text === "recovered"));
});

test("streaming: caller abort does not retry", async () => {
  let calls = 0;
  const caller = new AbortController();
  const fetchFn: typeof fetch = (_url, init) => {
    calls += 1;
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  };
  const provider = new DeepSeekProvider(config({ timeoutMs: 5000, retryMaxAttempts: 3 }), {
    fetchFn,
    sleepFn: async () => {},
  });
  const consumed = (async () => {
    for await (const _e of provider.generateStream(baseRequest(), caller.signal)) {
      void _e;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  caller.abort();
  await consumed;
  assert.equal(calls, 1, "caller cancellation must never trigger a retry");
});

test("streaming: 401 does not retry", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(401, { error: { message: "unauthorized" } });
  };
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 3 }), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    (async () => {
      for await (const _e of provider.generateStream(baseRequest())) void _e;
    })(),
    ProviderAuthError,
  );
  assert.equal(calls, 1);
});

test("streaming: malformed SSE chunk fails without retry", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return sseResponse("{not valid json");
  };
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 3 }), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    (async () => {
      for await (const _e of provider.generateStream(baseRequest())) void _e;
    })(),
    ProviderBadResponseError,
  );
  assert.equal(calls, 1);
});

test("streaming: failure after partial data is not retried and text is not duplicated", async () => {
  let calls = 0;
  const encoder = new TextEncoder();
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return new Response(
      new ReadableStream<Uint8Array>({
        // First read delivers the SSE chunk; the SECOND read rejects, i.e.
        // the connection dies mid-body after consumer-visible data.
        start(controller) {
          controller.enqueue(
            encoder.encode(
              "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello " } }] }) + "\n\n",
            ),
          );
        },
        pull(controller) {
          controller.error(new Error("connection reset mid-stream"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 3 }), {
    fetchFn,
    sleepFn: async () => {},
  });
  const deltas: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const e of provider.generateStream(baseRequest())) {
        if (e.type === "text_delta") deltas.push(e.text);
      }
    })(),
    ProviderUnavailableError,
  );
  assert.equal(calls, 1, "a retry after consumer-visible data could duplicate content");
  assert.equal(deltas.join(""), "Hello ");
});

test("streaming: unknown provider alias fails the stream closed", async () => {
  const fetchFn: typeof fetch = async () =>
    sseResponse(
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "never__exposed", arguments: "{}" } }] } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }] }),
      "[DONE]",
    );
  const provider = new DeepSeekProvider(config(), { fetchFn, sleepFn: async () => {} });
  await assert.rejects(
    (async () => {
      const out: ModelStreamEvent[] = [];
      for await (const e of provider.generateStream(
        { ...baseRequest(), toolSchemas: [{ name: "system.echo", description: "echo", parameters: {} }] },
      )) {
        out.push(e);
      }
      return out;
    })(),
    ProviderBadResponseError,
  );
});

