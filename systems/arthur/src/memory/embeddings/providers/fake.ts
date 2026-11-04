/**
 * Deterministic fake embedding provider (spec section 12).
 *
 * Used by the offline test suite for speed and for tests that need full
 * control over vector behavior. Deterministic: same text -> same vector.
 */

import type { EmbeddingProvider } from "../contracts";
import { l2Normalize } from "../contracts";

export interface FakeEmbeddingOptions {
  dimensions?: number;
}

const DEFAULT_DIMENSIONS = 64;

export class FakeEmbeddingProvider implements EmbeddingProvider {
  private readonly dims: number;

  constructor(opts: FakeEmbeddingOptions = {}) {
    this.dims = opts.dimensions ?? DEFAULT_DIMENSIONS;
  }

  id(): string {
    return "fake";
  }

  dimensions(): number {
    return this.dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dims).fill(0);
    const normalized = text.normalize("NFKC").toLowerCase();
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      const bucket = (code + i * 13) % this.dims;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
      // second pass so repeated characters still separate words
      const bucket2 = (code * 7 + i * 3) % this.dims;
      vector[bucket2] = (vector[bucket2] ?? 0) + 1;
    }
    return l2Normalize(vector);
  }
}