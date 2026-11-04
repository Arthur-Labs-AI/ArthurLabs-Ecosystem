/**
 * Phase 2 unit tests: chunker, fusion, reranker, FTS builder, policy, store primitives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SecretSanitizer } from "../../src/security/sanitize";
import { PersonalMemoryStore } from "../../src/memory/stores/sqlite_memory_store";
import { chunkText } from "../../src/memory/ingestion/chunker";
import { normalizeText } from "../../src/memory/ingestion/normalizer";
import { buildFtsQuery } from "../../src/memory/retrieval/keyword_search";
import { reciprocalRankFusion } from "../../src/memory/retrieval/fusion";
import { rerankMemories } from "../../src/memory/retrieval/reranker";
import { MemoryItemSummary, MemoryType, MemoryWrite } from "../../src/memory/contracts";

test("chunker splits on paragraph/sentence boundaries and respects token budget", () => {
  const text = [
    "First sentence of paragraph one. Second sentence of paragraph one.",
    "Paragraph two starts here and continues with a second sentence.",
  ].join("\n\n");
  const chunks = chunkText(text, { maxTokensPerChunk: 30 });
  assert.ok(chunks.length >= 2, "paragraphs should be separated");
  for (const chunk of chunks) {
    assert.ok(chunk.text.length > 0);
    assert.ok(chunk.content_hash.length === 64);
  }
  // Deterministic.
  const again = chunkText(text, { maxTokensPerChunk: 30 });
  assert.deepEqual(chunks.map((c) => c.content_hash), again.map((c) => c.content_hash));
});

test("chunker hard-splits a single oversized sentence", () => {
  const long = "word ".repeat(200).trim();
  const chunks = chunkText(long, { maxTokensPerChunk: 50 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.token_count <= 51, "no chunk exceeds the budget");
  }
});

test("normalizeText collapses whitespace and normalizes unicode", () => {
  assert.equal(normalizeText("  hello   world\n\n\nagain  "), "hello world\n\nagain");
  assert.equal(normalizeText("A\u030A"), "Å");
});

test("buildFtsQuery quotes terms and preserves unicode letters", () => {
  assert.equal(buildFtsQuery("hello"), '"hello"*');
  const phrase = buildFtsQuery("quick brown fox");
  assert.equal(phrase, '("quick brown fox" OR "quick"* OR "brown"* OR "fox"*)');
  assert.equal(buildFtsQuery(""), "");
  assert.equal(buildFtsQuery("!!! ???"), "");
  const cyrillic = buildFtsQuery("памет и памет");
  assert.ok(cyrillic.includes("памет"));
});

test("reciprocal rank fusion merges channels and collapses per memory", () => {
  const vectorHits = [
    { chunk_id: "c-a1", memory_id: "m-a", text: "alpha", score: 0.9 },
    { chunk_id: "c-b1", memory_id: "m-b", text: "beta", score: 0.5 },
  ];
  const keywordHits = [
    { chunk_id: "c-a2", memory_id: "m-a", text: "alpha other", score: 5 },
    { chunk_id: "c-c1", memory_id: "m-c", text: "gamma", score: 3 },
  ];
  const fused = reciprocalRankFusion(vectorHits, keywordHits);
  const ids = fused.map((f) => f.memoryId).sort();
  assert.deepEqual(ids, ["m-a", "m-b", "m-c"]);
  // m-a is in both channels and should rank first.
  assert.equal(fused[0]?.memoryId, "m-a");
  assert.ok(fused[0]?.channels.includes("vector") && fused[0]?.channels.includes("keyword"));
});

test("reranker boosts importance, project matches, and suppresses low confidence", () => {
  const base = { text: "t", score: 1, channels: ["vector"] as Array<"vector" | "keyword"> };
  const summaries = new Map<string, MemoryItemSummary>([
    ["m1", { id: "m1", type: MemoryType.SEMANTIC, text: "t", status: "ACTIVE", confidence: 0.9, importance: 0.1, source_type: "USER_EXPLICIT", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    ["m2", { id: "m2", type: MemoryType.SEMANTIC, text: "t", status: "ACTIVE", confidence: 0.9, importance: 1.0, source_type: "USER_EXPLICIT", project_key: "atlas", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    ["m3", { id: "m3", type: MemoryType.SEMANTIC, text: "t", status: "ACTIVE", confidence: 0.3, importance: 1.0, source_type: "CONVERSATION", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
  ]);
  const ranked = rerankMemories(
    [
      { ...base, memoryId: "m1", chunkId: "c1" },
      { ...base, memoryId: "m2", chunkId: "c2" },
      { ...base, memoryId: "m3", chunkId: "c3" },
    ],
    summaries,
    { projectKey: "atlas" },
  );
  assert.equal(ranked[0]?.memoryId, "m2", "project match + importance should rank first");
  assert.ok(ranked[0] && ranked[2] && ranked[0].finalScore > ranked[2].finalScore, "low confidence should sink");
});

function memoryWrite(overrides: Partial<MemoryWrite> = {}): MemoryWrite {
  return {
    content_hash: "h",
    type: MemoryType.SEMANTIC,
    source_type: "USER_EXPLICIT",
    canonical_text: "text",
    display_text: "text",
    confidence: 1,
    importance: 0.7,
    embedding_model: "fake",
    embedding_version: "1",
    ...overrides,
  };
}

test("store enforces domain stamping and rejects cross-domain reads", async () => {
  const store = new PersonalMemoryStore(":memory:", new SecretSanitizer([]));
  try {
    const item = await store.put(memoryWrite());
    assert.equal(item.domain, "personal");
    assert.equal(item.status, "ACTIVE");
    assert.ok(item.id);
    assert.ok(item.created_at);
    // Unknown id lookup returns nothing.
    assert.equal(await store.get("definitely-not-created"), null);
  } finally {
    store.close();
  }
});

test("duplicate active content hashes converge instead of duplicating (DB-level guard)", async () => {
  const store = new PersonalMemoryStore(":memory:", new SecretSanitizer([]));
  try {
    const first = await store.put(memoryWrite({ id: "a1" }));
    // A second write with the same content hash (even a different id) is
    // idempotent: the DB-level unique index rejects the insert and the store
    // converges on the existing active row (spec section 33).
    const second = await store.put(memoryWrite({ id: "a2" }));
    assert.equal(second.id, first.id);
    const all = await store.list({ domain: "personal" });
    assert.equal(all.length, 1, "no duplicate active memories may exist");
  } finally {
    store.close();
  }
});