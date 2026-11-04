/**
 * SC-01E - deterministic freeze verifier for one file-backed memory database.
 *
 * Runs after a representative workload and a clean close:
 * PRAGMA integrity_check, PRAGMA foreign_key_check, FTS consistency
 * (chunk<->FTS row parity, no duplicate FTS chunk entries) and domain
 * consistency (no wrong-domain rows). Acceptance:
 * integrity_check is exactly "ok", foreign_key_check finds 0 violations,
 * every FTS/chunk/domain counter is 0.
 *
 * This is an acceptance/diagnostic operation; it never runs per user turn.
 */

import { DatabaseSync } from "node:sqlite";

import { collectMemorySchemaIssues } from "./sqlite_memory_store";
import type { MemoryDomain } from "../contracts";

export interface MemoryIntegrityExpectation {
  domain: MemoryDomain;
}

export interface MemoryIntegrityResult {
  dbPath: string;
  ok: boolean;
  integrityCheck: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  ftsWithoutChunk: number;
  chunksWithoutFts: number;
  duplicateFtsChunkEntries: number;
  wrongDomainRows: number;
  schemaIssues: string[];
  failures: string[];
}

export function verifyMemoryDatabase(dbPath: string, expectation: MemoryIntegrityExpectation): MemoryIntegrityResult {
  const failures: string[] = [];
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const integrityRows = db.prepare("PRAGMA integrity_check;").all() as Array<Record<string, unknown>>;
    const integrityCheck = integrityRows.map((row) => String(Object.values(row)[0] ?? ""));
    if (integrityCheck.length !== 1 || integrityCheck[0] !== "ok") {
      failures.push("integrity_check did not return exactly ok");
    }
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check;").all() as Array<Record<string, unknown>>;
    if (foreignKeyViolations.length !== 0) {
      failures.push("foreign_key_check found " + String(foreignKeyViolations.length) + " violation(s)");
    }
    const count = (sql: string): number => {
      const row = db.prepare(sql).get() as { n: number } | undefined;
      return Number(row?.n ?? 0);
    };
    const ftsWithoutChunk = count("SELECT COUNT(*) AS n FROM memory_fts5 f LEFT JOIN memory_chunks c ON c.id = f.chunk_id WHERE c.id IS NULL");
    if (ftsWithoutChunk !== 0) failures.push("FTS rows without a chunk: " + String(ftsWithoutChunk));
    const chunksWithoutFts = count("SELECT COUNT(*) AS n FROM memory_chunks c LEFT JOIN memory_fts5 f ON f.chunk_id = c.id WHERE f.chunk_id IS NULL");
    if (chunksWithoutFts !== 0) failures.push("chunks without an FTS row: " + String(chunksWithoutFts));
    const duplicateFtsChunkEntries = count("SELECT COUNT(*) AS n FROM (SELECT chunk_id FROM memory_fts5 GROUP BY chunk_id HAVING COUNT(*) > 1)");
    if (duplicateFtsChunkEntries !== 0) failures.push("duplicate FTS chunk entries: " + String(duplicateFtsChunkEntries));
    const wrongDomainRows = count("SELECT COUNT(*) AS n FROM memory_items WHERE domain != '" + expectation.domain + "'");
    if (wrongDomainRows !== 0) failures.push("wrong-domain rows: " + String(wrongDomainRows));
    const schemaIssues = collectMemorySchemaIssues(db, expectation.domain).map((issue) => issue.table + ": " + issue.detail);
    for (const issue of schemaIssues) failures.push("schema: " + issue);
    return {
      dbPath,
      ok: failures.length === 0,
      integrityCheck,
      foreignKeyViolations,
      ftsWithoutChunk,
      chunksWithoutFts,
      duplicateFtsChunkEntries,
      wrongDomainRows,
      schemaIssues,
      failures,
    };
  } finally {
    db.close();
  }
}
