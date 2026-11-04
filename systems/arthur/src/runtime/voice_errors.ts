/**
 * HR-02: bounded voice provider failure taxonomy.
 *
 * Routers use these categories to decide whether fallback is SAFE — never
 * arbitrary prose and never raw provider bodies (which may contain secrets).
 * VoiceErrorCode (STT_FAILED/TTS_FAILED) stays the controller-visible code;
 * this taxonomy is the internal routing signal. It reuses existing ARTHUR
 * error vocabulary where possible instead of inventing parallel types.
 */

export const VOICE_FAILURE_CATEGORIES = [
  "provider_unavailable",
  "provider_auth_failure",
  "provider_timeout",
  "provider_request_failure",
  "provider_protocol_failure",
  "provider_cancelled",
  "local_worker_unavailable",
  "local_worker_crashed",
  "transcription_failed",
  "speech_synthesis_failed",
] as const;

export type VoiceFailureCategory = (typeof VOICE_FAILURE_CATEGORIES)[number];

export function isVoiceFailureCategory(value: unknown): value is VoiceFailureCategory {
  return (
    typeof value === "string" &&
    (VOICE_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Normalized provider failure: bounded category + safe detail (no secrets). */
export interface VoiceProviderFailure {
  category: VoiceFailureCategory;
  /** Safe one-line detail for logs; must never contain keys, bodies, or paths. */
  detail: string;
}

/**
 * Whether the router may safely try the alternate provider for the SAME
 * complete utterance/synthesis. Cancellation is never "failed over" (the
 * turn is gone); auth failures fall back only for STT re-transcription and
 * pre-playback TTS, never resuming partial playback.
 */
export function isFallbackSafe(category: VoiceFailureCategory): boolean {
  switch (category) {
    case "provider_unavailable":
    case "provider_auth_failure":
    case "provider_timeout":
    case "provider_request_failure":
    case "provider_protocol_failure":
    case "local_worker_unavailable":
    case "local_worker_crashed":
    case "transcription_failed":
    case "speech_synthesis_failed":
      return true;
    case "provider_cancelled":
      return false;
  }
}

/**
 * Map a provider-thrown error to a bounded category. Providers should throw
 * VoiceProviderError directly; this is the defensive fallback for foreign
 * errors (never inspects message text for secrets — classification only).
 */
export class VoiceProviderError extends Error {
  readonly category: VoiceFailureCategory;

  constructor(category: VoiceFailureCategory, detail: string) {
    super(detail);
    this.name = "VoiceProviderError";
    this.category = category;
  }
}

export function categorizeVoiceError(err: unknown): VoiceFailureCategory {
  if (err instanceof VoiceProviderError) return err.category;
  if (err instanceof Error && /cancel|abort/i.test(err.message)) return "provider_cancelled";
  if (err instanceof Error && /timed?\s*out/i.test(err.message)) return "provider_timeout";
  return "provider_request_failure";
}
