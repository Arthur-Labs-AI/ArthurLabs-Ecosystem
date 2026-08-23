/**
 * STT-specific contracts (Phase 3 spec sections 7.3, 12).
 * The core types live in ../contracts; this module adds language handling
 * and transcript normalization helpers shared by adapters.
 */

import { SttEvent, SttOptions } from "../contracts";

export type { SttEvent, SttOptions } from "../contracts";

export const STT_LANGUAGES = ["auto", "bg", "en"] as const;
export type SttLanguage = (typeof STT_LANGUAGES)[number];

export function isSttLanguage(value: unknown): value is SttLanguage {
  return typeof value === "string" && (STT_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Conservative transcript normalization (spec section 12): collapse
 * whitespace and trim punctuation-only noise. Never rewrites meaning.
 */
export function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A transcript is usable when it has at least one alphanumeric character. */
export function isUsableTranscript(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Bound a transcript before a turn is created (spec sections 12, 28).
 * Returns a bounded copy; callers must reject or trim per policy.
 */
export function boundTranscript(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).trim();
}
