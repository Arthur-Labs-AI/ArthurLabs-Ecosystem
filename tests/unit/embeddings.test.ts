/**
 * Embedding unit tests (spec section 12).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { cosineSimilarity, l2Normalize } from "../../src/memory/embeddings/contracts";
import { EmbeddingGatewayImpl } from "../../src/memory/embeddings/gateway";
import { FakeEmbeddingProvider } from "../../src/memory/embeddings/providers/fake";
import { LocalMultilingualEmbeddingProvider } from "../../src/memory/embeddings/providers/local_multilingual";

test("fake embedding provider is deterministic and normalized", async () => {
  const provider = new FakeEmbeddingProvider({ dimensions: 64 });
  const a = await provider.embed(["hello world"]);
  const b = await provider.embed(["hello world"]);
  assert.deepEqual(a[0], b[0]);
  assert.equal(a[0]?.length, 64);
  const norm = Math.sqrt((a[0] ?? []).reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6);
});

test("local multilingual provider works across scripts and is deterministic", async () => {
  const provider = new LocalMultilingualEmbeddingProvider({ dimensions: 128 });
  const [english, bulgarian, russian, repeat] = await provider.embed([
    "the user prefers hiking on weekends",
    "потребителят предпочита разходки през уикенда",
    "пользователь предпочитает походы по выходным",
    "the user prefers hiking on weekends",
  ]);
  assert.equal(english?.length, 128);
  assert.deepEqual(english, repeat, "deterministic across calls");
  // All three scripts produce non-zero vectors.
  for (const vector of [english, bulgarian, russian]) {
    assert.ok((vector ?? []).some((v) => v !== 0), "non-zero embedding expected");
  }
});

test("cosine similarity: identical = 1, orthogonal = 0, opposite = -1", () => {
  const v = [1, 2, 3];
  assert.equal(cosineSimilarity(v, [1, 2, 3]), 1);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-9);
  assert.equal(cosineSimilarity([], [1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
});

test("l2Normalize produces unit vectors and handles zero vectors", () => {
  const unit = l2Normalize([3, 4]);
  assert.equal(unit[0], 0.6);
  assert.equal(unit[1], 0.8);
  assert.deepEqual(l2Normalize([0, 0]), [0, 0]);
});

test("embedding gateway enforces size limits and composes identity", async () => {
  const gateway = new EmbeddingGatewayImpl({
    provider: new FakeEmbeddingProvider({ dimensions: 32 }),
    model: "test-model",
    version: "2",
  });
  assert.equal(gateway.id(), "fake:test-model:2");

  const batch = await gateway.embed(["one", "two"]);
  assert.equal(batch.vectors.length, 2);
  assert.equal(batch.dimensions, 32);
  assert.equal(batch.provider, "fake");
  assert.equal(batch.model, "test-model");
  assert.equal(batch.version, "2");

  const empty = await gateway.embed([]);
  assert.equal(empty.vectors.length, 0);

  await assert.rejects(
    () => gateway.embed(new Array(65).fill("x")),
    (err: Error) => err instanceof Error && err.message.includes("batch too large"),
  );
  await assert.rejects(
    () => gateway.embed(["y".repeat(20000)]),
    (err: Error) => err instanceof Error && err.message.includes("exceeds"),
  );
});

test("embedding gateway batches provider calls correctly", async () => {
  let calls = 0;
  const provider = {
    id: () => "counting",
    dimensions: () => 8,
    embed: async (texts: string[]) => {
      calls += 1;
      return texts.map((t) => l2Normalize(Array.from({ length: 8 }, (_, i) => (t.charCodeAt(i % t.length) || 1) + i)));
    },
  };
  const gateway = new EmbeddingGatewayImpl({ provider, model: "m", version: "1", batchSize: 2 });
  const batch = await gateway.embed(["a", "b", "c", "d", "e"]);
  assert.equal(calls, 3, "5 texts in batches of 2 -> 3 provider calls");
  assert.equal(batch.vectors.length, 5);
});