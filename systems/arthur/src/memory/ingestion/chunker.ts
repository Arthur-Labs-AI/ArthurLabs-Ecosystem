/**
 * Semantic-boundary chunker (spec section 25).
 *
 * Prefers paragraph/sentence boundaries over blind fixed-size splitting,
 * applies a configurable token budget per chunk, carries over one sentence
 * only when useful, and hashes every chunk for re-ingestion/dedupe.
 */

import { estimateTokens } from "../../observability/usage";
import { contentHash } from "../provenance";
import { normalizeText } from "./normalizer";

export interface Chunk {
  ordinal: number;
  text: string;
  token_count: number;
  content_hash: string;
}

export interface ChunkerOptions {
  /** Approximate token budget per chunk (chars/4). */
  maxTokensPerChunk: number;
  /** Carry the previous chunk's last sentence into the next chunk. */
  overlapSentences?: number;
}

export const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+/u;
export const PARAGRAPH_BOUNDARY = /\n{2,}/;

function splitParagraphs(text: string): string[] {
  return text.split(PARAGRAPH_BOUNDARY).map((p) => p.trim()).filter((p) => p.length > 0);
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph.split(SENTENCE_BOUNDARY).map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return [paragraph];
  return parts;
}

function hardSplit(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(1, maxTokens * 4);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

export function chunkText(rawText: string, opts: ChunkerOptions): Chunk[] {
  const text = normalizeText(rawText);
  const maxTokens = Math.max(1, opts.maxTokensPerChunk);
  const overlap = Math.max(0, opts.overlapSentences ?? 0);
  if (text === "") return [];

  const sentences: string[] = [];
  for (const paragraph of splitParagraphs(text)) {
    sentences.push(...splitSentences(paragraph));
  }

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let carry: string | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    const joined = current.join(" ");
    if (estimateTokens(joined) > maxTokens) {
      // A single sentence alone exceeds the budget: hard-split it.
      for (const piece of hardSplit(joined, maxTokens)) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        chunks.push({
          ordinal: chunks.length,
          text: trimmed,
          token_count: estimateTokens(trimmed),
          content_hash: contentHash(trimmed),
        });
      }
    } else {
      chunks.push({
        ordinal: chunks.length,
        text: joined,
        token_count: estimateTokens(joined),
        content_hash: contentHash(joined),
      });
    }
    if (overlap > 0 && current.length > 1) {
      carry = current[current.length - 1];
    } else {
      carry = undefined;
    }
    current = [];
  };

  for (const sentence of sentences) {
    if (carry !== undefined && current.length === 0) {
      current.push(carry);
      carry = undefined;
    }
    current.push(sentence);
    if (estimateTokens(current.join(" ")) > maxTokens) {
      // Drop the newest sentence into the next chunk (it fits better there).
      const popped = current.pop();
      flush();
      if (popped !== undefined) current.push(popped);
    }
  }
  flush();
  return chunks;
}
