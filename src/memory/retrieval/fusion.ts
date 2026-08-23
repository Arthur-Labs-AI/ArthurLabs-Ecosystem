/**
 * Hybrid fusion (spec section 15.2).
 *
 * Deterministic Reciprocal Rank Fusion: vector and FTS ranks are merged by
 * rank position (1/(k+rank)) rather than by incomparable raw scores, then
 * chunks are collapsed per memory id. The result is stable and testable.
 */

import type { KeywordHit, VectorHit } from "../contracts";

export interface FusedChunk {
  memoryId: string;
  chunkId: string;
  text: string;
  score: number;
  channels: Array<"vector" | "keyword">;
}

const DEFAULT_K = 60;

export function reciprocalRankFusion(
  vectorHits: VectorHit[],
  keywordHits: KeywordHit[],
  k = DEFAULT_K,
): FusedChunk[] {
  const byChunk = new Map<string, FusedChunk>();

  const add = (chunkId: string, memoryId: string, text: string, rank: number, channel: "vector" | "keyword"): void => {
    const existing = byChunk.get(chunkId);
    if (existing) {
      existing.score += 1 / (k + rank);
      if (!existing.channels.includes(channel)) existing.channels.push(channel);
      return;
    }
    byChunk.set(chunkId, {
      memoryId,
      chunkId,
      text,
      score: 1 / (k + rank),
      channels: [channel],
    });
  };

  vectorHits.forEach((hit, index) => add(hit.chunk_id, hit.memory_id, hit.text, index + 1, "vector"));
  keywordHits.forEach((hit, index) => add(hit.chunk_id, hit.memory_id, hit.text, index + 1, "keyword"));

  // Collapse chunks per memory: keep the best-scoring chunk, remember all channels.
  const byMemory = new Map<string, FusedChunk>();
  for (const chunk of byChunk.values()) {
    const current = byMemory.get(chunk.memoryId);
    if (!current || chunk.score > current.score) {
      byMemory.set(chunk.memoryId, chunk);
    } else if (current) {
      for (const channel of chunk.channels) {
        if (!current.channels.includes(channel)) current.channels.push(channel);
      }
    }
  }

  return Array.from(byMemory.values()).sort(
    (a, b) => b.score - a.score || (a.memoryId < b.memoryId ? -1 : 1),
  );
}
