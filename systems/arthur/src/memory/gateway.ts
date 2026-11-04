/**
 * MemoryGateway (spec sections 26, 27, 36, 41).
 *
 * The single trusted boundary for every memory operation. It owns two
 * explicitly named store handles (Personal, Business) and chooses exactly one
 * through an exhaustive switch derived from the trusted server-side session —
 * never from client or LLM input. No generic getStore(domainString) exists
 * anywhere below this class.
 */

import { Logger } from "../observability/logging";
import { Metrics } from "../observability/metrics";
import { invalidRequest } from "../core/errors/errors";
import { SecretSanitizer } from "../security/sanitize";
import { normalizeText } from "./ingestion/normalizer";
import { chunkAndEmbed } from "./ingestion/embedder";
import { DedupeService } from "./dedupe";
import { hasSecretLikeContent, expiryForType } from "./policy";
import { DocumentIngestionService } from "./ingestion/service";
import { DocumentService } from "./ingestion/document_service";
import { HybridRetriever } from "./retrieval/hybrid_retriever";
import { contentHash, requestHashOf } from "./provenance";
import {
  DocumentRequest,
  DocumentResult,
  isMemoryType,
  MemoryContext,
  MemoryDomain,
  MemoryItem,
  MemoryItemSummary,
  MemoryListFilter,
  MemorySourceType,
  MemoryStatusReport,
  MemoryWrite,
  MemoryWriteReason,
  RememberRequest,
  RetrievedMemory,
  RetrievalRequest,
  TrustedSessionContext,
  memoryContextFromSession,
  MemoryStore,
  MemoryType,
} from "./contracts";
import type { EmbeddingGateway } from "./embeddings/contracts";
import type { MemoryCandidate } from "./extraction/schemas";
import type { PersonalMemoryStore, BusinessMemoryStore } from "./stores/sqlite_memory_store";

export interface MemoryGateway {
  retrieve(ctx: TrustedSessionContext, request: RetrievalRequest): Promise<RetrievedMemory[]>;
  remember(ctx: TrustedSessionContext, request: RememberRequest): Promise<MemoryItem>;
  ingestDocument(ctx: TrustedSessionContext, request: DocumentRequest, clientRequestId: string): Promise<DocumentResult>;
  forget(ctx: TrustedSessionContext, memoryId: string): Promise<void>;
  list(ctx: TrustedSessionContext, filter: MemoryListFilter): Promise<MemoryItemSummary[]>;
  getDocument(ctx: TrustedSessionContext, documentId: string): Promise<DocumentResult | null>;
  listDocuments(ctx: TrustedSessionContext): Promise<DocumentResult[]>;
  deleteDocument(ctx: TrustedSessionContext, documentId: string): Promise<{ deletedMemories: number; deletedChunks: number }>;
  /** Extraction-path write (conversation candidates), never exposed to clients. */
  storeCandidate(ctx: TrustedSessionContext, candidate: MemoryCandidate & { source_id: string }): Promise<void>;
  status(): MemoryStatusReport;
  close(): void;
}

export interface MemoryGatewayConfig {
  maxChunkTokens: number;
  maxRetrievalCandidates: number;
  maxRerankedResults: number;
  maxContextTokens: number;
  maxSingleChunkTokens: number;
  temporaryTtlSeconds: number;
  maxRememberChars: number;
  embeddingInfo: { provider: string; model: string; version: string; dimensions: number };
}

export interface MemoryGatewayDeps {
  personal: PersonalMemoryStore;
  business: BusinessMemoryStore;
  embeddings: EmbeddingGateway;
  dedupe: DedupeService;
  retriever: HybridRetriever;
  sanitizer: SecretSanitizer;
  config: MemoryGatewayConfig;
  logger?: Logger;
  metrics?: Metrics;
}

export class MemoryGatewayImpl implements MemoryGateway {
  private readonly personal: PersonalMemoryStore;
  private readonly business: BusinessMemoryStore;
  private readonly embeddings: EmbeddingGateway;
  private readonly dedupe: DedupeService;
  private readonly retriever: HybridRetriever;
  private readonly sanitizer: SecretSanitizer;
  private readonly config: MemoryGatewayConfig;
  private readonly logger?: Logger;
  private readonly metrics?: Metrics;
  private readonly ingestionPersonal: DocumentIngestionService;
  private readonly ingestionBusiness: DocumentIngestionService;
  private readonly documentsPersonal: DocumentService;
  private readonly documentsBusiness: DocumentService;

  constructor(deps: MemoryGatewayDeps) {
    this.personal = deps.personal;
    this.business = deps.business;
    this.embeddings = deps.embeddings;
    this.dedupe = deps.dedupe;
    this.retriever = deps.retriever;
    this.sanitizer = deps.sanitizer;
    this.config = deps.config;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.ingestionPersonal = new DocumentIngestionService({
      store: deps.personal,
      embeddings: deps.embeddings,
      sanitizer: deps.sanitizer,
      maxChunkTokens: deps.config.maxChunkTokens,
      logger: deps.logger,
      metrics: deps.metrics,
    });
    this.ingestionBusiness = new DocumentIngestionService({
      store: deps.business,
      embeddings: deps.embeddings,
      sanitizer: deps.sanitizer,
      maxChunkTokens: deps.config.maxChunkTokens,
      logger: deps.logger,
      metrics: deps.metrics,
    });
    this.documentsPersonal = new DocumentService(deps.personal);
    this.documentsBusiness = new DocumentService(deps.business);
  }

  /** The only store selection point: an exhaustive explicit branch. */
  private selectStore(domain: MemoryDomain): MemoryStore {
    if (domain === MemoryDomain.PERSONAL) return this.personal;
    if (domain === MemoryDomain.BUSINESS) return this.business;
    throw new Error(`unknown memory domain: ${String(domain)}`);
  }

  /**
   * Crash repair (spec sections 36, 41): if a write crashed between the item
   * row and its chunk/index rows, re-embed and re-index so the item is
   * retrievable. No-op when chunks already exist.
   */
  private async ensureChunks(store: MemoryStore, item: MemoryItem): Promise<void> {
    const existing = await store.getChunks(item.id);
    if (existing.length > 0) return;
    const { chunks } = await chunkAndEmbed({
      text: item.canonical_text,
      embeddings: this.embeddings,
      maxChunkTokens: this.config.maxChunkTokens,
    });
    await store.putChunks(item.id, chunks);
  }

  private ingestServiceFor(domain: MemoryDomain): DocumentIngestionService {
    if (domain === MemoryDomain.PERSONAL) return this.ingestionPersonal;
    return this.ingestionBusiness;
  }

  private documentsFor(domain: MemoryDomain): DocumentService {
    if (domain === MemoryDomain.PERSONAL) return this.documentsPersonal;
    return this.documentsBusiness;
  }

  async retrieve(ctx: TrustedSessionContext, request: RetrievalRequest): Promise<RetrievedMemory[]> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    const store = this.selectStore(context.domain);
    try {
      store.expireDue();
    } catch {
      // expiry is opportunistic; retrieval still proceeds
    }
    return this.retriever.retrieve(context, {
      context,
      query_text: request.query_text,
      project_key: request.project_key,
      subject_keys: request.subject_keys,
      allowed_types: request.allowed_types,
      top_k: request.top_k ?? this.config.maxRerankedResults,
      max_context_tokens: request.max_context_tokens ?? this.config.maxContextTokens,
    });
  }

  async remember(ctx: TrustedSessionContext, request: RememberRequest): Promise<MemoryItem> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    const store = this.selectStore(context.domain);
    const text = normalizeText(request.text);
    if (text === "") throw invalidRequest("memory text is empty");
    if (text.length > this.config.maxRememberChars) {
      throw invalidRequest(`memory text exceeds ${this.config.maxRememberChars} characters`, {
        max_chars: this.config.maxRememberChars,
      });
    }
    if (!isMemoryType(request.type)) throw invalidRequest("memory type is invalid");
    // Secret safety: fail closed before any persistence or embedding.
    if (hasSecretLikeContent(text)) {
      this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "explicit", dedupe_action: "rejected_secret" });
      throw invalidRequest("memory content appears to contain credentials or secret values and was not stored");
    }
    const sanitized = this.sanitizer.sanitizeText(text);
    const requestId = request.client_request_id ? `remember:${request.client_request_id}` : undefined;
    const requestHash = requestId
      ? requestHashOf({
          session_id: ctx.session.id,
          domain: context.domain,
          text: sanitized,
          type: request.type,
          subject_key: request.subject_key ?? null,
          project_key: request.project_key ?? null,
        })
      : undefined;
    const write: MemoryWrite = {
      content_hash: contentHash(sanitized),
      type: request.type,
      subject_key: request.subject_key,
      project_key: request.project_key,
      source_type: MemorySourceType.USER_EXPLICIT,
      // The idempotency key is stamped as provenance so crash reconciliation
      // can recover a completed write that never recorded completion.
      source_id: requestId,
      canonical_text: sanitized,
      display_text: sanitized,
      confidence: 1,
      importance: 0.7,
      sensitivity: "NORMAL",
      expires_at: expiryForType(request.type, this.config.temporaryTtlSeconds),
      embedding_model: "",
      embedding_version: "",
    };

    if (requestId && requestHash !== undefined) {
      const reservation = store.reserveIngestion(requestId, requestHash);
      if (reservation.kind === "conflict") {
        throw invalidRequest("client_request_id was already used for a different memory", {
          client_request_id: request.client_request_id,
        });
      }
      if (reservation.kind === "completed") {
        if (reservation.resultId) {
          const existing = await store.get(reservation.resultId);
          if (existing && existing.status === "ACTIVE") {
            // The first attempt may have crashed between the item row and its
            // chunks; repair the index before replaying (no duplicates).
            await this.ensureChunks(store, existing);
            this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "explicit", dedupe_action: "replayed" });
            return existing;
          }
        }
        // The completed write's item is gone, missing, or no longer ACTIVE
        // (forget is final). Reopen the reservation so this remember creates
        // a fresh ACTIVE memory with the new content — never replays a
        // tombstone (audit F2).
        store.failIngestion(requestId);
      }
      if (!store.beginIngestion(requestId, requestHash)) {
        throw new Error("memory reservation could not be claimed");
      }
    }

    try {
      const outcome = await this.dedupe.resolve(store, write);
      if (outcome.action !== "updated") {
        const { chunks, batch } = await chunkAndEmbed({
          text: sanitized,
          embeddings: this.embeddings,
          maxChunkTokens: this.config.maxChunkTokens,
        });
        await store.putChunks(outcome.item.id, chunks);
        void batch;
      } else {
        // Same-process crash convergence (audit F3): an "updated" replay may
        // hit an ACTIVE item whose chunk/index rows were never written (the
        // first attempt crashed between the item row and putChunks). Rebuild
        // the missing index state so the item is searchable; no-op when the
        // chunks already exist.
        await this.ensureChunks(store, outcome.item);
      }
      if (requestId) store.completeIngestion(requestId, outcome.item.id);
      this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "explicit", dedupe_action: outcome.action });
      return outcome.item;
    } catch (error) {
      if (requestId) store.failIngestion(requestId);
      throw error;
    }
  }

  async storeCandidate(ctx: TrustedSessionContext, candidate: MemoryCandidate & { source_id: string }): Promise<void> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    const store = this.selectStore(context.domain);
    const text = normalizeText(candidate.text);
    if (text === "" || !isMemoryType(candidate.type)) return;
    if (hasSecretLikeContent(text)) {
      this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "extracted", dedupe_action: "rejected_secret" });
      return;
    }
    const sanitized = this.sanitizer.sanitizeText(text);
    const write: MemoryWrite = {
      content_hash: contentHash(sanitized),
      type: candidate.type,
      subject_key: candidate.subject_key,
      project_key: candidate.project_key,
      source_type: MemorySourceType.CONVERSATION,
      source_id: candidate.source_id,
      canonical_text: sanitized,
      display_text: sanitized,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sensitivity: "NORMAL",
      expires_at: expiryForType(candidate.type, this.config.temporaryTtlSeconds),
      embedding_model: "",
      embedding_version: "",
    };
    const outcome = await this.dedupe.resolve(store, write);
    await this.ensureChunks(store, outcome.item);
    this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "extracted", dedupe_action: outcome.action });
    this.logger?.info("memory candidate stored", {
      domain: context.domain,
      memory_id: outcome.item.id,
      action: outcome.action,
      type: outcome.item.type,
    });
  }

  async ingestDocument(ctx: TrustedSessionContext, request: DocumentRequest, clientRequestId: string): Promise<DocumentResult> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    const service = this.ingestServiceFor(context.domain);
    return service.ingest({ context, clientRequestId, request });
  }

  async forget(ctx: TrustedSessionContext, memoryId: string): Promise<void> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    const store = this.selectStore(context.domain);
    try {
      await store.forget(memoryId);
    } catch {
      // Cross-domain or unknown id: never leak which store the id belongs to.
      throw invalidRequest("memory not found in this session's domain", { memory_id: memoryId });
    }
    this.metrics?.counter("arthur.memory.write_reason", 1, { reason: "system", dedupe_action: "deleted" });
  }

  async list(ctx: TrustedSessionContext, filter: MemoryListFilter): Promise<MemoryItemSummary[]> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    const store = this.selectStore(context.domain);
    return store.list({ ...filter, domain: context.domain });
  }

  async getDocument(ctx: TrustedSessionContext, documentId: string): Promise<DocumentResult | null> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    return this.documentsFor(context.domain).get(documentId);
  }

  async listDocuments(ctx: TrustedSessionContext): Promise<DocumentResult[]> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    return this.documentsFor(context.domain).list();
  }

  async deleteDocument(ctx: TrustedSessionContext, documentId: string): Promise<{ deletedMemories: number; deletedChunks: number }> {
    const context = memoryContextFromSession(ctx.session, ctx.trace_id);
    return this.documentsFor(context.domain).delete(documentId);
  }

  status(): MemoryStatusReport {
    return {
      personal: { state: this.personal.health() ? "healthy" : "unavailable" },
      business: { state: this.business.health() ? "healthy" : "unavailable" },
      embedding: { ...this.config.embeddingInfo },
    };
  }

  close(): void {
    this.personal.close();
    this.business.close();
  }
}