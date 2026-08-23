/**
 * Embedding contracts (spec section 12).
 *
 * Conversation/memory code depends on EmbeddingGateway, never on one embedding
 * model. Providers are local and deterministic in Phase 2.
 */

export interface EmbeddingProvider {
  id(): string;
  dimensions(): number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingBatch {
  provider: string;
  model: string;
  version: string;
  dimensions: number;
  vectors: number[][];
}

export interface EmbeddingGateway {
  /** Composite identity: provider:model:version — recorded on every item/chunk. */
  id(): string;
  embed(texts: string[]): Promise<EmbeddingBatch>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) * (a[i] ?? 0);
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}
