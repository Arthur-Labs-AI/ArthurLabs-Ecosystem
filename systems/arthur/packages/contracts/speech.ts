/**
 * Voice output (M04.6). React asks the native layer to SPEAK text; the audio, the provider endpoint, its headers and its response
 * never cross this boundary. Mirrors the native `SpeechStatus` (`src-tauri/src/tts/service.rs`).
 *
 * Nothing here carries the spoken text, audio or a credential, and nothing is persisted: there is no speech history.
 */

export const SPEECH_STATES = ["idle", "preparing", "playing"] as const;
export type SpeechState = (typeof SPEECH_STATES)[number];

/** `stopped` covers the user pressing Stop, a newer request replacing this one, and the system taking audio focus. */
export const SPEECH_OUTCOMES = ["finished", "stopped", "failed"] as const;
export type SpeechOutcome = (typeof SPEECH_OUTCOMES)[number];

export const SPEECH_FAILURES = ["notConfigured", "invalidCredential", "unreachable", "unsupported", "synthesisFailed", "playbackFailed", "unavailable"] as const;
export type SpeechFailure = (typeof SPEECH_FAILURES)[number];

/** The first chunk of the latest session: what a person waits for, in milliseconds. */
export interface SpeechTimings {
  startupMs: number;
  synthesisMs: number;
  preparationMs: number;
  timeToAudibleMs: number;
  cleanupMs: number;
}

export interface SpeechStatus {
  state: SpeechState;
  sessionId: number;
  chunkIndex: number;
  chunkCount: number;
  /** Text beyond the bound was left out of this session. */
  truncated: boolean;
  outcome: SpeechOutcome | null;
  failure: SpeechFailure | null;
  timings: SpeechTimings;
}

export interface SpeechStart {
  sessionId: number;
  chunkCount: number;
  truncated: boolean;
}

/** What `speakText` may refuse up front, before any provider call. */
export const SPEECH_ERROR_CODES = ["emptyText", "unsupportedVoiceOrModel"] as const;
export type SpeechErrorCode = (typeof SPEECH_ERROR_CODES)[number];

export interface SpeakInput {
  text: string;
  /** Must be one the provider offers; otherwise refused. Omit for the configured voice. */
  voice?: string;
  model?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function isSpeechStatus(value: unknown): value is SpeechStatus {
  if (!isRecord(value) || !isRecord(value.timings)) return false;
  const t = value.timings;
  return (
    oneOf(SPEECH_STATES, value.state) &&
    isCount(value.sessionId) &&
    isCount(value.chunkIndex) &&
    isCount(value.chunkCount) &&
    typeof value.truncated === "boolean" &&
    (value.outcome === null || oneOf(SPEECH_OUTCOMES, value.outcome)) &&
    (value.failure === null || oneOf(SPEECH_FAILURES, value.failure)) &&
    [t.startupMs, t.synthesisMs, t.preparationMs, t.timeToAudibleMs, t.cleanupMs].every(isCount)
  );
}

export function isSpeechStart(value: unknown): value is SpeechStart {
  return isRecord(value) && isCount(value.sessionId) && isCount(value.chunkCount) && typeof value.truncated === "boolean";
}

export function isSpeechErrorPayload(value: unknown): value is { code: SpeechErrorCode } {
  return isRecord(value) && oneOf(SPEECH_ERROR_CODES, value.code);
}
