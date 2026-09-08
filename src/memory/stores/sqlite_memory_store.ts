/**
 * SQLite-backed memory store (spec sections 7, 11, 13, 14, 33).
 *
 * One store instance == one physical memory database (Personal or Business).
 * The two stores never share a connection or a query object. Each database
 * has its own independent migration chain, schema, FTS index, vector index
 * (embedding blobs) and ingestion idempotency state machine.
 *
 * Isolation is physical: the domain column exists only for validation/audit;
 * the store handle stamps its own domain on every write and every query is
 * scoped to it, so a cross-domain reference can never be created through a
 * shared connection (there is no shared connection).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SecretSanitizer } from "../../security/sanitize";
import { estimateTokens } from "../../observability/usage";
import { buildFtsQuery } from "../retrieval/keyword_search";
import { contentHash } from "../provenance";
import {
  IngestionRecord,
  IngestionReservation,
  KeywordHit,
  KeywordQuery,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_TYPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemoryChunk,
  MemoryChunkWrite,
  MemoryDomain,
  MemoryItem,
  MemoryItemSummary,
  MemoryListFilter,
  MemorySourceRecord,
  MemoryStore,
  MemoryWrite,
  VectorHit,
  VectorQuery,
} from "../contracts";
import { cosineSimilarity } from "../embeddings/contracts";

interface Migration {
  version: number;
  name: string;
  up: string | ((db: DatabaseSync) => void);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

const nowIso = (): string => new Date().toISOString();

/** SC-01C: frozen schema version. A database reporting a newer version always fails startup. */
export const CURRENT_MEMORY_SCHEMA_VERSION = 1;

const KNOWN_MEMORY_MIGRATIONS: ReadonlyArray<{ version: number; name: string }> = [{ version: 1, name: "memory_schema" }];

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "memory_schema",
    up: (db: DatabaseSync): void => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL CHECK(domain IN ('personal','business')),
          type TEXT NOT NULL CHECK(type IN ('EPISODIC','SEMANTIC','PROJECT','DOCUMENT','PROCEDURAL','TEMPORARY')),
          source_type TEXT NOT NULL CHECK(source_type IN ('USER_EXPLICIT','CONVERSATION','DOCUMENT','TOOL','SYSTEM')),
          source_id TEXT,
          subject_key TEXT,
          project_key TEXT,
          canonical_text TEXT NOT NULL,
          display_text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
          importance REAL NOT NULL CHECK(importance >= 0 AND importance <= 1),
          sensitivity TEXT NOT NULL CHECK(sensitivity IN ('NORMAL','PRIVATE','RESTRICTED')),
          status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED','DELETED','EXPIRED')),
          supersedes_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_verified_at TEXT,
          expires_at TEXT,
          embedding_model TEXT NOT NULL,
          embedding_version TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_items_status ON memory_items(status, expires_at);
        CREATE INDEX IF NOT EXISTS idx_items_project ON memory_items(status, project_key);
        CREATE INDEX IF NOT EXISTS idx_items_subject ON memory_items(status, subject_key, type);
        CREATE INDEX IF NOT EXISTS idx_items_source ON memory_items(source_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_items_active_hash ON memory_items(content_hash) WHERE status = 'ACTIVE';

        CREATE TABLE IF NOT EXISTS memory_chunks (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          text TEXT NOT NULL,
          token_count INTEGER NOT NULL CHECK(token_count >= 0),
          content_hash TEXT NOT NULL,
          embedding_blob BLOB,
          UNIQUE(memory_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_memory ON memory_chunks(memory_id);

        CREATE TABLE IF NOT EXISTS memory_sources (
          id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL CHECK(source_type IN ('USER_EXPLICIT','CONVERSATION','DOCUMENT','TOOL','SYSTEM')),
          source_external_id TEXT,
          title TEXT,
          source_hash TEXT NOT NULL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_sources_hash ON memory_sources(source_hash);

        CREATE TABLE IF NOT EXISTS ingestion_requests (
          request_id TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','writing','completed','failed')),
          result_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ingestion_state ON ingestion_requests(state);
      `);
      // FTS index is a separate virtual table (spec section 14).
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts5 USING fts5(
        chunk_id UNINDEXED,
        memory_id UNINDEXED,
        text,
        tokenize = 'unicode61'
      )`);
    },
  },
];

export interface MemorySchemaIssue {
  table: string;
  detail: string;
}

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
}

function columnInfo(db: DatabaseSync, table: string): Map<string, ColumnInfo> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; pk: number }>;
  return new Map(rows.map((row) => [row.name, { name: row.name, notnull: row.notnull, pk: row.pk }]));
}

function foreignKeys(db: DatabaseSync, table: string): Array<{ from: string; table: string; to: string; on_delete: string }> {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string; to: string; on_delete: string }>;
}

function indexList(db: DatabaseSync, table: string): Array<{ name: string; origin: string; partial: number }> {
  return db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; origin: string; partial: number }>;
}

function tableSql(db: DatabaseSync, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string | null } | undefined;
  return row?.sql ?? "";
}

/**
 * SC-01C structural contract: columns, primary keys, NOT NULL requirements,
 * the memory_chunks -> memory_items FK with ON DELETE CASCADE, critical
 * UNIQUE indexes, the FTS5 virtual table, and the known migration ledger.
 * Returns issues instead of throwing so the verifier can report them all.
 */
export function collectMemorySchemaIssues(db: DatabaseSync, expectedDomain: MemoryDomain): MemorySchemaIssue[] {
  const issues: MemorySchemaIssue[] = [];
  const required: Record<string, string[]> = {
    schema_migrations: ["version", "name"],
    memory_items: ["id", "domain", "type", "source_type", "canonical_text", "display_text", "content_hash", "confidence", "importance", "sensitivity", "status", "created_at", "updated_at", "embedding_model", "embedding_version"],
    memory_chunks: ["id", "memory_id", "ordinal", "text", "token_count", "content_hash"],
    memory_sources: ["id", "source_type", "source_hash", "created_at", "updated_at"],
    ingestion_requests: ["request_id", "request_hash", "state", "created_at", "updated_at"],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!tableExists(db, table)) {
      issues.push({ table, detail: `missing table ${table}` });
      continue;
    }
    const actual = columnInfo(db, table);
    for (const column of columns) {
      if (!actual.has(column)) issues.push({ table, detail: `missing column ${column}` });
    }
  }
  const items = columnInfo(db, "memory_items");
  if (items.get("id")?.pk !== 1) issues.push({ table: "memory_items", detail: "id must be the primary key" });
  for (const column of ["domain", "type", "source_type", "canonical_text", "display_text", "content_hash", "confidence", "importance", "sensitivity", "status", "created_at", "updated_at", "embedding_model", "embedding_version"]) {
    if (items.has(column) && items.get(column)?.notnull !== 1) issues.push({ table: "memory_items", detail: `NOT NULL required on ${column}` });
  }
  const chunks = columnInfo(db, "memory_chunks");
  if (chunks.get("id")?.pk !== 1) issues.push({ table: "memory_chunks", detail: "id must be the primary key" });
  for (const column of ["memory_id", "ordinal", "text", "token_count", "content_hash"]) {
    if (chunks.has(column) && chunks.get(column)?.notnull !== 1) issues.push({ table: "memory_chunks", detail: `NOT NULL required on ${column}` });
  }
  const chunkFk = foreignKeys(db, "memory_chunks").find((fk) => fk.from === "memory_id" && fk.table === "memory_items" && fk.to === "id");
  if (!chunkFk) {
    issues.push({ table: "memory_chunks", detail: "missing FOREIGN KEY (memory_id) REFERENCES memory_items(id)" });
  } else if (chunkFk.on_delete !== "CASCADE") {
    issues.push({ table: "memory_chunks", detail: "memory_chunks.memory_id must use ON DELETE CASCADE" });
  }
  const itemIndexes = new Set(indexList(db, "memory_items").map((entry) => entry.name));
  if (!itemIndexes.has("uq_items_active_hash")) issues.push({ table: "memory_items", detail: "missing UNIQUE index uq_items_active_hash" });
  const sourceIndexes = new Set(indexList(db, "memory_sources").map((entry) => entry.name));
  if (!sourceIndexes.has("uq_sources_hash")) issues.push({ table: "memory_sources", detail: "missing UNIQUE index uq_sources_hash" });
  if (!tableExists(db, "memory_fts5")) {
    issues.push({ table: "memory_fts5", detail: "missing FTS5 virtual table memory_fts5" });
  } else if (!/USING\s+fts5/i.test(tableSql(db, "memory_fts5"))) {
    issues.push({ table: "memory_fts5", detail: "memory_fts5 must be an FTS5 virtual table" });
  }
  const migrations = tableExists(db, "schema_migrations")
    ? (db.prepare("SELECT version, name FROM schema_migrations").all() as Array<{ version: number; name: string }>)
    : [];
  const known = new Map(KNOWN_MEMORY_MIGRATIONS.map((entry) => [entry.version, entry.name]));
  for (const row of migrations) {
    if (row.version > CURRENT_MEMORY_SCHEMA_VERSION) {
      issues.push({ table: "schema_migrations", detail: `database schema version ${String(row.version)} is newer than supported ${String(CURRENT_MEMORY_SCHEMA_VERSION)}` });
    } else if (known.get(row.version) !== row.name) {
      issues.push({ table: "schema_migrations", detail: `unknown migration ${String(row.version)}:${String(row.name)}` });
    }
  }
  const missing = KNOWN_MEMORY_MIGRATIONS.filter((entry) => !migrations.some((row) => row.version === entry.version));
  for (const entry of missing) issues.push({ table: "schema_migrations", detail: `missing migration ${String(entry.version)}:${entry.name}` });
  const foreign = tableExists(db, "memory_items")
    ? (db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE domain != ?").get(expectedDomain) as { n: number } | undefined)
    : undefined;
  if (foreign !== undefined && Number(foreign.n) > 0) {
    issues.push({ table: "memory_items", detail: `domain purity violated: ${String(foreign.n)} row(s) with domain != '${expectedDomain}'` });
  }
  return issues;
}

function validateSchema(db: DatabaseSync, expectedDomain: MemoryDomain): void {
  const issues = collectMemorySchemaIssues(db, expectedDomain);
  if (issues.length > 0) {
    throw new Error(`Memory schema validation failed: ${issues.map((issue) => `${issue.table}: ${issue.detail}`).join("; ")}`);
  }
}

function embedBlob(vector: number[] | undefined): Buffer | null {
  if (!vector || vector.length === 0) return null;
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer);
}

function blobToVector(blob: unknown): number[] | undefined {
  if (blob === null || blob === undefined) return undefined;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob as Uint8Array);
  return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4));
}

const CHUNK_ID_SEPARATOR = "#";

function chunkId(memoryId: string, ordinal: number): string {
  return `${memoryId}${CHUNK_ID_SEPARATOR}${ordinal}`;
}

export class SqliteMemoryStore implements MemoryStore {
  private db: DatabaseSync;
  private readonly domainValue: MemoryDomain;
  private readonly sanitizer: SecretSanitizer;

  constructor(dbPath: string, domain: MemoryDomain, sanitizer: SecretSanitizer = new SecretSanitizer([])) {
    this.domainValue = domain;
    this.sanitizer = sanitizer;
    const trimmed = dbPath.trim();
    const target = trimmed === ":memory:" ? ":memory:" : resolve(trimmed);
    if (target !== ":memory:") {
      mkdirSync(dirname(target), { recursive: true });
    }
    this.db = new DatabaseSync(target, { enableForeignKeyConstraints: true });
    try {
      // SC-01B/M4: enforce the frozen storage policy in a fixed order, then
      // verify the effective PRAGMA values instead of assuming they stuck.
      // foreign_keys + busy_timeout first (needed for safe migrations),
      // WAL + FULL only after migrations so a downgraded journal mode can
      // never silently back a persistent memory database.
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 10000;");
      this.migrate();
      if (target !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL;");
      }
      this.db.exec("PRAGMA synchronous = FULL;");
      this.verifyStoragePolicy(target);
      this.reconcileIngestions();
      this.expireDue();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * SC-01B: query back every enforced PRAGMA. A persistent database that
   * cannot run WAL + FULL + FK fails startup instead of silently
   * downgrading. ":memory:" databases are exempt from the WAL requirement.
   */
  private verifyStoragePolicy(target: string): void {
    const cell = (pragma: string): string => {
      const row = this.db.prepare(`PRAGMA ${pragma};`).get() as Record<string, unknown> | undefined;
      const value = row === undefined ? undefined : Object.values(row)[0];
      return String(value ?? "").toLowerCase();
    };
    const foreignKeys = cell("foreign_keys");
    if (foreignKeys !== "1") {
      throw new Error(`Memory storage policy failed: foreign_keys is ${foreignKeys || "unknown"} (expected ON)`);
    }
    const synchronous = this.db.prepare("PRAGMA synchronous;").get() as Record<string, unknown> | undefined;
    if (Number(Object.values(synchronous ?? {})[0]) !== 2) {
      throw new Error("Memory storage policy failed: synchronous is not FULL");
    }
    if (target !== ":memory:") {
      const journalMode = cell("journal_mode");
      if (journalMode !== "wal") {
        throw new Error(`Memory storage policy failed: journal_mode is ${journalMode || "unknown"} (expected WAL)`);
      }
    }
  }

  domain(): MemoryDomain {
    return this.domainValue;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private execWithBusyRetry(sql: string): void {
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec(sql);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 40 || !/locked|busy/i.test(message)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }

  private migrate(): void {
    this.execWithBusyRetry("BEGIN IMMEDIATE");
    try {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const rows = this.db.prepare("SELECT version, name FROM schema_migrations").all() as Array<{ version: number; name: string }>;
      // SC-01C: never open an unknown newer schema, never downgrade or
      // repair destructively — fail closed before touching user data.
      for (const row of rows) {
        if (row.version > CURRENT_MEMORY_SCHEMA_VERSION) {
          throw new Error(`Memory database schema version ${String(row.version)} is newer than supported ${String(CURRENT_MEMORY_SCHEMA_VERSION)} (fail-closed)`);
        }
        if (!KNOWN_MEMORY_MIGRATIONS.some((entry) => entry.version === row.version && entry.name === row.name)) {
          throw new Error(`Memory database has an unknown migration ${String(row.version)}:${String(row.name)} (fail-closed)`);
        }
      }
      const applied = new Set(rows.map((r) => r.version));
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        if (typeof migration.up === "string") this.db.exec(migration.up);
        else migration.up(this.db);
        this.db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name);
      }
      validateSchema(this.db, this.domainValue);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- items ---------------------------------------------------------------

  async put(item: MemoryWrite): Promise<MemoryItem> {
    const confidence = item.confidence;
    const importance = item.importance;
    if (!(confidence >= 0 && confidence <= 1)) throw new Error("memory confidence must be within 0..1");
    if (!(importance >= 0 && importance <= 1)) throw new Error("memory importance must be within 0..1");
    // putNow performs the insert with idempotent convergence (spec section 33).
    return this.putNow(item);
  }

  async get(id: string): Promise<MemoryItem | null> {
    const row = this.db.prepare("SELECT * FROM memory_items WHERE id = ? AND domain = ?").get(id, this.domainValue) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.toItem(row);
  }

  private toItem(row: Record<string, unknown>): MemoryItem {
    return {
      id: String(row.id),
      domain: row.domain as MemoryDomain,
      type: row.type as MemoryItem["type"],
      subject_key: row.subject_key === null ? undefined : String(row.subject_key),
      project_key: row.project_key === null ? undefined : String(row.project_key),
      source_type: row.source_type as MemoryItem["source_type"],
      source_id: row.source_id === null ? undefined : String(row.source_id),
      canonical_text: String(row.canonical_text),
      display_text: String(row.display_text),
      content_hash: String(row.content_hash),
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      sensitivity: row.sensitivity as MemoryItem["sensitivity"],
      status: row.status as MemoryItem["status"],
      supersedes_id: row.supersedes_id === null ? undefined : String(row.supersedes_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      last_verified_at: row.last_verified_at === null ? undefined : String(row.last_verified_at),
      expires_at: row.expires_at === null ? undefined : String(row.expires_at),
      embedding_model: String(row.embedding_model),
      embedding_version: String(row.embedding_version),
    };
  }

  private toSummary(row: Record<string, unknown>): MemoryItemSummary {
    return {
      id: String(row.id),
      type: row.type as MemoryItemSummary["type"],
      text: String(row.display_text),
      status: row.status as MemoryItemSummary["status"],
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      source_type: row.source_type as MemoryItemSummary["source_type"],
      source_id: row.source_id === null ? undefined : String(row.source_id),
      subject_key: row.subject_key === null ? undefined : String(row.subject_key),
      project_key: row.project_key === null ? undefined : String(row.project_key),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  async list(filter: MemoryListFilter): Promise<MemoryItemSummary[]> {
    const clauses = ["domain = ?"];
    const params: Array<string | number | null> = [this.domainValue];
    const status = filter.status ?? "ACTIVE";
    clauses.push("AND status = ?");
    params.push(status);
    if (filter.type !== undefined) {
      clauses.push("AND type = ?");
      params.push(filter.type);
    }
    if (filter.project_key !== undefined) {
      clauses.push("AND project_key = ?");
      params.push(filter.project_key);
    }
    if (filter.subject_key !== undefined) {
      clauses.push("AND subject_key = ?");
      params.push(filter.subject_key);
    }
    clauses.push("ORDER BY created_at DESC, rowid DESC");
    const limit = Math.min(filter.limit ?? 100, 1000);
    const offset = filter.offset ?? 0;
    clauses.push("LIMIT ? OFFSET ?");
    params.push(limit, offset);
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE ${clauses.join(" ")}`).all(...params) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.toSummary(row));
  }

  async findActiveByHash(contentHashHex: string): Promise<MemoryItem | null> {
    const row = this.db
      .prepare("SELECT * FROM memory_items WHERE domain = ? AND status = 'ACTIVE' AND content_hash = ? LIMIT 1")
      .get(this.domainValue, contentHashHex) as Record<string, unknown> | undefined;
    return row ? this.toItem(row) : null;
  }

  async findActiveBySubject(subjectKey: string, type: MemoryItem["type"]): Promise<MemoryItem[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE domain = ? AND status = 'ACTIVE' AND subject_key = ? AND type = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 20`,
      )
      .all(this.domainValue, subjectKey, type) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => this.toItem(row));
  }

  async supersede(oldId: string, replacement: MemoryWrite): Promise<MemoryItem> {
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE memory_items SET status = 'SUPERSEDED', updated_at = ? WHERE id = ? AND domain = ? AND status = 'ACTIVE'",
        )
        .run(nowIso(), oldId, this.domainValue);
      if (Number(changed.changes) !== 1) {
        throw new Error(`cannot supersede ${oldId}: no active memory with that id in the ${this.domainValue} store`);
      }
      const withLink: MemoryWrite = { ...replacement, supersedes_id: oldId };
      // put() is synchronous against the same DatabaseSync handle; awaiting here
      // keeps the transaction scope correct for callers.
      const item = this.putNow(withLink);
      return item;
    });
  }

  /** Synchronous put used inside transactions. Idempotent: an insert that
   *  collides with an existing row (same id, or same active content_hash from
   *  a concurrent duplicate write) converges on the existing row instead of
   *  failing — this is what makes concurrent/duplicate ingestion safe. */
  private putNow(item: MemoryWrite): MemoryItem {
    const id = item.id ?? randomUUID();
    const now = nowIso();
    const insert = this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_items (
           id, domain, type, source_type, source_id, subject_key, project_key,
           canonical_text, display_text, content_hash, confidence, importance,
           sensitivity, status, supersedes_id, created_at, updated_at,
           last_verified_at, expires_at, embedding_model, embedding_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.domainValue,
        item.type,
        item.source_type,
        item.source_id ?? null,
        item.subject_key ?? null,
        item.project_key ?? null,
        this.sanitizer.sanitizeText(item.canonical_text),
        this.sanitizer.sanitizeText(item.display_text),
        item.content_hash,
        item.confidence,
        item.importance,
        item.sensitivity ?? "NORMAL",
        item.supersedes_id ?? null,
        now,
        now,
        now,
        item.expires_at ?? null,
        item.embedding_model,
        item.embedding_version,
      );
    if (Number(insert.changes) === 0) {
      const byId = this.db
        .prepare("SELECT * FROM memory_items WHERE id = ? AND domain = ?")
        .get(id, this.domainValue) as Record<string, unknown> | undefined;
      if (byId) return this.toItem(byId);
      const byHash = this.db
        .prepare("SELECT * FROM memory_items WHERE domain = ? AND status = 'ACTIVE' AND content_hash = ? LIMIT 1")
        .get(this.domainValue, item.content_hash) as Record<string, unknown> | undefined;
      if (byHash) return this.toItem(byHash);
      throw new Error(`memory item insert was ignored without a matching row (id=${id})`);
    }
    return this.getNow(id);
  }

  private getNow(id: string): MemoryItem {
    const row = this.db.prepare("SELECT * FROM memory_items WHERE id = ? AND domain = ?").get(id, this.domainValue) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`memory item not found after write: ${id}`);
    return this.toItem(row);
  }

  async forget(id: string): Promise<void> {
    this.transaction(() => {
      const tombstone = `[deleted:${id}]`;
      const changed = this.db
        .prepare(
          `UPDATE memory_items SET status = 'DELETED', canonical_text = ?, display_text = ?,
             content_hash = ?, updated_at = ?
           WHERE id = ? AND domain = ? AND status != 'DELETED'`,
        )
        .run(tombstone, tombstone, contentHash(tombstone), nowIso(), id, this.domainValue);
      if (Number(changed.changes) !== 1) {
        throw new Error(`cannot forget ${id}: no memory with that id in the ${this.domainValue} store`);
      }
      this.db.prepare("DELETE FROM memory_chunks WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM memory_fts5 WHERE memory_id = ?").run(id);
    });
  }

  async touchVerified(id: string): Promise<void> {
    this.db
      .prepare("UPDATE memory_items SET last_verified_at = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'")
      .run(nowIso(), nowIso(), id);
  }

  expireDue(): number {
    const result = this.db
      .prepare(
        "UPDATE memory_items SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(nowIso(), nowIso());
    return Number(result.changes);
  }

  // ---- chunks / vector index ------------------------------------------------

  async putChunks(memoryId: string, chunks: MemoryChunkWrite[]): Promise<void> {
    this.transaction(() => {
      this.db.prepare("DELETE FROM memory_fts5 WHERE memory_id = ?").run(memoryId);
      for (const chunk of chunks) {
        const id = chunkId(memoryId, chunk.ordinal);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_chunks (id, memory_id, ordinal, text, token_count, content_hash, embedding_blob)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            memoryId,
            chunk.ordinal,
            this.sanitizer.sanitizeText(chunk.text),
            chunk.token_count,
            chunk.content_hash,
            embedBlob(chunk.embedding),
          );
        this.db
          .prepare("INSERT OR REPLACE INTO memory_fts5 (chunk_id, memory_id, text) VALUES (?, ?, ?)")
          .run(id, memoryId, this.sanitizer.sanitizeText(chunk.text));
      }
    });
  }

  async findActiveBySourceId(sourceId: string): Promise<MemoryItem | null> {
    const row = this.db
      .prepare("SELECT * FROM memory_items WHERE domain = ? AND source_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(this.domainValue, sourceId) as Record<string, unknown> | undefined;
    return row ? this.toItem(row) : null;
  }

  async writeDocumentAtomic(input: {
    source: MemorySourceRecord;
    item: MemoryWrite;
    chunks: MemoryChunkWrite[];
    completion?: { requestId: string; resultId: string };
  }): Promise<void> {
    const { source, item, chunks, completion } = input;
    this.transaction(() => {
      const now = nowIso();
      const memoryId = item.id ?? randomUUID();
      // Item first: putNow converges concurrent identical ingestions onto one
      // ACTIVE row via uq_items_active_hash. Chunks, FTS rows, and source
      // metadata must reference the surviving row or the FK constraint fails.
      const persisted = this.putNow({
        ...item,
        id: memoryId,
        canonical_text: this.sanitizer.sanitizeText(item.canonical_text),
        display_text: this.sanitizer.sanitizeText(item.display_text),
      });
      const chunkMemoryId = persisted.id;
      const convergedMetadata = (() => {
        try {
          const parsed = source.metadata_json ? (JSON.parse(source.metadata_json) as Record<string, unknown>) : {};
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsed.memory_ids = [chunkMemoryId];
            return JSON.stringify(parsed);
          }
          return source.metadata_json ?? null;
        } catch {
          return source.metadata_json ?? null;
        }
      })();
      const convergedSource = { ...source, metadata_json: convergedMetadata };
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_sources (id, source_type, source_external_id, title, source_hash, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          convergedSource.id,
          convergedSource.source_type,
          convergedSource.source_external_id ?? null,
          convergedSource.title ?? null,
          convergedSource.source_hash,
          convergedSource.metadata_json ?? null,
          convergedSource.created_at,
          now,
        );
      this.db
        .prepare("UPDATE memory_sources SET title = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
        .run(convergedSource.title ?? null, convergedSource.metadata_json ?? null, now, convergedSource.id);
      this.db.prepare("DELETE FROM memory_fts5 WHERE memory_id = ?").run(chunkMemoryId);
      for (const chunk of chunks) {
        const id = chunkId(chunkMemoryId, chunk.ordinal);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_chunks (id, memory_id, ordinal, text, token_count, content_hash, embedding_blob)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            chunkMemoryId,
            chunk.ordinal,
            this.sanitizer.sanitizeText(chunk.text),
            chunk.token_count,
            chunk.content_hash,
            embedBlob(chunk.embedding),
          );
        this.db
          .prepare("INSERT OR REPLACE INTO memory_fts5 (chunk_id, memory_id, text) VALUES (?, ?, ?)")
          .run(id, chunkMemoryId, this.sanitizer.sanitizeText(chunk.text));
      }
      if (completion) {
        this.db
          .prepare("UPDATE ingestion_requests SET state = 'completed', result_id = ?, updated_at = ? WHERE request_id = ? AND request_hash IS NOT NULL")
          .run(completion.resultId, now, completion.requestId);
      }
    });
  }

  async getChunks(memoryId: string): Promise<MemoryChunk[]> {
    const rows = this.db
      .prepare("SELECT * FROM memory_chunks WHERE memory_id = ? ORDER BY ordinal ASC")
      .all(memoryId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      memory_id: String(row.memory_id),
      ordinal: Number(row.ordinal),
      text: String(row.text),
      token_count: Number(row.token_count),
      content_hash: String(row.content_hash),
      embedding: blobToVector(row.embedding_blob),
    }));
  }

  async deleteChunks(memoryId: string): Promise<void> {
    this.transaction(() => {
      this.db.prepare("DELETE FROM memory_chunks WHERE memory_id = ?").run(memoryId);
      this.db.prepare("DELETE FROM memory_fts5 WHERE memory_id = ?").run(memoryId);
    });
  }

  // ---- vector search (spec section 13) --------------------------------------

  async vectorSearch(query: VectorQuery): Promise<VectorHit[]> {
    const now = nowIso();
    const clauses = ["c.memory_id IS NOT NULL", "i.domain = ?", "i.status = 'ACTIVE'", "(i.expires_at IS NULL OR i.expires_at > ?)"];
    const params: Array<string | number | null> = [this.domainValue, now];
    if (query.filters.project_key !== undefined) {
      clauses.push("i.project_key = ?");
      params.push(query.filters.project_key);
    }
    if (query.filters.subject_keys !== undefined && query.filters.subject_keys.length > 0) {
      clauses.push(`i.subject_key IN (${query.filters.subject_keys.map(() => "?").join(",")})`);
      params.push(...query.filters.subject_keys);
    }
    if (query.filters.allowed_types !== undefined && query.filters.allowed_types.length > 0) {
      clauses.push(`i.type IN (${query.filters.allowed_types.map(() => "?").join(",")})`);
      params.push(...query.filters.allowed_types);
    }
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.memory_id, c.text, c.embedding_blob
         FROM memory_chunks c JOIN memory_items i ON i.id = c.memory_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY c.rowid ASC LIMIT 5000`,
      )
      .all(...params) as unknown as Array<{ chunk_id: string; memory_id: string; text: string; embedding_blob: unknown }>;

    const minSimilarity = query.min_similarity ?? 0;
    const scored: VectorHit[] = [];
    for (const row of rows) {
      const vector = blobToVector(row.embedding_blob);
      if (!vector || vector.length === 0) continue;
      const score = cosineSimilarity(query.vector, vector);
      // Minimum similarity guard: weak matches are not candidates (they are
      // not "semantically relevant", spec section 15.2).
      if (score < minSimilarity) continue;
      scored.push({ chunk_id: row.chunk_id, memory_id: row.memory_id, text: row.text, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.memory_id < b.memory_id ? -1 : 1));
    return scored.slice(0, query.limit);
  }

  // ---- keyword / FTS search (spec section 14) --------------------------------

  async keywordSearch(query: KeywordQuery): Promise<KeywordHit[]> {
    const ftsQuery = buildFtsQuery(query.text);
    if (ftsQuery === "") return [];
    const now = nowIso();
    const clauses = ["memory_fts5 MATCH ?", "i.domain = ?", "i.status = 'ACTIVE'", "(i.expires_at IS NULL OR i.expires_at > ?)"];
    const params: Array<string | number | null> = [ftsQuery, this.domainValue, now];
    if (query.filters.project_key !== undefined) {
      clauses.push("i.project_key = ?");
      params.push(query.filters.project_key);
    }
    if (query.filters.subject_keys !== undefined && query.filters.subject_keys.length > 0) {
      clauses.push(`i.subject_key IN (${query.filters.subject_keys.map(() => "?").join(",")})`);
      params.push(...query.filters.subject_keys);
    }
    if (query.filters.allowed_types !== undefined && query.filters.allowed_types.length > 0) {
      clauses.push(`i.type IN (${query.filters.allowed_types.map(() => "?").join(",")})`);
      params.push(...query.filters.allowed_types);
    }
    const rows = this.db
      .prepare(
        `SELECT f.chunk_id, f.memory_id, c.text, bm25(memory_fts5) AS raw_rank
         FROM memory_fts5 f
         JOIN memory_chunks c ON c.id = f.chunk_id
         JOIN memory_items i ON i.id = c.memory_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY raw_rank ASC LIMIT ?`,
      )
      .all(...params, query.limit) as unknown as Array<{ chunk_id: string; memory_id: string; text: string; raw_rank: number }>;
    return rows.map((row) => ({
      chunk_id: row.chunk_id,
      memory_id: row.memory_id,
      text: row.text,
      score: -row.raw_rank,
    }));
  }

  // ---- sources / documents ----------------------------------------------------

  async putSource(source: MemorySourceRecord): Promise<void> {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_sources (id, source_type, source_external_id, title, source_hash, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        source.source_type,
        source.source_external_id ?? null,
        source.title ?? null,
        source.source_hash,
        source.metadata_json ?? null,
        source.created_at,
        now,
      );
    // Re-ingesting identical content updates metadata (title/project) without duplicating.
    this.db
      .prepare("UPDATE memory_sources SET title = ?, metadata_json = ?, updated_at = ? WHERE id = ?")
      .run(source.title ?? null, source.metadata_json ?? null, now, source.id);
  }

  async getSource(id: string): Promise<MemorySourceRecord | null> {
    const row = this.db.prepare("SELECT * FROM memory_sources WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      source_type: row.source_type as MemorySourceRecord["source_type"],
      source_external_id: row.source_external_id === null ? undefined : String(row.source_external_id),
      title: row.title === null ? undefined : String(row.title),
      source_hash: String(row.source_hash),
      metadata_json: row.metadata_json === null ? undefined : String(row.metadata_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  async listSources(): Promise<MemorySourceRecord[]> {
    const rows = this.db.prepare("SELECT * FROM memory_sources ORDER BY created_at ASC").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      source_type: row.source_type as MemorySourceRecord["source_type"],
      source_external_id: row.source_external_id === null ? undefined : String(row.source_external_id),
      title: row.title === null ? undefined : String(row.title),
      source_hash: String(row.source_hash),
      metadata_json: row.metadata_json === null ? undefined : String(row.metadata_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }));
  }

  async deleteSource(id: string): Promise<{ deletedMemories: number; deletedChunks: number }> {
    return this.transaction(() => {
      const items = this.db.prepare("SELECT id FROM memory_items WHERE source_id = ?").all(id) as unknown as Array<{ id: string }>;
      const tombstone = `[deleted:${id}]`;
      let deletedChunks = 0;
      for (const item of items) {
        this.db
          .prepare(
            `UPDATE memory_items SET status = 'DELETED', canonical_text = ?, display_text = ?,
               content_hash = ?, updated_at = ?
             WHERE id = ? AND status != 'DELETED'`,
          )
          .run(tombstone, tombstone, contentHash(`${tombstone}:${item.id}`), nowIso(), item.id);
        const chunkResult = this.db.prepare("DELETE FROM memory_chunks WHERE memory_id = ?").run(item.id);
        deletedChunks += Number(chunkResult.changes);
        this.db.prepare("DELETE FROM memory_fts5 WHERE memory_id = ?").run(item.id);
      }
      this.db.prepare("DELETE FROM memory_sources WHERE id = ?").run(id);
      return { deletedMemories: items.length, deletedChunks };
    });
  }

  // ---- ingestion idempotency (spec section 33) --------------------------------

  reserveIngestion(requestId: string, requestHash: string): IngestionReservation {
    const now = nowIso();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO ingestion_requests (request_id, request_hash, state, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .run(requestId, requestHash, now, now);
    const record = this.getIngestion(requestId);
    if (!record) return { kind: "proceed" };
    if (record.request_hash !== requestHash) return { kind: "conflict" };
    if (record.state === "completed" && record.result_id) {
      return { kind: "completed", resultId: record.result_id };
    }
    // pending/writing/failed with the same hash may be resumed (crash recovery).
    return { kind: "proceed" };
  }

  beginIngestion(requestId: string, requestHash: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE ingestion_requests SET state = 'writing', updated_at = ?
         WHERE request_id = ? AND request_hash = ? AND state IN ('pending','writing','failed')`,
      )
      .run(nowIso(), requestId, requestHash);
    return Number(result.changes) === 1;
  }

  completeIngestion(requestId: string, resultId: string): void {
    this.db
      .prepare(
        "UPDATE ingestion_requests SET state = 'completed', result_id = ?, updated_at = ? WHERE request_id = ? AND request_hash IS NOT NULL",
      )
      .run(resultId, nowIso(), requestId);
  }

  failIngestion(requestId: string): void {
    this.db
      .prepare("UPDATE ingestion_requests SET state = 'failed', updated_at = ? WHERE request_id = ?")
      .run(nowIso(), requestId);
  }

  getIngestion(requestId: string): IngestionRecord | null {
    const row = this.db.prepare("SELECT * FROM ingestion_requests WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      request_id: String(row.request_id),
      request_hash: String(row.request_hash),
      state: row.state as IngestionRecord["state"],
      result_id: row.result_id === null ? undefined : String(row.result_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  /** Crash reconciliation (spec section 36): interrupted writes whose result
   *  already exists converge to completed. The result is located by result_id
   *  when recorded, or by the request_id stamped on memory_items.source_id;
   *  when found that way the result_id is backfilled so replays resolve. */
  reconcileIngestions(): string[] {
    const now = nowIso();
    const rows = this.db
      .prepare("SELECT request_id FROM ingestion_requests WHERE state IN ('pending','writing')")
      .all() as unknown as Array<{ request_id: string }>;
    const recovered: string[] = [];
    for (const row of rows) {
      const record = this.getIngestion(row.request_id);
      if (!record) continue;
      const found = this.db
        .prepare("SELECT id FROM memory_items WHERE (id = ? OR source_id = ?) AND status = 'ACTIVE' LIMIT 1")
        .get(record.result_id ?? "", record.request_id) as { id: string } | undefined;
      if (found) {
        this.db
          .prepare("UPDATE ingestion_requests SET state = 'completed', result_id = ?, updated_at = ? WHERE request_id = ?")
          .run(found.id, now, record.request_id);
        recovered.push(record.request_id);
      }
    }
    return recovered;
  }

  health(): boolean {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // closing twice is a no-op
    }
  }
}

// ---- Explicit named store handles (spec sections 4, 7) -----------------------

export class PersonalMemoryStore extends SqliteMemoryStore {
  constructor(dbPath: string, sanitizer: SecretSanitizer = new SecretSanitizer([])) {
    super(dbPath, MemoryDomain.PERSONAL, sanitizer);
  }
}

export class BusinessMemoryStore extends SqliteMemoryStore {
  constructor(dbPath: string, sanitizer: SecretSanitizer = new SecretSanitizer([])) {
    super(dbPath, MemoryDomain.BUSINESS, sanitizer);
  }
}
