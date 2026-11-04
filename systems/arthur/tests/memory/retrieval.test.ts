/**
 * Phase 2 retrieval tests (spec sections 13, 14, 15, 16, 29).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateTokens } from "../../src/observability/usage";
import { buildTestApp, validTurn } from "../helpers";

async function newSession(app: ReturnType<typeof buildTestApp>, mode: "personal" | "business"): Promise<string> {
  const response = await app.conversation.handleTurn(validTurn({ mode, message: "start" }));
  return response.session_id;
}

test("FTS keyword search finds exact phrases and single terms", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await app.memory.remember(session, {
      text: "The quick brown fox jumps over the lazy dog near the riverbank.",
      type: "SEMANTIC",
      client_request_id: "fts-1",
    });
    await app.memory.remember(session, {
      text: "Quarterly earnings call is scheduled for Friday morning.",
      type: "SEMANTIC",
      client_request_id: "fts-2",
    });

    const phrase = await app.memory.search(session, { query_text: "quick brown fox", top_k: 10 });
    assert.ok(phrase.length >= 1);
    assert.ok(phrase[0]?.text.includes("quick brown fox"), "top hit should be the FTS match");
    for (const hit of phrase) assert.ok(!hit.text.includes("Quarterly"), "unrelated memory must not be a top keyword hit");

    const single = await app.memory.search(session, { query_text: "riverbank", top_k: 10 });
    assert.ok(single.length >= 1);
    assert.ok(single.some((h) => h.text.includes("riverbank")));

    const unrelated = await app.memory.search(session, { query_text: "zebra stripes", top_k: 10 });
    for (const hit of unrelated) assert.ok(!/zebra|stripes/i.test(hit.text), "no unrelated content should be retrieved");
  } finally {
    app.close();
  }
});

test("vector search finds exact-match memories and ranks them first", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await app.memory.remember(session, { text: "The server room temperature should stay below 22 degrees celsius.", type: "SEMANTIC", client_request_id: "vec-1" });
    await app.memory.remember(session, { text: "Marketing prefers bright colors for the new campaign.", type: "SEMANTIC", client_request_id: "vec-2" });
    await app.memory.remember(session, { text: "Backups run every night at 2am.", type: "SEMANTIC", client_request_id: "vec-3" });

    const hits = await app.memory.search(session, { query_text: "The server room temperature should stay below 22 degrees celsius.", top_k: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.text, "The server room temperature should stay below 22 degrees celsius.");
    assert.ok((hits[0]?.score ?? 0) > 0);
  } finally {
    app.close();
  }
});

test("hybrid fusion merges vector and keyword channels without duplicates", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    // Memory A matches both channels for the query.
    await app.memory.remember(session, { text: "The warehouse inventory uses FIFO for perishable goods.", type: "SEMANTIC", client_request_id: "hy-1" });
    // Memory B matches the keyword channel only.
    await app.memory.remember(session, { text: "FIFO stands for first in, first out in accounting.", type: "SEMANTIC", client_request_id: "hy-2" });

    const hits = await app.memory.search(session, { query_text: "warehouse inventory FIFO perishable", top_k: 10 });
    const all = await app.memory.list(session, { domain: "personal" });
    const memoryA = all.find((m) => m.text.includes("warehouse"));
    const ids = hits.map((h) => h.memory_id);
    assert.ok(memoryA !== undefined && ids.includes(memoryA.id), "memory A should be retrieved");
    assert.ok(new Set(ids).size === ids.length, "no duplicate memory ids in results");
    assert.ok(hits.length >= 1);
  } finally {
    app.close();
  }
});

test("project filter restricts retrieval and list to the project", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await app.memory.remember(session, { text: "Project Atlas deploys on Fridays.", type: "SEMANTIC", project_key: "atlas", client_request_id: "prj-1" });
    await app.memory.remember(session, { text: "Project Boreal uses weekly retros.", type: "SEMANTIC", project_key: "boreal", client_request_id: "prj-2" });
    await app.memory.remember(session, { text: "Home router password hint is the street name.", type: "SEMANTIC", client_request_id: "prj-3" });

    const atlas = await app.memory.search(session, { query_text: "deploys", project_key: "atlas", top_k: 10 });
    assert.equal(atlas.length, 1);
    assert.equal(atlas[0]?.project_key, "atlas");

    const listed = await app.memory.list(session, { domain: "personal", project_key: "boreal" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.project_key, "boreal");
  } finally {
    app.close();
  }
});

test("lifecycle statuses are excluded from retrieval", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const memory = await app.memory.remember(session, { text: "Forget-me-now unique fact about the garden.", type: "SEMANTIC", client_request_id: "lc-1" });

    assert.equal((await app.memory.search(session, { query_text: "Forget-me-now unique fact about the garden" })).length, 1);

    await app.memory.forget(session, memory.id);
    assert.equal((await app.memory.search(session, { query_text: "Forget-me-now unique fact about the garden" })).length, 0);

    const listed = await app.memory.list(session, { domain: "personal" });
    assert.equal(listed.length, 0, "deleted memories are excluded from default lists");
  } finally {
    app.close();
  }
});

test("context token budget caps the total snippet size", async () => {
  const app = buildTestApp({
    memoryMaxContextTokens: 120,
    memoryMaxSingleChunkTokens: 300,
  });
  try {
    const session = await newSession(app, "personal");
    for (let i = 0; i < 6; i++) {
      await app.memory.remember(session, {
        text: `Budget marker item number ${i}: ${"x".repeat(160)} with some searchable content.`,
        type: "SEMANTIC",
        client_request_id: `budget-${i}`,
      });
    }
    const hits = await app.memory.search(session, { query_text: "Budget marker item", top_k: 10 });
    const total = hits.reduce((sum, hit) => sum + estimateTokens(hit.text), 0);
    assert.ok(total <= 160, `context token budget respected (got ${total})`);
  } finally {
    app.close();
  }
});

test("duplicate normalized chunks collapse to one result", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await app.memory.remember(session, { text: "The same fact about the greenhouse twice.", type: "SEMANTIC", client_request_id: "dup-1" });
    // Exact duplicate is deduped at write time (provenance update), so list shows one item.
    const duplicate = await app.memory.remember(session, { text: "The same fact about the greenhouse twice.", type: "SEMANTIC", client_request_id: "dup-2" });
    const listed = await app.memory.list(session, { domain: "personal" });
    assert.equal(listed.length, 1);
    assert.equal(duplicate.id, listed[0]?.id);
  } finally {
    app.close();
  }
});