/**
 * Capture contracts.
 *
 * Every input mechanism (text, voice, EMG) terminates at the same logical
 * object: a `Capture`. No input source talks to the Cognitive Store or Graph
 * directly (Repo Structure, Rule 3).
 *
 * `content` is the authoritative raw source of a capture: the original text or
 * the original transcript. Raw microphone audio is not persisted.
 */

export const CAPTURE_SOURCE_KINDS = ["text", "voice", "emg"] as const;

export type CaptureSourceKind = (typeof CAPTURE_SOURCE_KINDS)[number];

export interface Capture {
  /** Assigned by the store; unique and stable. */
  id: string;
  source: CaptureSourceKind;
  content: string;
  /** ISO-8601 (RFC 3339) timestamp assigned by the store. */
  createdAt: string;
}

/** What a caller supplies. Identity and time are assigned by the store, never by the caller. */
export interface CreateCaptureInput {
  source: CaptureSourceKind;
  content: string;
}

/** Mirrored by the native store; keep both in sync. */
export const MAX_CAPTURE_CONTENT_CHARS = 20_000;

export function isCaptureSourceKind(value: unknown): value is CaptureSourceKind {
  return typeof value === "string" && (CAPTURE_SOURCE_KINDS as readonly string[]).includes(value);
}

/** Returns why `value` is not a valid create request, or `null` when it is valid. */
export function describeCreateCaptureInputProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "input must be an object";
  const { source, content } = value as Record<string, unknown>;
  if (!isCaptureSourceKind(source)) return "source is not a known capture source";
  if (typeof content !== "string") return "content must be a string";
  if (content.trim().length === 0) return "content is empty";
  if ([...content].length > MAX_CAPTURE_CONTENT_CHARS) {
    return `content exceeds ${MAX_CAPTURE_CONTENT_CHARS} characters`;
  }
  return null;
}

export function isCaptureTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function isCapture(value: unknown): value is Capture {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    isCaptureSourceKind(candidate.source) &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0 &&
    isCaptureTimestamp(candidate.createdAt)
  );
}

/**
 * Why a voice capture attempt failed. The native layer reports exactly one of these
 * codes so the UI can react without knowing about permissions, providers or files.
 */
export const VOICE_CAPTURE_ERROR_CODES = [
  "voice_unavailable",
  "microphone_permission_denied",
  "already_recording",
  "not_recording",
  "recording_failed",
  "recording_interrupted",
  "stt_not_configured",
  "stt_failed",
  "empty_transcript",
  "capture_failed",
] as const;

export type VoiceCaptureErrorCode = (typeof VOICE_CAPTURE_ERROR_CODES)[number];

export interface VoiceCaptureErrorPayload {
  code: VoiceCaptureErrorCode;
  /** Safe to show to the user. Never contains credentials, paths or provider bodies. */
  message: string;
}

export function isVoiceCaptureErrorCode(value: unknown): value is VoiceCaptureErrorCode {
  return typeof value === "string" && (VOICE_CAPTURE_ERROR_CODES as readonly string[]).includes(value);
}

export function isVoiceCaptureErrorPayload(value: unknown): value is VoiceCaptureErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isVoiceCaptureErrorCode(candidate.code) && typeof candidate.message === "string";
}
