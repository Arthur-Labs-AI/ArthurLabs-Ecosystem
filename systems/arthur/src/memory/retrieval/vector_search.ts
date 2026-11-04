/**
 * Vector search (spec section 13).
 *
 * Persistent vector storage lives inside each memory SQLite database; this
 * module is the embedding-aware adapter over a store's vector search. The
 * VectorStore-style interface keeps a future pgvector/vector-engine swap
 * behind the same shape.
 */

import type { EmbeddingGateway } from "../embeddings/contracts";
import type { MemoryStore, RetrievalFilter, VectorHit } from "../contracts";

export class VectorSearch {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingGateway;

  constructor(store: MemoryStore, embeddings: EmbeddingGateway) {
    this.store = store;
    this.embeddings = embeddings;
  }

  async search(queryText: string, filters: RetrievalFilter, limit: number, minSimilarity?: number): Promise<VectorHit[]> {
    const batch = await this.embeddings.embed([queryText]);
    const vector = batch.vectors[0] ?? [];
    return this.store.vectorSearch({ vector, filters, limit, min_similarity: minSimilarity });
  }
}
