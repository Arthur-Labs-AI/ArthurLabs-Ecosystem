/**
 * HR-02: deterministic voice routing policies.
 *
 * - cloud_preferred: try the cloud provider when configured + usable;
 *   on failure re-transcribe/re-synthesize via local (STT: same complete
 *   utterance; TTS: only when cloud playback has not begun).
 * - local_only: local backend only; the cloud provider is never called.
 *
 * Production default for both planes: cloud_preferred.
 */

export const STT_POLICIES = ["cloud_preferred", "local_only"] as const;
export type SttPolicy = (typeof STT_POLICIES)[number];

export const TTS_POLICIES = ["cloud_preferred", "local_only"] as const;
export type TtsPolicy = (typeof TTS_POLICIES)[number];

export function isSttPolicy(value: unknown): value is SttPolicy {
  return typeof value === "string" && (STT_POLICIES as readonly string[]).includes(value);
}

export function isTtsPolicy(value: unknown): value is TtsPolicy {
  return typeof value === "string" && (TTS_POLICIES as readonly string[]).includes(value);
}

export const HR02_DEFAULTS = {
  sttPolicy: "cloud_preferred" as SttPolicy,
  ttsPolicy: "cloud_preferred" as TtsPolicy,
  cloudSttModel: "gpt-4o-transcribe",
  cloudTtsModel: "gpt-4o-mini-tts",
  cloudTtsVoice: "alloy",
  localSttProvider: "parakeet" as const,
  localSttModel: "nvidia/parakeet-tdt-0.6b-v3",
} as const;
