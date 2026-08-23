/**
 * Phase 2 document ingestion tests (spec sections 24, 25, 30, 33).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ArthurError } from "../../src/core/errors/errors";
import { buildTestApp, validTurn } from "../helpers";

async function newSession(app: ReturnType<typeof buildTestApp>, mode: "personal" | "business"): Promise<string> {
  const response = await app.conversation.handleTurn(validTurn({ mode, message: "start" }));
  return response.session_id;
}

const SAMPLE_DOC = [
  "# Project Nebula notes",
  "",
  "The Nebula service migrates to TypeScript in Q4.",
  "Deployment uses a blue-green strategy with zero downtime.",
  "The team meets every Tuesday at 10:00 for planning.",
].join("\n");

test("document ingestion stores, chunks, and indexes content for retrieval", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const doc = await app.memory.ingestDocument(
      session,
      { title: "Nebula Notes", source_type: "markdown", content: SAMPLE_DOC },
      "doc-ingest-1",
    );
    assert.ok(doc.document_id.startsWith("doc-"));
    assert.equal(doc.chunk_count, 1);
    assert.ok(doc.memory_ids.length === 1);

    const hits = await app.memory.search(session, { query_text: "blue-green strategy", top_k: 5 });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.type, "DOCUMENT");

    const fetched = await app.memory.getDocument(session, doc.document_id);
    assert.equal(fetched?.title, "Nebula Notes");
    assert.equal(fetched?.source_type, "markdown");
  } finally {
    app.close();
  }
});

test("document ingestion is idempotent: same request id + same content returns the same document", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const first = await app.memory.ingestDocument(
      session,
      { title: "Replay Doc", source_type: "text", content: "Replay content with a unique token glorp." },
      "doc-idem-1",
    );
    const replay = await app.memory.ingestDocument(
      session,
      { title: "Replay Doc", source_type: "text", content: "Replay content with a unique token glorp." },
      "doc-idem-1",
    );
    assert.equal(replay.document_id, first.document_id);
    const docs = await app.memory.listDocuments(session);
    assert.equal(docs.length, 1, "replaying an ingestion must not create duplicates");
  } finally {
    app.close();
  }
});

test("same client request id with different content is rejected", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    await app.memory.ingestDocument(
      session,
      { title: "One", source_type: "text", content: "Content number one here." },
      "doc-conflict-1",
    );
    await assert.rejects(
      () =>
        app.memory.ingestDocument(
          session,
          { title: "One", source_type: "text", content: "Completely different content." },
          "doc-conflict-1",
        ),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
  } finally {
    app.close();
  }
});

test("identical content ingested with a different request id converges to one document", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const content = "Identical body text for convergence checking.";
    const a = await app.memory.ingestDocument(session, { title: "A", source_type: "text", content }, "doc-conv-a");
    const b = await app.memory.ingestDocument(session, { title: "B", source_type: "text", content }, "doc-conv-b");
    assert.equal(a.document_id, b.document_id, "content-hash identity prevents duplicate documents");
    assert.equal((await app.memory.listDocuments(session)).length, 1);
  } finally {
    app.close();
  }
});

test("document deletion removes content from retrieval and FTS", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const doc = await app.memory.ingestDocument(
      session,
      { title: "To Delete", source_type: "text", content: "This document mentions koi ponds extensively." },
      "doc-del-1",
    );
    assert.equal((await app.memory.search(session, { query_text: "koi ponds" })).length, 1);

    const result = await app.memory.deleteDocument(session, doc.document_id);
    assert.ok(result.deletedMemories >= 1);
    assert.ok(result.deletedChunks >= 1);

    assert.equal((await app.memory.search(session, { query_text: "koi ponds" })).length, 0);
    assert.equal((await app.memory.getDocument(session, doc.document_id)), null);
    assert.equal((await app.memory.listDocuments(session)).length, 0);
  } finally {
    app.close();
  }
});

test("document ingestion is domain-isolated", async () => {
  const app = buildTestApp();
  try {
    const personalSession = await newSession(app, "personal");
    const businessSession = await newSession(app, "business");
    await app.memory.ingestDocument(
      personalSession,
      { title: "Personal Diary", source_type: "text", content: "Personal diary entry about hiking." },
      "doc-iso-p",
    );
    await app.memory.ingestDocument(
      businessSession,
      { title: "Business Deck", source_type: "text", content: "Business deck about revenue targets." },
      "doc-iso-b",
    );

    const personalHits = await app.memory.search(personalSession, { query_text: "revenue targets", top_k: 20 });
    for (const hit of personalHits) assert.ok(!hit.text.includes("revenue targets"), "personal domain must never serve business documents");
    const businessHits = await app.memory.search(businessSession, { query_text: "hiking", top_k: 20 });
    for (const hit of businessHits) assert.ok(!hit.text.includes("hiking"), "business domain must never serve personal documents");
    assert.equal((await app.memory.listDocuments(personalSession)).length, 1);
    assert.equal((await app.memory.listDocuments(businessSession)).length, 1);
  } finally {
    app.close();
  }
});

test("long documents are chunked at semantic boundaries", async () => {
  const app = buildTestApp({ memoryMaxSingleChunkTokens: 40 });
  try {
    const session = await newSession(app, "personal");
    const longDoc = [
      "First paragraph about alpha particles and their decay chains in the laboratory.",
      "Second paragraph about beta radiation shielding requirements for the facility.",
      "Third paragraph about gamma detectors calibration procedure on site.",
    ].join("\n\n");
    const doc = await app.memory.ingestDocument(
      session,
      { title: "Radiation", source_type: "text", content: longDoc },
      "doc-chunk-1",
    );
    assert.ok(doc.chunk_count > 1, `expected multiple chunks, got ${doc.chunk_count}`);
    // All paragraphs remain searchable.
    assert.equal((await app.memory.search(session, { query_text: "alpha particles" })).length, 1);
    assert.equal((await app.memory.search(session, { query_text: "gamma detectors calibration" })).length, 1);
  } finally {
    app.close();
  }
});