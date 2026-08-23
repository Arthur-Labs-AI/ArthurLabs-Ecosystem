/**
 * Embedding gateway (spec section 12).
 *
 * Wraps one configured local provider, enforces input-size limits, batches
 * provider calls, and exposes a stable composite id that is persisted with
 * every memory item/chunk so incompatible vectors can never mix silently.
 */

import type { EmbeddingBatch, EmbeddingGateway, EmbeddingProvider } from "./contracts";

export interface EmbeddingGatewayOptions {
  provider: EmbeddingProvider;
  model: string;
  version: string;
  /** Hard cap on one embed() call (reject, not truncate). */
  maxTextsPerCall?: number;
  /** Hard cap per input text. */
  maxTextChars?: number;
  /** Provider call batch size. */
  batchSize?: number;
}

const DEFAULT_MAX_TEXTS = 64;
const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_BATCH = 16;

export class EmbeddingGatewayImpl implements EmbeddingGateway {
  private readonly provider: EmbeddingProvider;
  private readonly model: string;
  private readonly version: string;
  private readonly maxTexts: number;
  private readonly maxChars: number;
  private readonly batchSize: number;

  constructor(opts: EmbeddingGatewayOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.version = opts.version;
    this.maxTexts = opts.maxTextsPerCall ?? DEFAULT_MAX_TEXTS;
    this.maxChars = opts.maxTextChars ?? DEFAULT_MAX_CHARS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
  }

  id(): string {
    return `${this.provider.id()}:${this.model}:${this.version}`;
  }

  async embed(texts: string[]): Promise<EmbeddingBatch> {
    if (texts.length === 0) {
      return { provider: this.provider.id(), model: this.model, version: this.version, dimensions: this.provider.dimensions(), vectors: [] };
    }
    if (texts.length > this.maxTexts) {
      throw new Error(`embedding batch too large: ${texts.length} texts (max ${this.maxTexts})`);
    }
    for (const text of texts) {
      if (text.length > this.maxChars) {
        throw new Error(`embedding input exceeds ${this.maxChars} characters`);
      }
    }
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const result = await this.provider.embed(batch);
      if (result.length !== batch.length) {
        throw new Error("embedding provider returned an inconsistent batch");
      }
      for (const vector of result) {
        if (vector.length !== this.provider.dimensions()) {
          throw new Error("embedding provider returned a vector with the wrong dimensions");
        }
        vectors.push(vector);
      }
    }
    return {
      provider: this.provider.id(),
      model: this.model,
      version: this.version,
      dimensions: this.provider.dimensions(),
      vectors,
    };
  }
}
