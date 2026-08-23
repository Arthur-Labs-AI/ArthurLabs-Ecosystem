/**
 * Supersession (spec section 22).
 *
 * Old ACTIVE memory -> SUPERSEDED; new verified replacement -> ACTIVE with
 * supersedes_id pointing at the old one. Superseded rows remain auditable but
 * never appear in normal retrieval.
 */

import { chunkAndEmbed } from "../ingestion/embedder";
import type { EmbeddingGateway } from "../embeddings/contracts";
import { MemoryStore, MemoryWrite } from "../contracts";

export class SupersessionService {
  private readonly store: MemoryStore;
  private readonly embeddings: EmbeddingGateway;
  private readonly maxChunkTokens: number;

  constructor(store: MemoryStore, embeddings: EmbeddingGateway, maxChunkTokens: number) {
    this.store = store;
    this.embeddings = embeddings;
    this.maxChunkTokens = maxChunkTokens;
  }

  async supersede(oldId: string, write: MemoryWrite): Promise<{ item: Awaited<ReturnType<MemoryStore["supersede"]>> }> {
    const item = await this.store.supersede(oldId, write);
    const { chunks } = await chunkAndEmbed({ text: write.canonical_text, embeddings: this.embeddings, maxChunkTokens: this.maxChunkTokens });
    await this.store.putChunks(item.id, chunks);
    return { item };
  }
}
