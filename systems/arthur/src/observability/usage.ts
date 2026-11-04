/**
 * Token/usage accounting (spec sections 6.5, 7, 17).
 *
 * `TokenUsage` is a normalized domain object; provider adapters translate their
 * vendor-specific usage payloads into this shape and never leak SDK objects.
 */

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  total_tokens?: number;
}

export function emptyUsage(): TokenUsage {
  return {};
}

export function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const pick = (x?: number, y?: number): number | undefined => {
    if (x === undefined && y === undefined) return undefined;
    return (x ?? 0) + (y ?? 0);
  };
  return {
    input_tokens: pick(a.input_tokens, b.input_tokens),
    output_tokens: pick(a.output_tokens, b.output_tokens),
    cached_tokens: pick(a.cached_tokens, b.cached_tokens),
    total_tokens: pick(a.total_tokens, b.total_tokens),
  };
}

/**
 * Approximate token count for budget enforcement. Not a tokenizer; the spec
 * only requires a configurable history limit by turns and/or tokens, so a
 * deterministic character-based estimator is sufficient for Phase 1.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
