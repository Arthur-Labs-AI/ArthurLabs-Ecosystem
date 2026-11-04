/**
 * STT-specific contracts (Phase 3 spec sections 7.3, 12).
 * The core types live in ../contracts; this module adds language handling
 * and transcript normalization helpers shared by adapters.
 */

import { SttEvent, SttOptions } from "../contracts";

export type { SttEvent, SttOptions } from "../contracts";

/**
 * STT Quality v2 language profiles (TASK-0008). "en" and "bg" map to
 * explicit engine language codes; "auto" enables engine-side detection.
 * Prefer an explicit profile whenever the expected language is known:
 * auto-detection is unstable for short accented utterances.
 */
export const STT_LANGUAGES = ["auto", "bg", "en"] as const;
export type SttLanguage = (typeof STT_LANGUAGES)[number];

/**
 * Future primary/fallback language policy (TASK-0008 architecture hook).
 * A retry policy ABOVE the engine wrapper (controller/gateway layer - never
 * inside tools/voice/stt_wrapper.cjs) may re-run an utterance with a
 * fallback profile (e.g. explicit en -> auto) when:
 *   - the transcript is empty or unusable (isUsableTranscript),
 *   - the reported final language mismatches the expected profile
 *     (SttEvent "final" carries language), or
 *   - a future bounded quality score (TODO: STT-Quality-v3 confidence from
 *     whisper.cpp --output-json-full probabilities) is below threshold.
 * The wrapper itself stays single-shot: no hidden retries inside the engine
 * boundary.
 */

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
