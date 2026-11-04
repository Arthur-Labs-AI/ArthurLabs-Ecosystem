/**
 * HR-03A: bounded typed error for hybrid registry validation.
 *
 * Precedent is VoiceProviderError: a dedicated Error subclass carrying a
 * bounded machine-readable category. The global ArthurError code union is
 * deliberately NOT extended (it drives HTTP status mapping); hybrid
 * registry reasons travel in `reason` and messages carry no secrets.
 */

export const HYBRID_ERROR_REASONS = [
  "INVALID_NODE_DESCRIPTOR",
  "NODE_ID_CONFLICT",
  "UNKNOWN_NODE",
  "INVALID_PROVIDER_DESCRIPTOR",
  "PROVIDER_ID_CONFLICT",
  "PROVIDER_NODE_LOCALITY_MISMATCH",
  "INVALID_ROUTING_REQUEST",
  "INVALID_ROUTING_DECISION",
] as const;

export type HybridErrorReason = (typeof HYBRID_ERROR_REASONS)[number];

export function isHybridErrorReason(value: unknown): value is HybridErrorReason {
  return typeof value === "string" && (HYBRID_ERROR_REASONS as readonly string[]).includes(value);
}

export class HybridRegistryError extends Error {
  readonly reason: HybridErrorReason;

  constructor(reason: HybridErrorReason, detail: string) {
    super(detail);
    this.name = "HybridRegistryError";
    this.reason = reason;
  }
}
