/**
 * Local multilingual embedding provider (spec section 12).
 *
 * A deterministic, offline, language-agnostic character n-gram hashing
 * embedding (hashing trick with sign randomization, L2-normalized). It needs
 * no model weights and no network, and it works for Latin, Cyrillic, and other
 * scripts by operating on Unicode code points. Quality is deliberately modest
 * (Phase 2 dataset sizes); the interface allows replacing it later.
 */

import type { EmbeddingProvider } from "../contracts";
import { l2Normalize } from "../contracts";

export interface LocalMultilingualOptions {
  dimensions?: number;
  /** Feature set scale (n-gram sizes). */
  maxNgram?: number;
}

const DEFAULT_DIMENSIONS = 384;
const DEFAULT_MAX_NGRAM = 3;

/** FNV-1a 32-bit — deterministic across processes and platforms. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class LocalMultilingualEmbeddingProvider implements EmbeddingProvider {
  private readonly dims: number;
  private readonly maxNgram: number;

  constructor(opts: LocalMultilingualOptions = {}) {
    this.dims = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.maxNgram = opts.maxNgram ?? DEFAULT_MAX_NGRAM;
  }

  id(): string {
    return "local-multilingual";
  }

  dimensions(): number {
    return this.dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dims).fill(0);
    const normalized = text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (normalized.length === 0) return vector;

    const features = new Set<string>();
    // Whole-word features (unicode letter/digit runs).
    for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
      const token = match[0];
      if (token.length >= 2) features.add(`w:${token}`);
    }
    // Character n-grams over the full string.
    const chars = Array.from(normalized);
    for (let n = 2; n <= this.maxNgram; n++) {
      for (let i = 0; i + n <= chars.length; i++) {
        features.add(`c${n}:${chars.slice(i, i + n).join("")}`);
      }
    }

    for (const feature of features) {
      const bucket = fnv1a(feature) % this.dims;
      const sign = fnv1a(`${feature}#sign`) & 1 ? 1 : -1;
      vector[bucket] = (vector[bucket] ?? 0) + sign;
    }
    return l2Normalize(vector);
  }
}