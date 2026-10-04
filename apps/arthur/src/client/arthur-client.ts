import type { Capture, CreateCaptureInput, RuntimeInfo, VoiceCaptureErrorCode } from "@arthur/contracts";

/**
 * Which implementation backs the UI.
 * - `desktop`: Tauri shell on Linux/Windows (later macOS).
 * - `mobile`: Tauri shell on Android (later iOS).
 * - `preview`: plain browser or tests, no native layer.
 */
export type ArthurClientKind = "desktop" | "mobile" | "preview";

/** What this client can do, so the UI can adapt without knowing which platform it is on. */
export interface ArthurClientCapabilities {
  readonly voiceCapture: boolean;
}

/** A voice capture attempt failed. `code` says why; `message` is safe to show to the user. */
export class VoiceCaptureError extends Error {
  readonly code: VoiceCaptureErrorCode;

  constructor(code: VoiceCaptureErrorCode, message: string) {
    super(message);
    this.name = "VoiceCaptureError";
    this.code = code;
  }
}

/**
 * The only way the product UI talks to Arthur.
 *
 * Components must not reach for localhost HTTP, Tailscale addresses, SQLite,
 * Android native APIs, microphones, speech providers or Node processes
 * (Repo Structure, Rule 5). Anything the UI needs is added here and
 * implemented per platform behind this interface.
 */
export interface ArthurClient {
  readonly kind: ArthurClientKind;
  readonly capabilities: ArthurClientCapabilities;
  getRuntimeInfo(): Promise<RuntimeInfo>;
  /** Persists a capture before resolving; the store assigns its id and timestamp. */
  createCapture(input: CreateCaptureInput): Promise<Capture>;
  /** All persisted captures, newest first. */
  listCaptures(): Promise<Capture[]>;

  /** Starts recording the microphone. Rejects with a `VoiceCaptureError`. */
  startVoiceCapture(): Promise<void>;
  /**
   * Stops recording, transcribes the speech, and resolves with the persisted
   * `source: "voice"` capture. The audio itself is never kept.
   */
  finishVoiceCapture(): Promise<Capture>;
  /** Discards an in-progress recording without transcribing it. */
  cancelVoiceCapture(): Promise<void>;
}
