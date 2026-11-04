/**
 * Hybrid retrieval pipeline (spec sections 14, 15, 16, 36).
 *
 * query -> local embedding + vector search (active domain only)
 *       -> FTS keyword search (active domain only)
 *       -> Reciprocal Rank Fusion -> lifecycle filters -> dedupe
 *       -> local reranker -> token-budgeted snippets
 *
 * Failure handling is domain-strict: a failing store never triggers the other
 * domain; a failing embedding channel degrades to FTS-only (same domain), and
 * a failing FTS channel degrades to vector-only when available. If everything
 * fails, retrieval returns no memory and marks the index degraded — the
 * conversation continues in explicit no-memory mode.
 */

import { Logger } from "../../observability/logging";
import { Metrics } from "../../observability/metrics";
import { estimateTokens } from "../../observability/usage";
import type { EmbeddingGateway } from "../embeddings/contracts";
import {
  KeywordHit,
  MemoryContext,
  MemoryDomain,
  MemoryItemSummary,
  MemoryQuery,
  MemoryStore,
  RetrievedMemory,
  VectorHit,
} from "../contracts";
import { reciprocalRankFusion, FusedChunk } from "./fusion";
import { rerankMemories, RerankedMemory } from "./reranker";
import { VectorSearch } from "./vector_search";

export interface HybridRetrieverOptions {
  personal: MemoryStore;
  business: MemoryStore;
  embeddings: EmbeddingGateway;
  maxCandidates: number;
  maxRerankedResults: number;
  maxContextTokens: number;
  maxSingleChunkTokens: number;
  /** Minimum cosine similarity for vector candidates (spec section 15.2). */
  minSimilarity?: number;
  logger?: Logger;
  metrics?: Metrics;
}

export class HybridRetriever {
  private readonly personal: MemoryStore;
  private readonly business: MemoryStore;
  private readonly embeddings: EmbeddingGateway;
  private readonly vectorSearchPersonal: VectorSearch;
  private readonly vectorSearchBusiness: VectorSearch;
  private readonly maxCandidates: number;
  private readonly maxRerankedResults: number;
  private readonly maxContextTokens: number;
  private readonly maxSingleChunkTokens: number;
  private readonly minSimilarity?: number;
  private readonly logger?: Logger;
  private readonly metrics?: Metrics;
  private degraded = false;

  constructor(opts: HybridRetrieverOptions) {
    this.personal = opts.personal;
    this.business = opts.business;
    this.embeddings = opts.embeddings;
    this.vectorSearchPersonal = new VectorSearch(opts.personal, opts.embeddings);
    this.vectorSearchBusiness = new VectorSearch(opts.business, opts.embeddings);
    this.maxCandidates = opts.maxCandidates;
    this.maxRerankedResults = opts.maxRerankedResults;
    this.maxContextTokens = opts.maxContextTokens;
    this.maxSingleChunkTokens = opts.maxSingleChunkTokens;
    this.minSimilarity = opts.minSimilarity;
    this.logger = opts.logger;
    this.metrics = opts.metrics;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  /** Explicit domain branch — one trusted switch point for retrieval. */
  private storeFor(domain: MemoryDomain): MemoryStore {
    if (domain === MemoryDomain.PERSONAL) return this.personal;
    if (domain === MemoryDomain.BUSINESS) return this.business;
    throw new Error(`unknown memory domain: ${String(domain)}`);
  }

  private markDegraded(component: string, error: unknown): void {
    this.degraded = true;
    this.metrics?.counter("arthur.memory.index_state", 1, { state: "degraded" });
    this.logger?.warn("memory retrieval degraded", {
      component,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async retrieve(context: MemoryContext, request: MemoryQuery): Promise<RetrievedMemory[]> {
    const startedAt = Date.now();
    const queryText = (request.query_text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (queryText === "") return [];

    const store = this.storeFor(context.domain);
    const filters = {
      domain: context.domain,
      project_key: request.project_key,
      subject_keys: request.subject_keys,
      allowed_types: request.allowed_types,
    };

    // Channel 1: vector search (same domain only).
    let vectorHits: VectorHit[] = [];
    try {
      const embedStarted = Date.now();
      const batch = await this.embeddings.embed([queryText]);
      this.metrics?.timer("arthur.embedding.latency_ms", Date.now() - embedStarted);
      vectorHits = await store.vectorSearch({
        vector: batch.vectors[0] ?? [],
        filters,
        limit: this.maxCandidates,
        min_similarity: this.minSimilarity,
      });
    } catch (error) {
      this.markDegraded("vector", error);
      vectorHits = [];
    }

    // Channel 2: FTS keyword search (same domain only).
    let keywordHits: KeywordHit[] = [];
    try {
      keywordHits = await store.keywordSearch({ text: queryText, filters, limit: this.maxCandidates });
    } catch (error) {
      this.markDegraded("keyword", error);
      keywordHits = [];
    }

    if (vectorHits.length === 0 && keywordHits.length === 0) {
      this.metrics?.counter("arthur.retrieval.candidate_count", 0, { domain: context.domain });
      this.metrics?.timer("arthur.retrieval.latency_ms", Date.now() - startedAt, { domain: context.domain });
      return [];
    }

    // Fusion + collapse.
    const fused = reciprocalRankFusion(vectorHits, keywordHits);
    this.metrics?.counter("arthur.retrieval.candidate_count", fused.length, { domain: context.domain });

    // Dedupe semantically identical texts (normalized) across memories.
    const deduped = this.dedupeFused(fused);

    // Load summaries (domain-scoped) and rerank.
    const summaries = new Map<string, MemoryItemSummary>();
    for (const candidate of deduped) {
      const item = await store.get(candidate.memoryId);
      if (item && item.status === "ACTIVE") {
        summaries.set(item.id, {
          id: item.id,
          type: item.type,
          text: item.display_text,
          status: item.status,
          confidence: item.confidence,
          importance: item.importance,
          source_type: item.source_type,
          source_id: item.source_id,
          subject_key: item.subject_key,
          project_key: item.project_key,
          created_at: item.created_at,
          updated_at: item.updated_at,
        });
      }
    }
    const reranked = rerankMemories(deduped, summaries, { projectKey: request.project_key });

    // Token budget (spec section 16): prefer few high-quality memories.
    const selected: RerankedMemory[] = [];
    let usedTokens = 0;
    for (const memory of reranked) {
      if (selected.length >= this.maxRerankedResults) break;
      const snippet = truncateTextByTokens(memory.text, this.maxSingleChunkTokens);
      const tokens = estimateTokens(snippet);
      if (usedTokens + tokens > this.maxContextTokens && selected.length > 0) break;
      if (tokens > this.maxContextTokens) continue; // single snippet bigger than the whole budget
      selected.push({ ...memory, text: snippet });
      usedTokens += tokens;
    }

    const result = selected.map((memory) => ({
      memory_id: memory.memoryId,
      type: memory.summary.type,
      text: memory.text,
      score: round4(memory.finalScore),
      confidence: memory.summary.confidence,
      source_type: memory.summary.source_type,
      source_id: memory.summary.source_id,
      project_key: memory.summary.project_key,
      created_at: memory.summary.created_at,
    }));

    this.metrics?.counter("arthur.retrieval.returned_count", result.length, { domain: context.domain });
    this.metrics?.timer("arthur.retrieval.latency_ms", Date.now() - startedAt, { domain: context.domain });
    return result;
  }

  /** Collapse memories whose normalized text is identical (keeps best score). */
  private dedupeFused(candidates: FusedChunk[]): FusedChunk[] {
    const seen = new Map<string, FusedChunk>();
    for (const candidate of candidates) {
      const key = normalizeForCompare(candidate.text);
      const current = seen.get(key);
      if (!current || candidate.score > current.score) {
        seen.set(key, candidate);
      }
    }
    return Array.from(seen.values()).sort(
      (a, b) => b.score - a.score || (a.memoryId < b.memoryId ? -1 : 1),
    );
  }
}

/** Deterministic text equality key (also used for similarity-based collapse). */
export function normalizeForCompare(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function truncateTextByTokens(text: string, maxTokens: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  const maxChars = Math.max(1, maxTokens * 4 - 1);
  return `${text.slice(0, maxChars)}…`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
