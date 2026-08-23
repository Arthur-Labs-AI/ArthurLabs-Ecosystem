/**
 * Phase 2 automatic extraction tests (spec sections 20, 36, 44).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest, ModelResult } from "../../src/models/contracts";
import { MemoryExtractor } from "../../src/memory/extraction/memory_extractor";
import { ModelGateway } from "../../src/models/gateway";
import { buildTestApp, validTurn } from "../helpers";

function result(text: string, tool_calls: ModelResult["tool_calls"] = []): ModelResult {
  return { assistant_text: text, tool_calls, finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } };
}

function extractionResponse(memories: unknown[]): ModelResult {
  return result(JSON.stringify({ memories }));
}

test("extractor validates schema-strict output through the model gateway", async () => {
  const provider = new FakeProvider({
    responder: (req) => {
      if (req.userMessage.startsWith("Extract durable memories")) {
        return extractionResponse([
          {
            text: "The user plans to renovate the kitchen in spring.",
            type: "SEMANTIC",
            subject_key: "renovation",
            confidence: 0.92,
            importance: 0.75,
            reason: "explicit plan",
            should_store: true,
          },
        ]);
      }
      return result("ok");
    },
  });
  const gateway = new ModelGateway(provider);
  const extractor = new MemoryExtractor({ gateway, model: "fake-model" });
  const outcome = await extractor.extract({
    mode: "personal",
    history: [],
    userMessage: "I will renovate the kitchen in spring.",
    assistantText: "Sounds like a plan!",
  });
  assert.equal(outcome.malformed, false);
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.candidates[0]?.text, "The user plans to renovate the kitchen in spring.");
});

test("extractor discards malformed output and low-confidence/secret candidates", async () => {
  const provider = new FakeProvider({
    responder: () => result('Sure, here is the extraction: "memories": [ ... ] but not really JSON'),
  });
  const gateway = new ModelGateway(provider);
  const extractor = new MemoryExtractor({ gateway, model: "fake-model" });
  const outcome = await extractor.extract({ mode: "business", history: [], userMessage: "x", assistantText: "y" });
  assert.equal(outcome.malformed, true);
  assert.equal(outcome.candidates.length, 0);

  const provider2 = new FakeProvider({
    responder: () =>
      extractionResponse([
        { text: "Low confidence guess about the weather.", type: "SEMANTIC", confidence: 0.1, importance: 0.9, reason: "guess", should_store: true },
        { text: "password=hunter2 was set.", type: "SEMANTIC", confidence: 0.95, importance: 0.9, reason: "explicit", should_store: true },
        { text: "Stable preference for dark mode in the evening.", type: "SEMANTIC", confidence: 0.9, importance: 0.8, reason: "explicit", should_store: true },
      ]),
  });
  const extractor2 = new MemoryExtractor({ gateway: new ModelGateway(provider2), model: "fake-model" });
  const outcome2 = await extractor2.extract({ mode: "personal", history: [], userMessage: "x", assistantText: "y" });
  assert.equal(outcome2.candidates.length, 1, "only the high-confidence clean candidate survives policy");
  assert.ok(outcome2.candidates[0]?.text.includes("dark mode"));
});

test("enabled extraction writes candidates as conversation-sourced memories", async () => {
  const provider = new FakeProvider({
    responder: (req) => {
      if (req.userMessage.startsWith("Extract durable memories")) {
        return extractionResponse([
          {
            text: "The user's favorite hiking trail is the ridge loop.",
            type: "SEMANTIC",
            subject_key: "trail",
            confidence: 0.95,
            importance: 0.8,
            reason: "explicit",
            should_store: true,
          },
        ]);
      }
      return result("fake:" + req.userMessage);
    },
  });
  const app = buildTestApp(
    { memoryExtractionEnabled: true },
    { provider },
  );
  try {
    const response = await app.conversation.handleTurn(
      validTurn({ message: "I really love the ridge loop trail.", client_request_id: "ext-1" }),
    );
    assert.equal(response.status, "completed", "extraction must not break the turn");
    const memories = await app.memory.list(response.session_id, { domain: "personal" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.source_type, "CONVERSATION");
    assert.ok(memories[0]?.text.includes("ridge loop"));
  } finally {
    app.close();
  }
});

test("malformed extraction output never fails the conversation turn", async () => {
  const provider = new FakeProvider({
    responder: (req) => {
      if (req.userMessage.startsWith("Extract durable memories")) {
        throw new Error("extraction backend exploded");
      }
      return result("fake:" + req.userMessage);
    },
  });
  const app = buildTestApp({ memoryExtractionEnabled: true }, { provider });
  try {
    const response = await app.conversation.handleTurn(validTurn({ message: "hello there", client_request_id: "ext-2" }));
    assert.equal(response.status, "completed");
    assert.equal(response.display_text, "fake:hello there");
    assert.equal((await app.memory.list(response.session_id, { domain: "personal" })).length, 0);
  } finally {
    app.close();
  }
});

test("disabled extraction does not call the model a second time", async () => {
  let calls = 0;
  const provider = new FakeProvider({
    responder: () => {
      calls += 1;
      return result("ok");
    },
  });
  const app = buildTestApp({ memoryExtractionEnabled: false }, { provider });
  try {
    await app.conversation.handleTurn(validTurn({ message: "one turn", client_request_id: "ext-3" }));
    assert.equal(calls, 1, "only the turn call runs when extraction is disabled");
  } finally {
    app.close();
  }
});

test("extraction prompt receives only same-mode sanitized transcript text", async () => {
  let extractionRequest: ModelRequest | undefined;
  const provider = new FakeProvider({
    responder: (req) => {
      if (req.userMessage.startsWith("Extract durable memories")) {
        extractionRequest = req;
        return extractionResponse([]);
      }
      return result("ok");
    },
  });
  const app = buildTestApp({ memoryExtractionEnabled: true }, { provider });
  try {
    const personal = (await app.conversation.handleTurn(validTurn({ mode: "personal", message: "start", client_request_id: "ext-4" }))).session_id;
    await app.memory.remember(personal, { text: "Business-only marker would never be here.", type: "SEMANTIC" });
    await app.conversation.handleTurn(
      validTurn({ session_id: personal, message: "tell me more", client_request_id: "ext-5" }),
    );
    const transcript = extractionRequest?.userMessage ?? "";
    assert.ok(transcript.includes("Extract durable memories from this personal conversation"));
    assert.ok(!transcript.includes("Business-only marker"));
  } finally {
    app.close();
  }
});
