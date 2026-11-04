import { test } from "node:test";
import assert from "node:assert/strict";

import { ModelGateway } from "../../src/models/gateway";
import { FakeProvider } from "../../src/models/providers/fake";
import { parseDeepSeekStreamChunk, ToolCallAccumulator } from "../../src/models/providers/deepseek";
import type { ModelRequest, ModelStreamEvent } from "../../src/models/contracts";

test("generateStream replays a buffered response when the provider cannot stream", async () => {
  const provider = new FakeProvider({
    responder: (request) => ({
      assistant_text: "buffered:" + request.userMessage,
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: "stop",
      raw_provider_id: "fake",
    }),
  });
  const gateway = new ModelGateway(provider);
  const request: ModelRequest = {
    systemContract: "sys",
    modeContract: "personal",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "fake-model",
    reasoningProfile: "fast",
  };
  const events: string[] = [];
  for await (const event of gateway.generateStream(request)) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["text_delta", "usage", "done"]);
});

test("generateStream honors abort and stops yielding", async () => {
  const controller = new AbortController();
  const provider = new FakeProvider({
    streamResponder: (async function* (_req: ModelRequest, signal?: AbortSignal) {
      yield { type: "text_delta", text: "first " };
      await new Promise<void>((resolve) => {
        if (signal) {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        } else {
          resolve();
        }
      });
      // Providers must honor the signal: nothing may yield after abort.
      if (signal?.aborted) return;
      yield { type: "text_delta", text: "second" };
      yield { type: "done", finish_reason: "stop" };
    }) as (request: ModelRequest, signal?: AbortSignal) => AsyncIterable<ModelStreamEvent>,
  });
  const gateway = new ModelGateway(provider);
  const request: ModelRequest = {
    systemContract: "sys",
    modeContract: "personal",
    history: [],
    toolSchemas: [],
    userMessage: "hi",
    model: "fake-model",
    reasoningProfile: "fast",
  };
  const text: string[] = [];
  const iterator = gateway.generateStream(request, controller.signal)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.ok(!first.done);
  if (!first.done && first.value.type === "text_delta") text.push(first.value.text);
  assert.equal(text.join(""), "first ");
  controller.abort();
  const second = await iterator.next();
  assert.ok(second.done, "aborted stream must stop yielding");
});
test("deepseek SSE parser accumulates tool call fragments across chunks", () => {
  const accumulators = new Map<number, ToolCallAccumulator>();
  const chunk1 = parseDeepSeekStreamChunk(
    {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "system.echo", arguments: "" } }] } }],
    },
    accumulators,
  );
  assert.ok(chunk1);
  assert.ok(chunk1.some((e) => e.type === "tool_call"), "early partial tool_call is emitted");
  const chunk2 = parseDeepSeekStreamChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"text\":\"hi\"}" } }] } }] },
    accumulators,
  );
  // Argument-fragment chunks carry no new events (accumulation only).
  assert.equal(chunk2, null);
  const done = parseDeepSeekStreamChunk({ choices: [{ finish_reason: "tool_calls" }] }, accumulators);
  assert.ok(done && done.some((e) => e.type === "done"));
  const acc = accumulators.get(0);
  assert.ok(acc);
  assert.equal(acc.id, "call_1");
  assert.equal(acc.name, "system.echo");
  assert.equal(acc.argumentsJson, "{\"text\":\"hi\"}");
});

test("deepseek SSE parser ignores chunks without content", () => {
  const accumulators = new Map<number, ToolCallAccumulator>();
  const result = parseDeepSeekStreamChunk({ choices: [{ delta: {} }] }, accumulators);
  assert.equal(result, null);
});