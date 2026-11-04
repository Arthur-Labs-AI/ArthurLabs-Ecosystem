/**
 * Document service (spec section 30).
 *
 * Read/delete operations over ingested sources. Every access is scoped to the
 * store handle (domain) chosen by MemoryGateway.
 */

import type { DocumentResult, MemorySourceRecord } from "../contracts";
import { safeDocumentMetadata } from "./service";

export class DocumentService {
  private readonly store: { getSource(id: string): Promise<MemorySourceRecord | null>; listSources(): Promise<MemorySourceRecord[]>; deleteSource(id: string): Promise<{ deletedMemories: number; deletedChunks: number }> };

  constructor(store: DocumentService["store"]) {
    this.store = store;
  }

  async get(documentId: string): Promise<DocumentResult | null> {
    const source = await this.store.getSource(documentId);
    if (!source) return null;
    return toDocumentResult(source);
  }

  async list(): Promise<DocumentResult[]> {
    const sources = await this.store.listSources();
    return sources.map((source) => toDocumentResult(source));
  }

  async delete(documentId: string): Promise<{ deletedMemories: number; deletedChunks: number }> {
    return this.store.deleteSource(documentId);
  }
}

function toDocumentResult(source: MemorySourceRecord): DocumentResult {
  const metadata = safeDocumentMetadata(source.metadata_json);
  return {
    document_id: source.id,
    title: source.title ?? "untitled",
    source_type: String(metadata.source_type ?? "text"),
    project_key: metadata.project_key === null || metadata.project_key === undefined ? undefined : String(metadata.project_key),
    memory_ids: Array.isArray(metadata.memory_ids) ? metadata.memory_ids.map(String) : [],
    chunk_count: Number(metadata.chunk_count ?? 0),
    created_at: source.created_at,
    updated_at: source.updated_at,
    status: "completed",
  };
}
