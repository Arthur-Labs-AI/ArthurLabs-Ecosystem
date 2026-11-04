/**
 * Voice layer contracts (Phase 3 spec sections 7, 8, 22).
 *
 * The voice controller and every gateway depend only on these interfaces.
 * All engine-specific code (wake word, VAD, STT, TTS, audio devices) stays
 * inside provider adapters so ARTHUR Core never couples to one engine.
 *
 * Privacy invariants (spec sections 27-28): raw PCM audio lives in memory
 * buffers only; it is never persisted, logged, or sent to DeepSeek.
 */

// ---------------------------------------------------------------------------
// PCM audio format (spec section 8)
// ---------------------------------------------------------------------------

/**
 * One normalized internal PCM frame. Microphone input is converted to this
 * format before it reaches VAD/STT; provider adapters resample only at their
 * own boundaries.
 */
export interface PcmFrame {
  /** Monotonic frame sequence within the current capture session. */
  sequence: number;
  /** Monotonic local timestamp (ms). */
  timestamp_ms: number;
  sample_rate_hz: number;
  channels: 1;
  sample_format: "s16le";
  duration_ms: number;
  /** Raw mono s16le PCM bytes. Never persisted/logged by default. */
  data: Uint8Array;
}

/** Internal sample rate every adapter must be able to handle. */
export const INTERNAL_SAMPLE_RATE_HZ = 16000;
/** Internal frame duration (ms) used by capture scripts and fakes. */
export const INTERNAL_FRAME_DURATION_MS = 20;
export const INTERNAL_SAMPLES_PER_FRAME = (INTERNAL_SAMPLE_RATE_HZ * INTERNAL_FRAME_DURATION_MS) / 1000;

/** Convert s16le bytes into Int16 samples (view copy safe for callers). */
export function bytesToInt16(data: Uint8Array): Int16Array {
  const out = new Int16Array(Math.floor(data.byteLength / 2));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

/** Build a normalized PCM frame from Int16 samples. */
export function frameFromInt16(
  samples: Int16Array | number[],
  sequence: number,
  timestampMs: number,
  sampleRateHz = INTERNAL_SAMPLE_RATE_HZ,
): PcmFrame {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i] as number, true);
  }
  return {
    sequence,
    timestamp_ms: timestampMs,
    sample_rate_hz: sampleRateHz,
    channels: 1,
    sample_format: "s16le",
    duration_ms: Math.round((samples.length / sampleRateHz) * 1000),
    data,
  };
}

/** Root-mean-square energy (0..32768) of a frame, used by local VAD/wake. */
export function frameEnergy(frame: PcmFrame): number {
  const samples = bytesToInt16(frame.data);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as number;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/** A frame of pure silence (used by tests and pre-roll helpers). */
export function silenceFrame(sequence: number, timestampMs: number, sampleRateHz = INTERNAL_SAMPLE_RATE_HZ): PcmFrame {
  return frameFromInt16(new Int16Array((sampleRateHz * INTERNAL_FRAME_DURATION_MS) / 1000), sequence, timestampMs, sampleRateHz);
}

// ---------------------------------------------------------------------------
// Voice state (spec section 9)
// ---------------------------------------------------------------------------

export const VoiceState = {
  DISABLED: "disabled",
  IDLE: "idle",
  LISTENING: "listening",
  CAPTURING: "capturing",
  TRANSCRIBING_FINAL: "transcribing_final",
  THINKING: "thinking",
  SPEAKING: "speaking",
  INTERRUPTING: "interrupting",
  ERROR: "error",
} as const;

export type VoiceState = (typeof VoiceState)[keyof typeof VoiceState];

export const ACTIVE_VOICE_STATES: readonly VoiceState[] = [
  VoiceState.LISTENING,
  VoiceState.CAPTURING,
  VoiceState.TRANSCRIBING_FINAL,
  VoiceState.THINKING,
  VoiceState.SPEAKING,
  VoiceState.INTERRUPTING,
];

// ---------------------------------------------------------------------------
// Wake word (spec section 7.1)
// ---------------------------------------------------------------------------

export interface WakeEvent {
  kind: "wake_detected";
  detected_at_ms: number;
  provider: string;
}

export interface WakeWordConfig {
  wakeWord: string;
  sampleRateHz: number;
  frameDurationMs: number;
  /** In-memory pre-roll window (ms) so the first syllable is not lost. */
  preRollMs: number;
  /** Provider-specific sensitivity (0..1). */
  threshold: number;
}

export interface WakeWordProvider {
  id(): string;
  start(config: WakeWordConfig, onWake: (event: WakeEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** Whether this provider can actually run in the current environment. */
  readonly available: boolean;
}

// ---------------------------------------------------------------------------
// VAD (spec section 7.2)
// ---------------------------------------------------------------------------

export interface VadResult {
  /** 0..1 speech probability estimate. */
  speechProbability: number;
  isSpeech: boolean;
  transition?: "speech_started" | "speech_ended";
}

export interface VadConfig {
  speechStartThreshold: number;
  speechEndThreshold: number;
  /** Consecutive frames above start threshold before declaring speech. */
  speechStartFrames: number;
  /** Consecutive frames below end threshold before declaring speech end. */
  speechEndFrames: number;
  /** Tiny clicks/noise below this duration are rejected. */
  minSpeechMs: number;
  /** Natural pause before finalizing an utterance. */
  endSilenceMs: number;
  /** Hard bound; the controller finalizes/cancels at this duration. */
  maxUtteranceMs: number;
  /** Wake without speech returns to IDLE after this timeout. */
  noSpeechTimeoutMs: number;
  frameDurationMs: number;
}

export interface VadProvider {
  id(): string;
  /** Deterministic per-frame classification. Never async. */
  process(frame: PcmFrame): VadResult;
  reset(): void;
}

// ---------------------------------------------------------------------------
// STT (spec section 7.3)
// ---------------------------------------------------------------------------

export interface SttOptions {
  utteranceId: string;
  /** "auto" | "bg" | "en" (language hints stay configurable). */
  language?: string;
  /** Hard cap on the final transcript length. */
  maxTranscriptChars: number;
  /** Audio duration in ms of the utterance (for realtime-factor metrics). */
  audioDurationMs?: number;
}

export type SttEvent =
  | { type: "partial"; text: string; stability?: number }
  | { type: "final"; text: string; language?: string; confidence?: number }
  | { type: "error"; code: string };

export interface SttProvider {
  id(): string;
  transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent>;
  cancel(utteranceId: string): Promise<void>;
  readonly available: boolean;
}

// ---------------------------------------------------------------------------
// TTS (spec section 7.4)
// ---------------------------------------------------------------------------

export interface TtsRequest {
  synthesisId: string;
  text: string;
  voice: string;
  sampleRateHz: number;
}

export interface AudioChunk {
  synthesisId: string;
  sequence: number;
  timestamp_ms: number;
  sample_rate_hz: number;
  channels: 1;
  sample_format: "s16le";
  duration_ms: number;
  data: Uint8Array;
  /** True on the final chunk of this synthesis. */
  final?: boolean;
}

export interface TtsProvider {
  id(): string;
  synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk>;
  cancel(synthesisId: string): Promise<void>;
  readonly available: boolean;
}

// ---------------------------------------------------------------------------
// Voice session (spec section 22)
// ---------------------------------------------------------------------------

export interface VoiceSession {
  voice_session_id: string;
  arthur_session_id: string;
  state: VoiceState;
  active_utterance_id?: string;
  active_turn_id?: string;
  input_device_id?: string;
  output_device_id?: string;
  wake_enabled: boolean;
  push_to_talk_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Voice error codes (spec section 36)
// ---------------------------------------------------------------------------

export const VoiceErrorCode = {
  VOICE_DISABLED: "VOICE_DISABLED",
  AUDIO_INPUT_UNAVAILABLE: "AUDIO_INPUT_UNAVAILABLE",
  AUDIO_OUTPUT_UNAVAILABLE: "AUDIO_OUTPUT_UNAVAILABLE",
  WAKE_UNAVAILABLE: "WAKE_UNAVAILABLE",
  VAD_FAILED: "VAD_FAILED",
  STT_FAILED: "STT_FAILED",
  STT_EMPTY: "STT_EMPTY",
  TTS_FAILED: "TTS_FAILED",
  VOICE_TIMEOUT: "VOICE_TIMEOUT",
  VOICE_BUSY: "VOICE_BUSY",
  VOICE_CANCELLED: "VOICE_CANCELLED",
  VOICE_STATE_INVALID: "VOICE_STATE_INVALID",
  /**
   * Extension beyond the spec section 36 table: model/provider failure on the",
   * voice path (DeepSeek unavailable etc.). Documented in phase3-decisions.md.",
   */
  MODEL_FAILED: "MODEL_FAILED",
} as const;

export type VoiceErrorCode = (typeof VoiceErrorCode)[keyof typeof VoiceErrorCode];

/** Typed voice error carrying the spec section 36 code. */
export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly component?: string;

  constructor(code: VoiceErrorCode, message: string, component?: string, opts: { cause?: unknown } = {}) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.component = component;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Voice component health / status (spec sections 24, 35)
// ---------------------------------------------------------------------------

export interface VoiceComponentStatus {
  id: string;
  available: boolean;
  /** Safe detail only - never paths, secrets, or raw audio info. */
  detail?: string;
}

export interface VoiceStatus {
  enabled: boolean;
  state: VoiceState;
  wake: VoiceComponentStatus;
  vad: VoiceComponentStatus;
  stt: VoiceComponentStatus;
  tts: VoiceComponentStatus;
  audio_input: VoiceComponentStatus;
  audio_output: VoiceComponentStatus;
  wake_word: string;
  stt_language: string;
  tts_voice: string;
  raw_audio_retention: boolean;
  session?: {
    voice_session_id: string;
    arthur_session_id: string;
    mode?: string;
  };
}