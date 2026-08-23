/**
 * Provenance helpers (spec sections 10.2, 24).
 *
 * Every memory must be traceable to a source type and optional source id;
 * conversation-derived memories reference the originating turn/session and
 * document memories reference the document id plus chunk ordinal.
 */

import { createHash } from "node:crypto";

import type { MemorySourceRecord, MemorySourceType } from "./contracts";

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function requestHashOf(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Deterministic document id from content so re-ingestion converges. */
export function documentIdFromHash(contentHashHex: string): string {
  return `doc-${contentHashHex.slice(0, 32)}`;
}

/** Deterministic memory id for a document (stable across retries). */
export function documentMemoryIdFromHash(contentHashHex: string): string {
  return `mem-doc-${contentHashHex.slice(0, 32)}`;
}

export function makeSourceRecord(input: {
  id: string;
  sourceType: MemorySourceType;
  sourceExternalId?: string;
  title?: string;
  sourceHash: string;
  metadata?: Record<string, unknown>;
}): MemorySourceRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    source_type: input.sourceType,
    source_external_id: input.sourceExternalId,
    title: input.title,
    source_hash: input.sourceHash,
    metadata_json: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
    created_at: now,
    updated_at: now,
  };
}
