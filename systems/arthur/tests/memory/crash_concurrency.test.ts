/**
 * Phase 2 crash/concurrency tests (spec sections 33, 34, 36).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { SecretSanitizer } from "../../src/security/sanitize";
import { PersonalMemoryStore } from "../../src/memory/stores/sqlite_memory_store";
import { MemoryType, MemoryWrite } from "../../src/memory/contracts";
import { contentHash, requestHashOf } from "../../src/memory/provenance";
import { buildTestApp, validTurn } from "../helpers";

async function newSession(app: ReturnType<typeof buildTestApp>, mode: "personal" | "business"): Promise<string> {
  const response = await app.conversation.handleTurn(validTurn({ mode, message: "start" }));
  return response.session_id;
}

test("two concurrent remembers with the same idempotency key create one memory", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const [a, b] = await Promise.all([
      app.memory.remember(session, { text: "Concurrent fact about the rooftop antenna.", type: "SEMANTIC", client_request_id: "race-1" }),
      app.memory.remember(session, { text: "Concurrent fact about the rooftop antenna.", type: "SEMANTIC", client_request_id: "race-1" }),
    ]);
    assert.equal(a.id, b.id, "both racing remembers must converge on the same memory");
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 1);
  } finally {
    app.close();
  }
});

test("two concurrent document ingestions with the same key create one document", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "business");
    const request = { title: "Racing Doc", source_type: "text" as const, content: "Concurrent ingestion body with a stable hash target." };
    const [a, b] = await Promise.all([
      app.memory.ingestDocument(session, request, "race-doc-1"),
      app.memory.ingestDocument(session, request, "race-doc-1"),
    ]);
    assert.equal(a.document_id, b.document_id);
    assert.equal((await app.memory.listDocuments(session)).length, 1);
    // The document memory exists exactly once.
    const hits = await app.memory.search(session, { query_text: "stable hash target", top_k: 10 });
    assert.equal(hits.length, 1);
  } finally {
    app.close();
  }
});

test("concurrent personal and business ingestions stay isolated", async () => {
  const app = buildTestApp();
  try {
    const personal = await newSession(app, "personal");
    const business = await newSession(app, "business");
    const [p, b] = await Promise.all([
      app.memory.ingestDocument(personal, { title: "P", source_type: "text", content: "Personal concurrent content alpha." }, "iso-p"),
      app.memory.ingestDocument(business, { title: "B", source_type: "text", content: "Business concurrent content beta." }, "iso-b"),
    ]);
    assert.notEqual(p.document_id, b.document_id);
    assert.equal((await app.memory.search(personal, { query_text: "alpha" })).length, 1);
    const personalBeta = await app.memory.search(personal, { query_text: "beta", top_k: 20 });
    for (const hit of personalBeta) assert.ok(!hit.text.includes("beta"), "personal domain must not serve business content");
    assert.equal((await app.memory.search(business, { query_text: "beta" })).length, 1);
    const businessAlpha = await app.memory.search(business, { query_text: "alpha", top_k: 20 });
    for (const hit of businessAlpha) assert.ok(!hit.text.includes("alpha"), "business domain must not serve personal content");
  } finally {
    app.close();
  }
});

test("concurrent searches and deletes do not corrupt state", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const items: Array<{ id: string }> = [];
    for (let i = 0; i < 5; i++) {
      items.push(
        await app.memory.remember(session, { text: `Concurrency victim item ${i} with unique tail ${"z".repeat(i + 1)}.`, type: "SEMANTIC", client_request_id: `cv-${i}` }),
      );
    }
    const results = await Promise.all([
      app.memory.search(session, { query_text: "Concurrency victim item", top_k: 10 }),
      app.memory.search(session, { query_text: "unique tail", top_k: 10 }),
      app.memory.forget(session, items[0]?.id ?? ""),
      app.memory.list(session, { domain: "personal" }),
    ]);
    assert.ok(Array.isArray(results[0]));
    assert.ok(Array.isArray(results[1]));
    // The deleted item must be gone from every channel (content-level check:
    // the surviving items share a prefix, so assert on the unique tail).
    const afterDelete = await app.memory.search(session, { query_text: "Concurrency victim item 0", top_k: 20 });
    for (const hit of afterDelete) assert.ok(!hit.text.includes("item 0"), "deleted memory must not be retrieved");
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 4);
  } finally {
    app.close();
  }
});

test("crash-after-write ingestion rows are reconciled on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arthur-mem-reconcile-"));
  const path = join(dir, "memory-personal.db");
  const store1 = new PersonalMemoryStore(path, new SecretSanitizer([]));
  const write: MemoryWrite = {
    id: "mem-resume-1",
    content_hash: "hash-resume-1",
    type: MemoryType.SEMANTIC,
    source_type: "CONVERSATION",
    canonical_text: "Recovered fact from a crashed ingestion attempt.",
    display_text: "Recovered fact from a crashed ingestion attempt.",
    confidence: 0.9,
    importance: 0.7,
    embedding_model: "fake",
    embedding_version: "1",
  };
  try {
    store1.reserveIngestion("ingest-crash-1", "req-hash-1");
    assert.equal(store1.beginIngestion("ingest-crash-1", "req-hash-1"), true);
    // "Crash": rows written, completion never recorded. The gateway stamps
    // the idempotency request id as source_id so recovery can find the row.
    const item = await store1.put({ ...write, source_id: "ingest-crash-1" });
    await store1.putChunks(item.id, []);
    assert.equal(store1.getIngestion("ingest-crash-1")?.state, "writing");
  } finally {
    store1.close();
  }

  // Reopen: reconciliation converges the interrupted row.
  const store2 = new PersonalMemoryStore(path, new SecretSanitizer([]));
  try {
    const record = store2.getIngestion("ingest-crash-1");
    assert.equal(record?.state, "completed");
    assert.equal(record?.result_id, "mem-resume-1");
    const recovered = store2.get("mem-resume-1");
    assert.ok(recovered, "the written rows survived the crash");
  } finally {
    store2.close();
  }
});

test("reserving an ingestion key with a different hash is rejected even after completion", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await app.memory.remember(session, { text: "Key binding content.", type: "SEMANTIC", client_request_id: "bind-1" });
    await assert.rejects(
      () => app.memory.remember(session, { text: "Different content with same key.", type: "SEMANTIC", client_request_id: "bind-1" }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
  } finally {
    app.close();
  }
});


test("crash between item write and chunk write: replay repairs the index without duplicating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arthur-mem-repair-"));
  const base = { dbPath: join(dir, "arthur.db"), memoryPersonalDbPath: join(dir, "memory-personal.db"), memoryBusinessDbPath: join(dir, "memory-business.db") };
  const app1 = buildTestApp(base);
  let session: string;
  let memoryId: string;
  try {
    session = await newSession(app1, "personal");
    // First attempt: the item row exists but its chunks were never written
    // (simulated crash). Complete the ingestion so a replay is triggered.
    const gateway = (app1.memory as unknown as { gateway: { personal: PersonalMemoryStore } }).gateway;
    const store = gateway.personal;
    const text = "Crash-repair unique fact about the roof antenna tuning.";
    const item = await app1.memory.remember(session, { text, type: "SEMANTIC", client_request_id: "repair-1" });
    memoryId = item.id;
    // Remove chunks to simulate the crash window AFTER the item row was written.
    await store.deleteChunks(memoryId);
    assert.equal((await app1.memory.search(session, { query_text: "roof antenna tuning" })).length, 0);
  } finally {
    app1.close();
  }

  // Replay the same idempotency key: must repair the index and not duplicate.
  const app2 = buildTestApp(base);
  try {
    const replayed = await app2.memory.remember(session, { text: "Crash-repair unique fact about the roof antenna tuning.", type: "SEMANTIC", client_request_id: "repair-1" });
    assert.equal(replayed.id, memoryId, "replay must not create a duplicate");
    const hits = await app2.memory.search(session, { query_text: "roof antenna tuning", top_k: 10 });
    assert.ok(hits.some((h) => h.memory_id === memoryId), "replay must repair the index");
    assert.equal((await app2.memory.list(session, { domain: "personal" })).length, 1);
  } finally {
    app2.close();
  }
});


test("same-process resume after a crash between item and chunks converges (audit F3)", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const text = "Same-process crash resume fact about the attic ladder latch.";
    // Simulate the exact crash window with the request hash the gateway will
    // compute: reservation reserved, item row written, state = writing, no
    // chunks, no process restart.
    const gateway = (app.memory as unknown as { gateway: { personal: PersonalMemoryStore } }).gateway;
    const store = gateway.personal;
    const requestHash = requestHashOf({
      session_id: session,
      domain: "personal",
      text,
      type: "SEMANTIC",
      subject_key: null,
      project_key: null,
    });
    store.reserveIngestion("remember:f3-resume", requestHash);
    assert.equal(store.beginIngestion("remember:f3-resume", requestHash), true);
    const crashed = await store.put({
      content_hash: contentHash(text),
      type: MemoryType.SEMANTIC,
      source_type: "USER_EXPLICIT",
      source_id: "remember:f3-resume",
      canonical_text: text,
      display_text: text,
      confidence: 1,
      importance: 0.7,
      sensitivity: "NORMAL",
      embedding_model: "",
      embedding_version: "",
    });
    assert.equal(crashed.status, "ACTIVE");
    assert.equal((await store.getChunks(crashed.id)).length, 0, "crash window: no chunks/index rows yet");
    assert.equal(store.getIngestion("remember:f3-resume")?.state, "writing");
    assert.equal((await app.memory.search(session, { query_text: "attic ladder latch" })).length, 0, "not searchable before the resume");

    // Same-process retry (no restart): must detect the incomplete index and
    // converge — ACTIVE, chunks restored, searchable, no duplicate item.
    const resumed = await app.memory.remember(session, { text, type: "SEMANTIC", client_request_id: "f3-resume" });
    assert.equal(resumed.id, crashed.id, "resume must not create a duplicate logical memory");
    assert.equal(resumed.status, "ACTIVE");
    assert.ok((await store.getChunks(crashed.id)).length > 0, "chunks must be restored");
    const hits = await app.memory.search(session, { query_text: "attic ladder latch", top_k: 10 });
    assert.ok(hits.some((h) => h.memory_id === crashed.id), "memory must be searchable after same-process resume");
    assert.equal(store.getIngestion("remember:f3-resume")?.state, "completed");
    assert.equal((await app.memory.list(session, { domain: "personal" })).length, 1, "no duplicate memories");
  } finally {
    app.close();
  }
});

test("both memory migrations initialize independently and coexist", async () => {
  const app = buildTestApp();
  try {
    const personal = await newSession(app, "personal");
    const business = await newSession(app, "business");
    await app.memory.remember(personal, { text: "Migration marker personal.", type: "SEMANTIC" });
    await app.memory.remember(business, { text: "Migration marker business.", type: "SEMANTIC" });
    const report = app.memory.status(personal);
    assert.equal(report.personal.state, "healthy");
    assert.equal(report.business.state, "healthy");
    assert.equal(report.embedding.provider, "fake");
    assert.ok(report.embedding.dimensions > 0);
  } finally {
    app.close();
  }
});