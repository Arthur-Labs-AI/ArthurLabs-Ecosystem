/**
 * Document ingestion service (spec sections 24, 25, 33; SC-01D atomic commit).
 *
 * Pipeline: sanitize -> normalize -> hash -> idempotency reserve -> chunk
 * -> embed locally -> ONE transaction (source + item + chunks + FTS +
 * ingestion completion). Replaying the same request (same id + same hash)
 * while the ACTIVE incarnation lives returns the same document; after the
 * incarnation is deleted the reservation re-opens and re-ingestion creates a
 * fresh ACTIVE memory id (old tombstone kept for audit). Reusing the id
 * with different content is rejected; concurrent identical ingestions
 * converge on one ACTIVE logical memory via the active-hash UNIQUE index.
 */

import { randomUUID } from "node:crypto";

import { Logger } from "../../observability/logging";
import { Metrics } from "../../observability/metrics";
import { SecretSanitizer } from "../../security/sanitize";
import { invalidRequest } from "../../core/errors/errors";
import {
  DocumentRequest,
  DocumentResult,
  MemoryContext,
  MemorySourceType,
  MemoryStore,
  MemoryType,
  MemoryWrite,
} from "../contracts";
import type { EmbeddingGateway } from "../embeddings/contracts";
import { chunkText } from "./chunker";
import { normalizeText } from "./normalizer";
import { contentHash, documentIdFromHash, makeSourceRecord, requestHashOf } from "../provenance";

export interface DocumentIngestionOptions {
  store: MemoryStore;
  embeddings: EmbeddingGateway;
  sanitizer: SecretSanitizer;
  maxChunkTokens: number;
  logger?: Logger;
  metrics?: Metrics;
}

export class DocumentIngestionService {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingGateway;
  private readonly sanitizer: SecretSanitizer;
  private readonly maxChunkTokens: number;
  private readonly logger?: Logger;
  private readonly metrics?: Metrics;

  constructor(opts: DocumentIngestionOptions) {
    this.store = opts.store;
    this.embeddings = opts.embeddings;
    this.sanitizer = opts.sanitizer;
    this.maxChunkTokens = opts.maxChunkTokens;
    this.logger = opts.logger;
    this.metrics = opts.metrics;
  }

  async ingest(input: {
    context: MemoryContext;
    clientRequestId: string;
    request: DocumentRequest;
  }): Promise<DocumentResult> {
    const { context, clientRequestId, request } = input;
    const requestId = `doc:${clientRequestId}`;
    const normalized = normalizeText(request.content);
    if (normalized === "") {
      throw invalidRequest("document content is empty");
    }
    const sourceHash = contentHash(normalized);
    const requestHash = requestHashOf({
      session_id: context.session_id,
      domain: context.domain,
      title: normalizeText(request.title),
      source_type: request.source_type,
      content_hash: sourceHash,
      project_key: request.project_key ?? null,
    });

    const reservation = this.store.reserveIngestion(requestId, requestHash);
    if (reservation.kind === "conflict") {
      throw invalidRequest("client_request_id was already used for a different document", {
        client_request_id: clientRequestId,
      });
    }
    if (reservation.kind === "completed") {
      // SC-01 re-ingestion: a completed record whose ACTIVE incarnation is
      // gone (deleted/expired/superseded) re-opens so explicit re-ingestion
      // creates a fresh ACTIVE memory. The old tombstone stays for audit.
      const live = await this.store.findActiveBySourceId(reservation.resultId);
      if (live) {
        this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "document", dedupe_action: "replayed" });
        return this.loadResult(reservation.resultId);
      }
      this.store.failIngestion(requestId);
    }
    if (!this.store.beginIngestion(requestId, requestHash)) {
      throw new Error("document ingestion reservation could not be claimed");
    }

    try {
      // Secret-safety: sanitize before persistence and before embedding.
      const safeContent = this.sanitizer.sanitizeText(normalized);
      const safeTitle = this.sanitizer.sanitizeText(normalizeText(request.title)) || "untitled";
      const docId = documentIdFromHash(sourceHash);
      // SC-01D: the memory row is a fresh incarnation per ingestion, never a
      // deterministic id that a tombstone may already own. Concurrent
      // identical ingestions still converge via the UNIQUE active-hash index.
      const memId = `mem-doc-${randomUUID()}`;

      const chunks = chunkText(safeContent, { maxTokensPerChunk: this.maxChunkTokens });
      const embedStarted = Date.now();
      const batch = await this.embeddings.embed(chunks.map((chunk) => chunk.text));
      this.metrics?.timer("arthur.embedding.latency_ms", Date.now() - embedStarted);

      const metadata = {
        source_type: request.source_type,
        chunk_count: chunks.length,
        memory_ids: [memId],
        title: safeTitle,
        project_key: request.project_key ?? null,
        content_hash: sourceHash,
      };
      const source = makeSourceRecord({
        id: docId,
        sourceType: MemorySourceType.DOCUMENT,
        title: safeTitle,
        sourceHash,
        metadata,
      });
      const item: MemoryWrite = {
        id: memId,
        content_hash: sourceHash,
        type: MemoryType.DOCUMENT,
        source_type: MemorySourceType.DOCUMENT,
        source_id: docId,
        canonical_text: safeContent,
        display_text: safeTitle,
        confidence: 1,
        importance: 0.6,
        project_key: request.project_key,
        embedding_model: batch.model,
        embedding_version: batch.version,
      };
      const chunkWrites = chunks.map((chunk, index) => ({
        ordinal: chunk.ordinal,
        text: chunk.text,
        token_count: chunk.token_count,
        content_hash: chunk.content_hash,
        embedding: batch.vectors[index],
      }));
      // SC-01 atomic commit: document rows + ingestion completion commit
      // together, so there is no durable (document exists, writing) state.
      await this.store.writeDocumentAtomic({ source, item, chunks: chunkWrites, completion: { requestId, resultId: docId } });
      this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "document", dedupe_action: "created" });
      this.logger?.info("document ingested", {
        domain: context.domain,
        document_id: docId,
        chunks: chunks.length,
      });
      return this.loadResult(docId);
    } catch (error) {
      this.store.failIngestion(requestId);
      this.logger?.error("document ingestion failed", {
        domain: context.domain,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async loadResult(documentId: string): Promise<DocumentResult> {
    const source = await this.store.getSource(documentId);
    if (!source) throw new Error(`document not found: ${documentId}`);
    const metadata = safeJson(source.metadata_json);
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
}

export function safeDocumentMetadata(raw: string | undefined): Record<string, unknown> {
  return safeJson(raw);
}

function safeJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}