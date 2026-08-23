/**
 * Shared chunking + embedding helper for memory writes.
 *
 * One canonical text becomes one or more chunks (semantic-boundary chunker),
 * each with a local embedding vector, content hash and token count.
 */

import { chunkText } from "./chunker";
import { contentHash } from "../provenance";
import { estimateTokens } from "../../observability/usage";
import type { EmbeddingBatch, EmbeddingGateway } from "../embeddings/contracts";
import type { MemoryChunkWrite } from "../contracts";

export interface ChunkAndEmbedResult {
  chunks: MemoryChunkWrite[];
  batch: EmbeddingBatch;
}

export async function chunkAndEmbed(input: {
  text: string;
  embeddings: EmbeddingGateway;
  maxChunkTokens: number;
}): Promise<ChunkAndEmbedResult> {
  const chunks = chunkText(input.text, { maxTokensPerChunk: input.maxChunkTokens });
  const batch = await input.embeddings.embed(chunks.map((chunk) => chunk.text));
  return {
    chunks: chunks.map((chunk, index) => ({
      ordinal: chunk.ordinal,
      text: chunk.text,
      token_count: chunk.token_count,
      content_hash: chunk.content_hash,
      embedding: batch.vectors[index],
    })),
    batch,
  };
}

export function chunkFromText(text: string): { ordinal: number; text: string; token_count: number; content_hash: string }[] {
  const chunks = chunkText(text, { maxTokensPerChunk: 1000000 });
  return chunks.map((chunk) => ({
    ordinal: chunk.ordinal,
    text: chunk.text,
    token_count: chunk.token_count,
    content_hash: chunk.content_hash ?? contentHash(chunk.text),
  }));
}

export function estimateChunkTokens(text: string): number {
  return estimateTokens(text);
}
