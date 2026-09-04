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
  classifyStreamFailure,
  DeepSeekProvider,
  DeepSeekProviderConfig,
  DeepSeekRequestRejectedError,
  MALFORMED_SSE_MESSAGE,
  MAX_ASSISTANT_TEXT_CHARS,
  MAX_RESPONSE_BYTES,
  MAX_TOOL_CALLS,
  normalizeDeepSeekResponse,
  ProviderLogSink,
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

// ---- TASK-0007: streaming failure diagnostics (safe, structured) ---------

interface RecordedLogEntry {
  level: "info" | "warn";
  message: string;
  fields?: Record<string, unknown>;
}

function recordingLogger(): { logger: ProviderLogSink; entries: RecordedLogEntry[] } {
  const entries: RecordedLogEntry[] = [];
  return {
    entries,
    logger: {
      info: (message, fields) => entries.push({ level: "info", message, fields }),
      warn: (message, fields) => entries.push({ level: "warn", message, fields }),
    },
  };
}

test("diagnostics: transient 5xx logged as http_status, then completion", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(503, { error: { message: "temporarily unavailable" } })
      : sseResponse(
          JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] }),
          "[DONE]",
        );
  };
  const { logger, entries } = recordingLogger();
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 2 }), { fetchFn, sleepFn: async () => {}, logger });
  for await (const e of provider.generateStream(baseRequest())) void e;
  assert.equal(calls, 2);
  const failed = entries.find((e) => e.message === "deepseek.stream.attempt_failed");
  assert.ok(failed, "the failed attempt must be logged");
  assert.equal(failed.fields?.kind, "http_status");
  assert.equal(failed.fields?.http_status, 503);
  assert.equal(failed.fields?.attempt, 1);
  assert.equal(failed.fields?.max_attempts, 3);
  assert.equal(failed.fields?.emitted_any, false);
  const completed = entries.find((e) => e.message === "deepseek.stream.completed");
  assert.ok(completed, "the successful completion must be logged");
  assert.equal(completed.fields?.attempts, 2);
  // Secret-safety: diagnostics never contain the API key.
  assert.ok(!JSON.stringify(entries).includes("sk-test"), "diagnostics must never contain the API key");
});

test("diagnostics: pre-data timeout classified as timeout and retried", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = (_url, init) => {
    calls += 1;
    const signal = init?.signal;
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    }
    return Promise.resolve(sseResponse(
      JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      "[DONE]",
    ));
  };
  const { logger, entries } = recordingLogger();
  const provider = new DeepSeekProvider(
    config({ timeoutMs: 40, retryMaxAttempts: 1, retryBaseDelayMs: 5 }),
    { fetchFn, sleepFn: async () => {}, logger },
  );
  for await (const e of provider.generateStream(baseRequest())) void e;
  assert.equal(calls, 2);
  const failed = entries.find((e) => e.message === "deepseek.stream.attempt_failed");
  assert.ok(failed);
  assert.equal(failed.fields?.kind, "timeout", "a per-attempt timeout is distinct from unavailability");
  assert.equal(failed.fields?.http_status, null);
  const completed = entries.find((e) => e.message === "deepseek.stream.completed");
  assert.equal(completed?.fields?.attempts, 2);
});

test("diagnostics: malformed SSE line classified without retry", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return sseResponse("{not valid json");
  };
  const { logger, entries } = recordingLogger();
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 3 }), { fetchFn, sleepFn: async () => {}, logger });
  await assert.rejects(
    (async () => {
      for await (const e of provider.generateStream(baseRequest())) void e;
    })(),
    ProviderBadResponseError,
  );
  assert.equal(calls, 1);
  const failed = entries.find((e) => e.message === "deepseek.stream.attempt_failed");
  assert.ok(failed);
  assert.equal(failed.fields?.kind, "malformed_sse", "a non-JSON SSE line is distinct from other bad responses");
  assert.equal(failed.fields?.error_message, MALFORMED_SSE_MESSAGE);
  assert.ok(!entries.some((e) => e.message === "deepseek.stream.completed"));
});

test("diagnostics: stream ending without DONE is provider_bad_response with emitted_any", async () => {
  const fetchFn: typeof fetch = async () =>
    sseResponse(JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] }));
  const { logger, entries } = recordingLogger();
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 3 }), { fetchFn, sleepFn: async () => {}, logger });
  await assert.rejects(
    (async () => {
      for await (const e of provider.generateStream(baseRequest())) void e;
    })(),
    ProviderBadResponseError,
  );
  const failures = entries.filter((e) => e.message === "deepseek.stream.attempt_failed");
  assert.equal(failures.length, 1, "failure after consumer-visible data must not retry");
  assert.equal(failures[0]?.fields?.kind, "provider_bad_response");
  assert.equal(failures[0]?.fields?.emitted_any, true, "the text delta was already consumer-visible");
});

test("diagnostics: network failure exhausts budget and logs retries_exhausted", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    throw new Error("network down");
  };
  const { logger, entries } = recordingLogger();
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 2 }), { fetchFn, sleepFn: async () => {}, logger });
  await assert.rejects(
    (async () => {
      for await (const e of provider.generateStream(baseRequest())) void e;
    })(),
    ProviderUnavailableError,
  );
  assert.equal(calls, 3);
  const failures = entries.filter((e) => e.message === "deepseek.stream.attempt_failed");
  assert.equal(failures.length, 3);
  for (const f of failures) {
    assert.equal(f.fields?.kind, "network_fetch_failure");
    assert.equal(f.fields?.error_message, null, "network diagnostics carry the error name only");
    assert.equal(f.fields?.emitted_any, false);
  }
  const exhausted = entries.find((e) => e.message === "deepseek.stream.retries_exhausted");
  assert.ok(exhausted, "budget exhaustion must be logged");
  assert.equal(exhausted.fields?.attempts, 3);
  assert.equal(exhausted.fields?.max_attempts, 3);
  assert.equal(exhausted.fields?.last_kind, "network_fetch_failure");
  assert.ok(!JSON.stringify(entries).includes("sk-test"), "diagnostics must never contain the API key");
});

test("diagnostics: caller abort mid-stream logged once and never retried", async () => {
  let calls = 0;
  const caller = new AbortController();
  const encoder = new TextEncoder();
  const fetchFn: typeof fetch = async (_url, init) => {
    calls += 1;
    const signal = init?.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello " } }] }) + "\n\n",
            ),
          );
        },
        pull() {
          // Stall the next read until the fetch signal (controller) aborts.
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          });
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const { logger, entries } = recordingLogger();
  const provider = new DeepSeekProvider(config({ timeoutMs: 5000, retryMaxAttempts: 3 }), {
    fetchFn,
    sleepFn: async () => {},
    logger,
  });
  const consumed = (async () => {
    for await (const e of provider.generateStream(baseRequest(), caller.signal)) void e;
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  caller.abort();
  await consumed;
  assert.equal(calls, 1, "caller cancellation must never trigger a retry");
  const aborted = entries.find((e) => e.message === "deepseek.stream.caller_aborted");
  assert.ok(aborted, "caller abort must be distinguishable from failures");
  assert.equal(aborted.fields?.emitted_any, true);
  assert.ok(!entries.some((e) => e.message === "deepseek.stream.attempt_failed"), "caller abort is not a failure");
});

test("diagnostics: request_rejected (400) classified with http status and no retry", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return jsonResponse(400, { error: { message: "bad request" } });
  };
  const { logger, entries } = recordingLogger();
  const provider = new DeepSeekProvider(config({ retryMaxAttempts: 3 }), { fetchFn, sleepFn: async () => {}, logger });
  await assert.rejects(
    (async () => {
      for await (const e of provider.generateStream(baseRequest())) void e;
    })(),
    DeepSeekRequestRejectedError,
  );
  assert.equal(calls, 1);
  const failed = entries.find((e) => e.message === "deepseek.stream.attempt_failed");
  assert.ok(failed);
  assert.equal(failed.fields?.kind, "request_rejected", "an HTTP 400 is distinct from transient unavailability");
  assert.equal(failed.fields?.http_status, 400);
  assert.ok(!entries.some((e) => e.message === "deepseek.stream.retries_exhausted"), "non-retryable failures do not exhaust the budget");
});

test("diagnostics: classifyStreamFailure maps directly and safely", () => {
  assert.equal(classifyStreamFailure(new Error("boom"), false).kind, "network_fetch_failure");
  assert.equal(classifyStreamFailure(new Error("boom"), false).error_name, "Error");
  assert.equal(classifyStreamFailure(new Error("boom"), false).error_message, undefined);
  assert.equal(classifyStreamFailure(new Error("x"), true).kind, "timeout");
  assert.equal(classifyStreamFailure(new ProviderBadResponseError("stream ended without [DONE]"), false).kind, "provider_bad_response");
  assert.equal(classifyStreamFailure(new ProviderBadResponseError(MALFORMED_SSE_MESSAGE), false).kind, "malformed_sse");
  assert.equal(classifyStreamFailure(new ProviderUnavailableError(), false).kind, "network_fetch_failure");
  assert.equal(classifyStreamFailure(new ProviderAuthError(), false).kind, "auth");
});

