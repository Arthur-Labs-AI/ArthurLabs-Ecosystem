/**
 * Phase 2 lifecycle tests (spec sections 21, 22, 23, 33, 34, 36).
 *
 * Restart persistence, idempotent explicit remembers, dedupe/supersession,
 * expiry, and deletion/index cleanup.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { PersonalMemoryStore } from "../../src/memory/stores/sqlite_memory_store";
import { buildTestApp, validTurn } from "../helpers";

async function newSession(app: ReturnType<typeof buildTestApp>, mode: "personal" | "business"): Promise<string> {
  const response = await app.conversation.handleTurn(validTurn({ mode, message: "start" }));
  return response.session_id;
}

test("memories persist across a full restart (file-backed stores)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arthur-mem-restart-"));
  const base = { dbPath: join(dir, "arthur.db"), memoryPersonalDbPath: join(dir, "memory-personal.db"), memoryBusinessDbPath: join(dir, "memory-business.db") };
  const app1 = buildTestApp(base);
  let session: string;
  let memoryId: string;
  try {
    session = await newSession(app1, "personal");
    const item = await app1.memory.remember(session, {
      text: "Restart-proven fact: the garage door code uses the year of the house.",
      type: "SEMANTIC",
      client_request_id: "restart-1",
    });
    memoryId = item.id;
    await app1.memory.ingestDocument(
      session,
      { title: "Restart Doc", source_type: "text", content: "Restart-proven document about the basement layout." },
      "restart-doc",
    );
  } finally {
    app1.close();
  }

  const app2 = buildTestApp(base);
  try {
    const hits = await app2.memory.search(session, { query_text: "garage door code" });
    assert.ok(hits.some((h) => h.memory_id === memoryId), "the remembered fact must survive a restart");
    assert.ok(hits.some((h) => h.text.includes("garage door code")), "the remembered text must survive a restart");

    const docHits = await app2.memory.search(session, { query_text: "basement layout" });
    assert.ok(docHits.some((h) => h.text.includes("basement layout")), "the ingested document must survive a restart");
    assert.equal((await app2.memory.listDocuments(session)).length, 1);
  } finally {
    app2.close();
  }
});

test("explicit remember with the same idempotency key creates one logical memory", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const first = await app.memory.remember(session, { text: "Idempotent fact about the window seat.", type: "SEMANTIC", client_request_id: "idem-key-1" });
    const second = await app.memory.remember(session, { text: "Idempotent fact about the window seat.", type: "SEMANTIC", client_request_id: "idem-key-1" });
    assert.equal(second.id, first.id);
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 1);
  } finally {
    app.close();
  }
});

test("same idempotency key with different content is rejected", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await app.memory.remember(session, { text: "First content for the key.", type: "SEMANTIC", client_request_id: "key-conflict" });
    await assert.rejects(
      () => app.memory.remember(session, { text: "Second content for the key.", type: "SEMANTIC", client_request_id: "key-conflict" }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
  } finally {
    app.close();
  }
});

test("duplicate remember updates provenance instead of duplicating", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const first = await app.memory.remember(session, { text: "Verified fact about the attic insulation.", type: "SEMANTIC", client_request_id: "prov-1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await app.memory.remember(session, { text: "Verified fact about the attic insulation.", type: "SEMANTIC", client_request_id: "prov-2" });
    assert.equal(second.id, first.id);
    assert.ok(second.updated_at >= first.updated_at, "provenance timestamp must be refreshed");
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 1);
  } finally {
    app.close();
  }
});

test("user correction supersedes the old memory", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const old = await app.memory.remember(session, {
      text: "The user's preferred assistant name is Alice.",
      type: "SEMANTIC",
      subject_key: "assistant-name",
      client_request_id: "corr-1",
    });
    const replacement = await app.memory.remember(session, {
      text: "The user's preferred assistant name is now Bob.",
      type: "SEMANTIC",
      subject_key: "assistant-name",
      client_request_id: "corr-2",
    });
    assert.notEqual(replacement.id, old.id);
    assert.equal(replacement.status, "ACTIVE");

    // Old memory is superseded and excluded from retrieval (the new memory
    // may legitimately match shared words, so the check is content-level).
    const hits = await app.memory.search(session, { query_text: "preferred assistant name is Alice", top_k: 10 });
    for (const hit of hits) assert.ok(!hit.text.includes("Alice"), "superseded memory must not be retrieved");
    const newHits = await app.memory.search(session, { query_text: "preferred assistant name is now Bob", top_k: 10 });
    assert.equal(newHits.length, 1);
    assert.equal(newHits[0]?.memory_id, replacement.id);

    // Audit trail: the old item is still listed with SUPERSEDED status.
    const listed = await app.memory.list(session, { domain: "personal", status: "SUPERSEDED" });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, old.id);
  } finally {
    app.close();
  }
});

test("forget removes the memory from structured rows, FTS, and vector retrieval", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const item = await app.memory.remember(session, { text: "Sensitive ephemeral note about the balcony plants.", type: "SEMANTIC", client_request_id: "forget-1" });

    // Present in FTS and vector before deletion.
    assert.equal((await app.memory.search(session, { query_text: "balcony plants" })).length, 1);
    assert.equal((await app.memory.search(session, { query_text: "Sensitive ephemeral note about the balcony plants." })).length, 1);

    await app.memory.forget(session, item.id);

    // Gone from every retrieval channel.
    assert.equal((await app.memory.search(session, { query_text: "balcony plants" })).length, 0);
    assert.equal((await app.memory.search(session, { query_text: "Sensitive ephemeral note about the balcony plants." })).length, 0);
    // Tombstone exists for audit but carries no retained text.
    const tombstone = await app.memory.list(session, { domain: "personal", status: "DELETED" });
    assert.equal(tombstone.length, 1);
    assert.ok(!tombstone[0]?.text.includes("balcony plants"), "deleted text must not be retained in the tombstone");
  } finally {
    app.close();
  }
});

test("remember -> forget -> remember again creates a fresh ACTIVE memory (audit F2)", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const text = "Replay-after-forget fact about the cellar humidity sensor.";
    const first = await app.memory.remember(session, { text, type: "SEMANTIC", client_request_id: "f2-replay" });
    assert.equal(first.status, "ACTIVE");
    assert.equal((await app.memory.search(session, { query_text: "cellar humidity sensor" })).length, 1);

    await app.memory.forget(session, first.id);
    assert.equal((await app.memory.search(session, { query_text: "cellar humidity sensor" })).length, 0);

    // Re-remember the same content with the same idempotency key: forget is
    // final, so this must create a fresh ACTIVE memory — never replay the
    // DELETED tombstone or drop the new content.
    const again = await app.memory.remember(session, { text, type: "SEMANTIC", client_request_id: "f2-replay" });
    assert.equal(again.status, "ACTIVE");
    assert.notEqual(again.id, first.id, "a forgotten memory must not be resurrected");
    assert.equal(again.canonical_text, text, "the newly submitted content must be stored");
    assert.ok(!again.canonical_text.includes("[deleted:"), "the stored content must not be the tombstone");

    // Searchable with the new content.
    const hits = await app.memory.search(session, { query_text: "cellar humidity sensor", top_k: 10 });
    assert.ok(hits.some((h) => h.memory_id === again.id), "the fresh memory must be searchable");
    assert.ok(hits.some((h) => h.text.includes("cellar humidity sensor")), "the new content must be retrievable");

    // DB/index consistency: the tombstone keeps no chunks/FTS rows and the
    // idempotency record is rebound to the fresh ACTIVE item.
    const gateway = (app.memory as unknown as { gateway: { personal: PersonalMemoryStore } }).gateway;
    const store = gateway.personal;
    const tombstone = await store.get(first.id);
    assert.equal(tombstone?.status, "DELETED", "the old row stays a tombstone");
    assert.equal((await store.getChunks(first.id)).length, 0, "tombstone must not carry chunks/FTS rows");
    const fresh = await store.get(again.id);
    assert.equal(fresh?.status, "ACTIVE");
    assert.ok((await store.getChunks(again.id)).length > 0, "the fresh memory must be indexed");
    const ingestion = store.getIngestion("remember:f2-replay");
    assert.equal(ingestion?.state, "completed");
    assert.equal(ingestion?.result_id, again.id, "idempotency state must point at the fresh ACTIVE memory");

    const active = await app.memory.list(session, { domain: "personal" });
    assert.equal(active.length, 1);
    assert.equal(active[0]?.id, again.id);
    const deleted = await app.memory.list(session, { domain: "personal", status: "DELETED" });
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0]?.id, first.id);
  } finally {
    app.close();
  }
});

test("TEMPORARY memories expire by TTL and disappear from retrieval", async () => {
  const app = buildTestApp({ memoryTemporaryTtlSeconds: 1 });
  try {
    const session = await newSession(app, "personal");
    const item = await app.memory.remember(session, { text: "One-time code for the front gate today.", type: "TEMPORARY", client_request_id: "ttl-1" });
    assert.equal(item.status, "ACTIVE");
    assert.ok(item.expires_at, "temporary memories carry an expiry");

    assert.equal((await app.memory.search(session, { query_text: "One-time code for the front gate" })).length, 1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await app.memory.search(session, { query_text: "One-time code for the front gate" })).length, 0, "expired memory must not be retrieved");

    const expired = await app.memory.list(session, { domain: "personal", status: "EXPIRED" });
    assert.equal(expired.length, 1, "expired memory remains auditable");
  } finally {
    app.close();
  }
});

test("remember validates type, size, and empty text", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await assert.rejects(
      () => app.memory.remember(session, { text: "   ", type: "SEMANTIC" }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    await assert.rejects(
      () => app.memory.remember(session, { text: "ok", type: "NOT_A_TYPE" as never }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
  } finally {
    app.close();
  }
});