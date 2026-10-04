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
  id: string;
  source: CaptureSourceKind;
  content: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}
