/**
 * Centralized secret-safety boundary (spec sections 7, 18; audit HIGH 5).
 *
 * Every value that can end up in persistence, a provider payload, a tool record,
 * or a client-facing response is sanitized here. This is the single choke point;
 * the logger redacts independently as a second line of defense.
 */

import { isSecretLikeKey, redactText } from "./redaction";

export const DEFAULT_SUMMARY_MAX_CHARS = 500;

/** Recursively redact known secrets AND any value under a secret-like key. */
export function sanitizeStructured(value: unknown, secrets: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeStructured(v, secrets));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretLikeKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitizeStructured(val, secrets);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return redactText(value, secrets);
  }
  return value;
}

export class SecretSanitizer {
  private readonly secrets: readonly string[];

  constructor(secrets: readonly string[]) {
    this.secrets = secrets;
  }

  /** Redact known secrets + generic patterns from free-form text. */
  sanitizeText(text: string): string {
    return redactText(text, this.secrets);
  }

  /** Sanitize an arbitrary structured value while preserving its static shape. */
  sanitizeValue<T>(value: T): T {
    return sanitizeStructured(value, this.secrets) as T;
  }

  /** Redact secret-like keys and known secrets in structured data (tool args). */
  sanitizeObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
    return sanitizeStructured(value, this.secrets) as Record<string, unknown>;
  }

  /** Cap a summary so unbounded tool results are never persisted verbatim. */
  capSummary(text: string, max = DEFAULT_SUMMARY_MAX_CHARS): string {
    if (!text) return text;
    const safe = this.sanitizeText(text);
    if (safe.length <= max) return safe;
    return `${safe.slice(0, max)}\u2026(truncated)`;
  }
}
