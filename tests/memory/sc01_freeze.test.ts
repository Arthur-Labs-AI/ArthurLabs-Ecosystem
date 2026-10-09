/**
 * SC-01 freeze regression suite (Software Core v1, SC-01 acceptance F01-F15).
 *
 * Deterministic and offline: no DeepSeek API, microphone, wake model, Piper,
 * Whisper, or network. Each gate maps to the SC-01 acceptance matrix:
 * F01 logical isolation, F02 path/alias isolation, F03 symlink/hardlink
 * rejection, F04 schema/migration compatibility, F05 corrupt/newer fail-closed,
 * F06 WAL+FULL+FK storage policy, F07 restart/process-crash persistence,
 * F08 idempotency and concurrency, F09 delete/supersede/expiry lifecycle,
 * F10 document delete then re-ingest, F11 secret persistence/embedding
 * isolation, F12 FTS/vector/hybrid lifecycle exclusion, F13 strict context
 * token budget, F14 SQLite + foreign-key integrity, F15 FTS/index consistency.
 * (F16 full repository regression runs as the whole offline suite.)
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, linkSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { test } from "node:test";
import assert from "node:assert/strict";

import { DatabaseSync } from "node:sqlite";
import { ArthurError } from "../../src/core/errors/errors";
import { loadSettings } from "../../src/config/settings";
import { validateSettings } from "../../src/config/validation";
import { SecretSanitizer } from "../../src/security/sanitize";
import { estimateTokens } from "../../src/observability/usage";
import { FakeProvider } from "../../src/models/providers/fake";
import type { ModelRequest } from "../../src/models/contracts";
import {
  assertDistinctMemoryDatabases,
  resolveMemoryDbIdentity,
} from "../../src/memory/stores/memory_db_identity";
import {
  BusinessMemoryStore,
  CURRENT_MEMORY_SCHEMA_VERSION,
  PersonalMemoryStore,
} from "../../src/memory/stores/sqlite_memory_store";
import { verifyMemoryDatabase } from "../../src/memory/stores/memory_integrity";
import { buildTestApp, validTurn } from "../helpers";

const PERSONAL_SENTINEL = "SC01_PERSONAL_SENTINEL_ZULU";
const BUSINESS_SENTINEL = "SC01_BUSINESS_SENTINEL_OSCAR";
const SECRET_MARKER = "SC01_SUPER_SECRET_MARKER_9Z9Q";

async function newSession(app: ReturnType<typeof buildTestApp>, mode: "personal" | "business"): Promise<string> {
  const response = await app.conversation.handleTurn(validTurn({ mode, message: "start" }));
  return response.session_id;
}

function fileSettings(personalDb: string, businessDb: string) {
  const dir = mkdtempSync(join(tmpdir(), "sc01-freeze-"));
  return {
    dir,
    personalDb: join(dir, personalDb),
    businessDb: join(dir, businessDb),
  };
}

function pragmaCell(db: DatabaseSync, pragma: string): string {
  const row = db.prepare("PRAGMA " + pragma + ";").get() as Record<string, unknown> | undefined;
  return String(row === undefined ? "" : Object.values(row)[0] ?? "").toLowerCase();
}

// ---- F01: Personal/Business logical isolation ---------------------------------

test("SC01-F01 personal/business logical isolation across all public operations", async () => {
  const app = buildTestApp();
  try {
    const personal = await newSession(app, "personal");
    const business = await newSession(app, "business");
    await app.memory.remember(personal, { text: "Personal fact " + PERSONAL_SENTINEL, type: "SEMANTIC", client_request_id: "sc01-f01-p" });
    await app.memory.remember(business, { text: "Business fact " + BUSINESS_SENTINEL, type: "SEMANTIC", client_request_id: "sc01-f01-b" });
    const doc = await app.memory.ingestDocument(personal, { title: "P doc", source_type: "text", content: "Personal document " + PERSONAL_SENTINEL }, "sc01-f01-doc-p");
    const personalHits = await app.memory.search(personal, { query_text: BUSINESS_SENTINEL, top_k: 20 });
    for (const hit of personalHits) {
      assert.ok(!hit.text.includes(BUSINESS_SENTINEL), "personal search must not return business memory");
    }
    const businessHits = await app.memory.search(business, { query_text: PERSONAL_SENTINEL, top_k: 20 });
    for (const hit of businessHits) {
      assert.ok(!hit.text.includes(PERSONAL_SENTINEL), "business search must not return personal memory");
    }
    const otherList = await app.memory.list(personal, { domain: "personal" });
    assert.ok(otherList.every((m) => !m.text.includes(BUSINESS_SENTINEL)));
    const fetched = await app.memory.getDocument(personal, doc.document_id);
    assert.ok(fetched, "own-domain document must be readable");
    assert.equal(await app.memory.getDocument(business, doc.document_id), null, "foreign-domain document must not leak");
    const foreign = await app.memory.remember(business, { text: "Second business fact " + BUSINESS_SENTINEL, type: "SEMANTIC", client_request_id: "sc01-f01-b2" });
    await assert.rejects(
      () => app.memory.forget(personal, foreign.id),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    const turn = await app.conversation.handleTurn(validTurn({ session_id: personal, message: "Personal fact " + PERSONAL_SENTINEL }));
    assert.equal(turn.status, "completed");
  } finally {
    app.close();
  }
});

// ---- F02: physical path/alias isolation ----------------------------------------

test("SC01-F02 same literal, relative, dotdot, and case aliases are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc01-f02-"));
  const same = join(dir, "memory.db");
  assert.throws(() => assertDistinctMemoryDatabases(same, same), /different physical files/);
  const rel = join(dir, "rel-alias.db");
  const relAlias = join(dir, ".", "rel-alias.db");
  const relAlias2 = join(dir, "sub", "..", "rel-alias.db");
  assert.throws(() => assertDistinctMemoryDatabases(rel, relAlias), /different physical files/);
  assert.throws(() => assertDistinctMemoryDatabases(rel, relAlias2), /different physical files/);
  const dotdot = join(dir, "sub", "..", "memory.db");
  assert.throws(() => assertDistinctMemoryDatabases(same, dotdot), /different physical files/);
  const identity = resolveMemoryDbIdentity(same);
  assert.ok(identity.canonical.length > 0, "identity must resolve a canonical path");
  assert.equal(identity.exists, false, "missing database resolves through its parent");
  if (process.platform === "win32") {
    assert.throws(() => assertDistinctMemoryDatabases(same, same.toUpperCase()), /different physical files/);
  }
  assert.throws(
    () => validateSettings(loadSettings({ memoryPersonalDbPath: same, memoryBusinessDbPath: dotdot })),
    (err: unknown) => err instanceof ArthurError && err.code === "INVALID_CONFIG",
  );
});

// ---- F03: symlink/hardlink alias rejection --------------------------------------

test("SC01-F03 symlink, symlinked-parent, and hardlink aliases are rejected", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sc01-f03-"));
  const target = join(dir, "memory-personal.db");
  const seed = new PersonalMemoryStore(target, new SecretSanitizer([]));
  seed.close();
  let fileLinkSupported = true;
  try {
    symlinkSync(target, join(dir, "memory-business-link.db"));
  } catch {
    fileLinkSupported = false;
  }
  if (fileLinkSupported) {
    assert.throws(
      () => assertDistinctMemoryDatabases(target, join(dir, "memory-business-link.db")),
      /different physical files|same physical file/,
    );
  } else {
    await t.skip("OS does not allow file symlinks");
  }
  const realSub = join(dir, "real-sub");
  mkdirSync(realSub, { recursive: true });
  let dirLinkSupported = true;
  try {
    symlinkSync(realSub, join(dir, "linked-sub"));
  } catch {
    dirLinkSupported = false;
  }
  if (dirLinkSupported) {
    const viaReal = join(realSub, "memory.db");
    const viaLink = join(dir, "linked-sub", "memory.db");
    const probe = new PersonalMemoryStore(viaReal, new SecretSanitizer([]));
    probe.close();
    assert.throws(() => assertDistinctMemoryDatabases(viaReal, viaLink), /different physical files|same physical file/);
  } else {
    await t.skip("OS does not allow directory symlinks");
  }
  let hardlinkSupported = true;
  try {
    linkSync(target, join(dir, "memory-business-hard.db"));
  } catch {
    hardlinkSupported = false;
  }
  if (hardlinkSupported) {
    assert.throws(
      () => assertDistinctMemoryDatabases(target, join(dir, "memory-business-hard.db")),
      /different physical files|same physical file/,
    );
  } else {
    await t.skip("OS does not allow hardlinks");
  }
  // ":memory:" handles are always distinct databases: both allowed together,
  // and one in-memory + one file-backed is allowed (physically separate).
  assert.doesNotThrow(() => assertDistinctMemoryDatabases(":memory:", ":memory:"));
  assert.doesNotThrow(() => assertDistinctMemoryDatabases(":memory:", target));
});

// ---- F04: schema/migration compatibility ----------------------------------------

test("SC01-F04 frozen schema version, contract validation, and migration ledger", async () => {
  assert.equal(CURRENT_MEMORY_SCHEMA_VERSION, 1, "frozen schema version must be explicit");
  const dir = mkdtempSync(join(tmpdir(), "sc01-f04-"));
  const path = join(dir, "memory-personal.db");
  const store = new PersonalMemoryStore(path, new SecretSanitizer([]));
  try {
    const db = (store as unknown as { db: DatabaseSync }).db;
    const migrations = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string }>;
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0]?.version, 1);
    assert.equal(migrations[0]?.name, "memory_schema");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = \u0027table\u0027 ORDER BY name").all() as Array<{ name: string }>;
    for (const expected of ["schema_migrations", "memory_items", "memory_chunks", "memory_sources", "ingestion_requests", "memory_fts5"]) {
      assert.ok(tables.some((row) => row.name === expected), "expected table " + expected);
    }
    const chunkFk = db.prepare("PRAGMA foreign_key_list(memory_chunks)").all() as Array<{ from: string; table: string; to: string; on_delete: string }>;
    const fk = chunkFk.find((row) => row.from === "memory_id");
    assert.ok(fk && fk.table === "memory_items" && fk.to === "id" && fk.on_delete === "CASCADE");
    const itemIndexes = db.prepare("PRAGMA index_list(memory_items)").all() as Array<{ name: string }>;
    assert.ok(itemIndexes.some((row) => row.name === "uq_items_active_hash"));
    const sourceIndexes = db.prepare("PRAGMA index_list(memory_sources)").all() as Array<{ name: string }>;
    assert.ok(sourceIndexes.some((row) => row.name === "uq_sources_hash"));
    const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = \u0027memory_fts5\u0027").get() as { sql: string };
    assert.match(ftsSql.sql, /fts5/i);
  } finally {
    store.close();
  }
});

// ---- F05: corrupt/newer DB fail-closed -------------------------------------------

test("SC01-F05 newer schema, unknown migration, missing table, and wrong-domain rows fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc01-f05-"));
  const newerPath = join(dir, "newer.db");
  {
    const seed = new PersonalMemoryStore(newerPath, new SecretSanitizer([]));
    seed.close();
    const raw = new DatabaseSync(newerPath);
    try {
      raw.prepare("INSERT INTO schema_migrations (version, name) VALUES (999, \u0027future\u0027)").run();
    } finally {
      raw.close();
    }
    assert.throws(() => new PersonalMemoryStore(newerPath, new SecretSanitizer([])), /newer than supported|newer/);
  }
  const corruptPath = join(dir, "corrupt.db");
  {
    const seed = new PersonalMemoryStore(corruptPath, new SecretSanitizer([]));
    seed.close();
    const raw = new DatabaseSync(corruptPath);
    try {
      raw.exec("DROP TABLE memory_chunks;");
    } finally {
      raw.close();
    }
    assert.throws(() => new PersonalMemoryStore(corruptPath, new SecretSanitizer([])), /schema validation failed|missing/);
  }
  const domainPath = join(dir, "domain.db");
  {
    const seed = new PersonalMemoryStore(domainPath, new SecretSanitizer([]));
    seed.close();
    const raw = new DatabaseSync(domainPath, { enableForeignKeyConstraints: false });
    try {
      raw.prepare("INSERT INTO memory_items (id, domain, type, source_type, canonical_text, display_text, content_hash, confidence, importance, sensitivity, status, created_at, updated_at, embedding_model, embedding_version) VALUES (\u0027x\u0027, \u0027business\u0027, \u0027SEMANTIC\u0027, \u0027USER_EXPLICIT\u0027, \u0027t\u0027, \u0027t\u0027, \u0027h\u0027, 1, 1, \u0027NORMAL\u0027, \u0027ACTIVE\u0027, \u0027t\u0027, \u0027t\u0027, \u0027m\u0027, \u0027v\u0027)").run();
    } finally {
      raw.close();
    }
    assert.throws(() => new PersonalMemoryStore(domainPath, new SecretSanitizer([])), /domain purity|schema validation failed/);
  }
});

// ---- F06: storage policy ----------------------------------------------------------

test("SC01-F06 file-backed stores enforce WAL + FULL + FK + busy_timeout", async () => {
  const { dir, personalDb, businessDb } = fileSettings("memory-personal.db", "memory-business.db");
  void dir;
  const personal = new PersonalMemoryStore(personalDb, new SecretSanitizer([]));
  const business = new BusinessMemoryStore(businessDb, new SecretSanitizer([]));
  try {
    for (const store of [personal, business]) {
      const db = (store as unknown as { db: DatabaseSync }).db;
      assert.equal(pragmaCell(db, "journal_mode"), "wal");
      const syncRow = db.prepare("PRAGMA synchronous;").get() as Record<string, unknown>;
      assert.equal(Number(Object.values(syncRow)[0]), 2);
      assert.equal(pragmaCell(db, "foreign_keys"), "1");
      const timeoutRow = db.prepare("PRAGMA busy_timeout;").get() as Record<string, unknown>;
      assert.equal(Number(Object.values(timeoutRow)[0]), 10000);
    }
    assert.ok(existsSync(personalDb) && existsSync(businessDb));
  } finally {
    personal.close();
    business.close();
  }
});

// ---- F07: restart + process-crash persistence ---------------------------------------

test("SC01-F07 restart persistence and process-crash durability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc01-f07-"));
  const base = { dbPath: join(dir, "arthur.db"), memoryPersonalDbPath: join(dir, "memory-personal.db"), memoryBusinessDbPath: join(dir, "memory-business.db") };
  const app1 = buildTestApp(base);
  let session: string;
  let memoryId: string;
  let documentId: string;
  try {
    session = await newSession(app1, "personal");
    const item = await app1.memory.remember(session, { text: "SC01 crash-durable fact about the stone cellar.", type: "SEMANTIC", client_request_id: "sc01-f07-1" });
    memoryId = item.id;
    const doc = await app1.memory.ingestDocument(session, { title: "SC01 durable doc", source_type: "text", content: "SC01 durable document about the north orchard." }, "sc01-f07-doc");
    documentId = doc.document_id;
  } finally {
    app1.close();
  }
  const childScript = join(dir, "sc01-child.cjs");
  const childResult = join(dir, "sc01-child-result.txt");
  const helpersPath = resolve("dist/tests/helpers.js");
  const childLines = [
    "const fs = require(\"node:fs\");",
    "const { buildTestApp } = require(" + JSON.stringify(helpersPath) + ");",
    "(async () => {",
    "  const app = buildTestApp(" + JSON.stringify(base) + ");",
    "  try {",
    "    const turn = await app.conversation.handleTurn({ mode: \"personal\", message: \"start\", client_request_id: \"sc01-f07-child\" });",
    "    const item = await app.memory.remember(turn.session_id, { text: \"SC01 child-crash fact about the copper boiler.\", type: \"SEMANTIC\", client_request_id: \"sc01-f07-child\" });",
    "    fs.writeFileSync(" + JSON.stringify(childResult) + ", \"COMMITTED \" + item.id + \"\\n\");",
    "  } finally {",
    "    app.close();",
    "  }",
    "})().catch((e) => { try { require(\"node:fs\").writeFileSync(" + JSON.stringify(childResult) + ", \"FAILED \" + String((e && e.stack) || e)); } catch {} process.exitCode = 1; });",
    "",
  ];
  writeFileSync(childScript, childLines.join("\n"));
  // NOTE: piped stdio is unavailable in some sandboxes (EPERM), so the child
  // reports through a result file and inherits stdio.
  const child = spawnSync(process.execPath, [childScript], { stdio: "ignore" });
  const childError = (child as unknown as { error?: Error }).error;
  assert.ok(!childError, "child process must spawn: " + String(childError ?? ""));
  assert.equal(child.status, 0, "child process must commit and exit");
  const { readFileSync: readChildResult } = await import("node:fs");
  const childOutput = readChildResult(childResult, "utf8");
  assert.ok(childOutput.startsWith("COMMITTED "), "child must report the committed id, got: " + childOutput.slice(0, 200));
  const childId = childOutput.split("COMMITTED ")[1]?.trim().split(/\s/)[0] ?? "";
  assert.ok(childId.length > 0, "child must report the committed id");
  const app2 = buildTestApp(base);
  try {
    const hits = await app2.memory.search(session, { query_text: "stone cellar" });
    assert.ok(hits.some((h) => h.memory_id === memoryId), "remembered fact must survive restart");
    const docs = await app2.memory.listDocuments(session);
    assert.ok(docs.some((d) => d.document_id === documentId), "document must survive restart");
    const childHits = await app2.memory.search(session, { query_text: "copper boiler", top_k: 10 });
    assert.ok(childHits.some((h) => h.memory_id === childId), "child-committed memory must exist after the child exited");
  } finally {
    app2.close();
  }
});

// ---- F08: idempotency and concurrency ------------------------------------------------

test("SC01-F08 idempotent replay, key binding, and concurrent convergence", async () => {
  const app = buildTestApp();
  try {
    const session = await newSession(app, "personal");
    const first = await app.memory.remember(session, { text: "SC01 idempotent fact about the oak stair.", type: "SEMANTIC", client_request_id: "sc01-f08-1" });
    const replay = await app.memory.remember(session, { text: "SC01 idempotent fact about the oak stair.", type: "SEMANTIC", client_request_id: "sc01-f08-1" });
    assert.equal(replay.id, first.id);
    await assert.rejects(
      () => app.memory.remember(session, { text: "Different content for the same key.", type: "SEMANTIC", client_request_id: "sc01-f08-1" }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    const [a, b] = await Promise.all([
      app.memory.remember(session, { text: "SC01 concurrent fact about the brass lantern.", type: "SEMANTIC", client_request_id: "sc01-f08-race" }),
      app.memory.remember(session, { text: "SC01 concurrent fact about the brass lantern.", type: "SEMANTIC", client_request_id: "sc01-f08-race" }),
    ]);
    assert.equal(a.id, b.id);
    const [docA, docB] = await Promise.all([
      app.memory.ingestDocument(session, { title: "Race", source_type: "text", content: "SC01 concurrent document about the iron gate." }, "sc01-f08-doc"),
      app.memory.ingestDocument(session, { title: "Race", source_type: "text", content: "SC01 concurrent document about the iron gate." }, "sc01-f08-doc"),
    ]);
    assert.equal(docA.document_id, docB.document_id);
    const personal = await newSession(app, "personal");
    const business = await newSession(app, "business");
    await Promise.all([
      app.memory.remember(personal, { text: "SC01 personal concurrent marker.", type: "SEMANTIC", client_request_id: "sc01-f08-p" }),
      app.memory.remember(business, { text: "SC01 business concurrent marker.", type: "SEMANTIC", client_request_id: "sc01-f08-b" }),
    ]);
    assert.ok((await app.memory.search(personal, { query_text: "personal concurrent marker" })).length >= 1);
    assert.ok((await app.memory.search(business, { query_text: "business concurrent marker" })).length >= 1);
  } finally {
    app.close();
  }
});

// ---- F09: delete/supersede/expiry lifecycle --------------------------------------------

test("SC01-F09 ACTIVE retrievable; SUPERSEDED/EXPIRED/DELETED excluded and listed", async () => {
  const app = buildTestApp({ memoryTemporaryTtlSeconds: 1 });
  try {
    const session = await newSession(app, "personal");
    const item = await app.memory.remember(session, { text: "SC01 lifecycle fact about the cedar chest.", type: "SEMANTIC", client_request_id: "sc01-f09-1" });
    assert.equal((await app.memory.search(session, { query_text: "SC01 lifecycle fact about the cedar chest" })).length, 1);
    const old = await app.memory.remember(session, { text: "SC01 correction source: the shed color is green.", type: "SEMANTIC", subject_key: "shed-color", client_request_id: "sc01-f09-old" });
    const replacement = await app.memory.remember(session, { text: "SC01 correction update: the shed color is now blue.", type: "SEMANTIC", subject_key: "shed-color", client_request_id: "sc01-f09-new" });
    assert.notEqual(replacement.id, old.id);
    const stale = await app.memory.search(session, { query_text: "shed color is green", top_k: 10 });
    for (const hit of stale) assert.ok(!hit.text.includes("is green"), "superseded memory must not be retrieved");
    const temp = await app.memory.remember(session, { text: "SC01 one-time code for the side gate today unique-tail-quasar.", type: "TEMPORARY", client_request_id: "sc01-f09-tmp" });
    assert.equal(temp.status, "ACTIVE");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const tempHits = await app.memory.search(session, { query_text: "unique-tail-quasar", top_k: 10 });
    for (const hit of tempHits) assert.ok(!hit.text.includes("unique-tail-quasar"), "expired memory must not be retrieved");
    await app.memory.forget(session, item.id);
    assert.equal((await app.memory.search(session, { query_text: "cedar chest", top_k: 10 })).length, 0);
    assert.equal((await app.memory.list(session, { domain: "personal", status: "SUPERSEDED" })).length, 1);
    assert.equal((await app.memory.list(session, { domain: "personal", status: "DELETED" })).length, 1);
    assert.equal((await app.memory.list(session, { domain: "personal", status: "EXPIRED" })).length, 1);
  } finally {
    app.close();
  }
});

// ---- F10: document delete then re-ingest --------------------------------------------------

test("SC01-F10 deleted document re-ingests as a fresh ACTIVE incarnation (both key reuses)", async () => {
  for (const reuse of ["new-key", "original-key"] as const) {
    const app = buildTestApp();
    try {
      const session = await newSession(app, "personal");
      const content = "SC01 re-ingest document about the marble fountain " + reuse + ".";
      const first = await app.memory.ingestDocument(session, { title: "Fountain", source_type: "text", content }, "sc01-f10-" + reuse + "-a");
      const firstMemory = first.memory_ids[0] ?? "";
      assert.ok(firstMemory.length > 0);
      assert.equal((await app.memory.search(session, { query_text: "marble fountain " + reuse })).length, 1);
      await app.memory.deleteDocument(session, first.document_id);
      assert.equal((await app.memory.search(session, { query_text: "marble fountain " + reuse, top_k: 10 })).length, 0);
      const requestKey = reuse === "original-key" ? "sc01-f10-" + reuse + "-a" : "sc01-f10-" + reuse + "-b";
      const second = await app.memory.ingestDocument(session, { title: "Fountain", source_type: "text", content }, requestKey);
      assert.equal(second.document_id, first.document_id, "stable document identity is preserved");
      const secondMemory = second.memory_ids[0] ?? "";
      assert.ok(secondMemory.length > 0);
      assert.notEqual(secondMemory, firstMemory, "re-ingestion must create a fresh memory incarnation");
      const hits = await app.memory.search(session, { query_text: "marble fountain " + reuse, top_k: 10 });
      assert.ok(hits.some((h) => h.memory_id === secondMemory), "fresh incarnation must be retrievable");
      const gateway = (app.memory as unknown as { gateway: { personal: PersonalMemoryStore } }).gateway;
      const tombstone = await gateway.personal.get(firstMemory);
      assert.equal(tombstone?.status, "DELETED", "old incarnation stays a tombstone");
    } finally {
      app.close();
    }
  }
});

// ---- F11: secret persistence/embedding isolation ----------------------------------------------

test("SC01-F11 secrets never reach embeddings or persistence in any textual surface", async () => {
  const seenByEmbedding: string[] = [];
  const { FakeEmbeddingProvider } = await import("../../src/memory/embeddings/providers/fake");
  const originalEmbed = FakeEmbeddingProvider.prototype.embed;
  FakeEmbeddingProvider.prototype.embed = async function (texts: string[]): Promise<number[][]> {
    seenByEmbedding.push(...texts);
    return originalEmbed.call(this, texts);
  };
  const dir = mkdtempSync(join(tmpdir(), "sc01-f11-"));
  const app = buildTestApp(
    { dbPath: join(dir, "arthur.db"), memoryPersonalDbPath: join(dir, "memory-personal.db"), memoryBusinessDbPath: join(dir, "memory-business.db") },
  );
  try {
    const session = await newSession(app, "personal");
    const before = seenByEmbedding.length;
    await assert.rejects(
      () => app.memory.remember(session, { text: "password=" + SECRET_MARKER, type: "SEMANTIC" }),
      (err: unknown) => err instanceof ArthurError && err.code === "INVALID_REQUEST",
    );
    assert.equal(seenByEmbedding.length, before, "secret-like explicit memory must never reach embeddings");
    // Credential-shaped document content is sanitized (not rejected): the raw
    // marker must never reach persistence or the embedding model.
    const doc = await app.memory.ingestDocument(
      session,
      { title: "Secret doc", source_type: "text", content: "Server password=" + SECRET_MARKER + " for staging use." },
      "sc01-f11-doc",
    );
    assert.ok(doc.document_id.startsWith("doc-"));
    const personalDb = join(dir, "memory-personal.db");
    app.close();
    const raw = new DatabaseSync(personalDb);
    try {
      const tables = ["memory_items", "memory_chunks", "memory_fts5", "memory_sources"];
      for (const table of tables) {
        const rows = raw.prepare("SELECT * FROM " + table).all() as Array<Record<string, unknown>>;
        const dumped = JSON.stringify(rows);
        assert.ok(!dumped.includes(SECRET_MARKER), "raw secret must not persist in " + table);
      }
    } finally {
      raw.close();
    }
    for (const text of seenByEmbedding) {
      assert.ok(!text.includes(SECRET_MARKER), "raw secret must never be sent to embeddings");
    }
  } finally {
    FakeEmbeddingProvider.prototype.embed = originalEmbed;
    try { app.close(); } catch { /* already closed */ }
  }
});

test("SC01-F11 model payload never carries raw secrets, vectors, paths, or corpus", async () => {
  let captured: ModelRequest | undefined;
  const provider = new FakeProvider({
    responder: (req) => {
      captured = req;
      return { assistant_text: "ok", tool_calls: [], finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  const app = buildTestApp({}, { provider });
  try {
    const session = await newSession(app, "personal");
    await assert.rejects(() => app.memory.remember(session, { text: "password=" + SECRET_MARKER, type: "SEMANTIC" }));
    await app.memory.remember(session, { text: "Benign fact about the garden trellis.", type: "SEMANTIC", client_request_id: "sc01-f11-benign" });
    await app.conversation.handleTurn(validTurn({ session_id: session, message: "garden trellis", client_request_id: "sc01-f11-turn" }));
    const dumped = JSON.stringify(captured ?? {});
    assert.ok(!dumped.includes(SECRET_MARKER));
    assert.ok(!dumped.includes("memory-personal.db"));
    assert.ok(!dumped.toLowerCase().includes("embedding_blob"));
  } finally {
    app.close();
  }
});

// ---- F12: FTS/vector/hybrid lifecycle exclusion ------------------------------------------------

test("SC01-F12 SUPERSEDED/EXPIRED/DELETED excluded from vector, FTS, and hybrid channels", async () => {
  const app = buildTestApp({ memoryTemporaryTtlSeconds: 1 });
  try {
    const session = await newSession(app, "personal");
    const gateway = (app.memory as unknown as { gateway: { personal: PersonalMemoryStore } }).gateway;
    const store = gateway.personal;
    const mk = async (text: string, key: string) => app.memory.remember(session, { text, type: "SEMANTIC", client_request_id: key });
    const active = await mk("SC01 channel fact about the active greenhouse vent.", "sc01-f12-active");
    const doomed = await mk("SC01 channel fact about the doomed potting bench.", "sc01-f12-doomed");
    await app.memory.forget(session, doomed.id);
    const old = await mk("SC01 channel subject orchid-color is green.", "sc01-f12-old");
    void old;
    await mk("SC01 channel subject orchid-color is now magenta with glitter.", "sc01-f12-new");
    const temp = await app.memory.remember(session, { text: "SC01 channel one-time code for the east door unique-tail-pulsar.", type: "TEMPORARY", client_request_id: "sc01-f12-tmp" });
    void temp;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    store.expireDue();
    const vectorHits = await store.vectorSearch({ vector: (await store.getChunks(active.id))[0]?.embedding ?? [], filters: { domain: "personal" }, limit: 50 });
    for (const hit of vectorHits) {
      assert.ok(hit.memory_id !== doomed.id, "deleted memory must not appear in vector results");
    }
    const ftsHits = await store.keywordSearch({ text: "SC01 channel", filters: { domain: "personal" }, limit: 50 });
    const listed = await app.memory.search(session, { query_text: "SC01 channel", top_k: 20 });
    for (const hit of [...ftsHits, ...listed]) {
      const item = await store.get(hit.memory_id);
      assert.equal(item?.status, "ACTIVE", "every retrieved row must be ACTIVE");
    }
    assert.ok(listed.some((h) => h.memory_id === active.id), "ACTIVE memory must stay retrievable");
    for (const hit of listed) assert.ok(!hit.text.includes("unique-tail-pulsar"), "expired memory must not be retrieved");
  } finally {
    app.close();
  }
});

// ---- F13: strict context token budget ----------------------------------------------------------------

test("SC01-F13 total context tokens never exceed the configured maximum", async () => {
  const app = buildTestApp({ memoryMaxContextTokens: 120, memoryMaxSingleChunkTokens: 300 });
  try {
    const session = await newSession(app, "personal");
    for (let i = 0; i < 6; i++) {
      await app.memory.remember(session, { text: "SC01 budget marker item number " + String(i) + ": " + "x".repeat(160) + " with searchable content.", type: "SEMANTIC", client_request_id: "sc01-f13-" + String(i) });
    }
    const hits = await app.memory.search(session, { query_text: "SC01 budget marker item", top_k: 10 });
    const total = hits.reduce((sum, hit) => sum + estimateTokens(hit.text), 0);
    assert.ok(total <= 120, "total tokens " + String(total) + " must be within the configured 120");
    for (const hit of hits) {
      assert.ok(estimateTokens(hit.text) <= 300, "single snippet must respect the per-chunk cap");
    }
  } finally {
    app.close();
  }
});

// ---- F14/F15: integrity + FTS/index consistency --------------------------------------------------------------

test("SC01-F14/F15 file-backed databases verify: integrity, FK, FTS parity, domain purity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sc01-f1415-"));
  const base = { dbPath: join(dir, "arthur.db"), memoryPersonalDbPath: join(dir, "memory-personal.db"), memoryBusinessDbPath: join(dir, "memory-business.db") };
  const app = buildTestApp(base);
  let personalSession: string;
  let businessSession: string;
  try {
    personalSession = await newSession(app, "personal");
    businessSession = await newSession(app, "business");
    await app.memory.remember(personalSession, { text: "SC01 integrity personal fact about the stone arch.", type: "SEMANTIC", client_request_id: "sc01-f14-p" });
    await app.memory.remember(businessSession, { text: "SC01 integrity business fact about the quarterly ledger.", type: "SEMANTIC", client_request_id: "sc01-f14-b" });
    await app.memory.ingestDocument(personalSession, { title: "Integrity doc", source_type: "text", content: "SC01 integrity document about the copper weathervane." }, "sc01-f14-doc");
    const doomed = await app.memory.remember(personalSession, { text: "SC01 integrity doomed fact about the elm bench.", type: "SEMANTIC", client_request_id: "sc01-f14-doom" });
    await app.memory.forget(personalSession, doomed.id);
    void personalSession;
    void businessSession;
  } finally {
    app.close();
  }
  const personal = verifyMemoryDatabase(join(dir, "memory-personal.db"), { domain: "personal" });
  const business = verifyMemoryDatabase(join(dir, "memory-business.db"), { domain: "business" });
  assert.ok(personal.ok, "personal integrity must verify: " + personal.failures.join("; "));
  assert.ok(business.ok, "business integrity must verify: " + business.failures.join("; "));
  assert.deepEqual(personal.integrityCheck, ["ok"]);
  assert.equal(business.foreignKeyViolations.length, 0);
  assert.equal(personal.ftsWithoutChunk, 0);
  assert.equal(personal.chunksWithoutFts, 0);
  assert.equal(personal.duplicateFtsChunkEntries, 0);
  assert.equal(personal.wrongDomainRows, 0);
  copyFileSync(join(dir, "memory-personal.db"), join(dir, "memory-personal-copy.db"));
  assert.ok(verifyMemoryDatabase(join(dir, "memory-personal-copy.db"), { domain: "personal" }).ok);
});
