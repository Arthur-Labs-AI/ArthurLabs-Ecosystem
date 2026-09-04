/**
 * Voice configuration (Phase 3 spec section 25).
 *
 * Voice is disabled safely if configured model files/devices are unavailable:
 * startup validation never fails because an engine is missing - the voice
 * path reports component unavailability and falls back to text/PTT.
 */

import type { ReasoningProfile } from "../models/contracts";

export type VoiceProviderId = "local" | "fake";

export interface VoiceSettings {
  voiceEnabled: boolean;
  wakeEnabled: boolean;
  wakeWord: string;
  wakeProvider: VoiceProviderId;
  vadProvider: VoiceProviderId;
  sttProvider: VoiceProviderId;
  ttsProvider: VoiceProviderId;
  sttLanguage: string;
  /**
   * Optional domain-vocabulary initial prompt for local STT engines
   * (STT Quality v2, TASK-0008), e.g. "ARTHUR, Nexus, AutoPulse". Empty =
   * disabled. Bounded by STT_INITIAL_PROMPT_MAX_CHARS; the value is passed
   * to the engine as data (never logged, never a command line fragment).
   */
  sttInitialPrompt: string;
  sttModelPath: string;
  ttsModelPath: string;
  ttsVoice: string;
  audioInputDevice: string;
  audioOutputDevice: string;
  vadEndSilenceMs: number;
  noSpeechTimeoutMs: number;
  maxUtteranceMs: number;
  /**
   * Sustained user speech required before barge-in cancels playback or
   * generation (TASK-0007). A single loud frame or speaker echo must not
   * cancel ARTHUR mid-speech; ~120-200 ms feels responsive while filtering
   * transients. Energy-VAD still cannot distinguish speaker echo from user
   * speech (no AEC yet) - see controller barge-in monitoring.
   */
  bargeInMinSpeechMs: number;
  ttsMaxQueueChunks: number;
  rawAudioRetention: boolean;
  /** Internal PCM format. */
  sampleRateHz: number;
  frameDurationMs: number;
  /** Hard cap for transcripts before a turn is created (spec section 28). */
  maxTranscriptChars: number;
  /** Voice turns prefer the fast reasoning profile (spec section 32). */
  voiceReasoningProfile: ReasoningProfile;
  /** Optional external local engine command for capture/STT/TTS adapters. */
  audioCaptureCommand: string;
  audioPlaybackCommand: string;
  sttEngineCommand: string;
  ttsEngineCommand: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceEnabled: false,
  wakeEnabled: true,
  wakeWord: "arthur",
  wakeProvider: "local",
  vadProvider: "local",
  sttProvider: "local",
  ttsProvider: "local",
  sttLanguage: "auto",
  sttInitialPrompt: "",
  sttModelPath: "",
  ttsModelPath: "",
  ttsVoice: "arthur",
  audioInputDevice: "default",
  audioOutputDevice: "default",
  vadEndSilenceMs: 700,
  noSpeechTimeoutMs: 6000,
  maxUtteranceMs: 30000,
  bargeInMinSpeechMs: 150,
  ttsMaxQueueChunks: 8,
  rawAudioRetention: false,
  sampleRateHz: 16000,
  frameDurationMs: 20,
  maxTranscriptChars: 8000,
  voiceReasoningProfile: "fast",
  audioCaptureCommand: "",
  audioPlaybackCommand: "",
  sttEngineCommand: "",
  ttsEngineCommand: "",
};

export interface VoiceSettingsOverrides {
  [key: string]: string | number | boolean | undefined;
  voiceEnabled?: boolean;
  wakeEnabled?: boolean;
  wakeWord?: string;
  wakeProvider?: string;
  vadProvider?: string;
  sttProvider?: string;
  ttsProvider?: string;
  sttLanguage?: string;
  sttInitialPrompt?: string;
  sttModelPath?: string;
  ttsModelPath?: string;
  ttsVoice?: string;
  audioInputDevice?: string;
  audioOutputDevice?: string;
  vadEndSilenceMs?: number;
  noSpeechTimeoutMs?: number;
  maxUtteranceMs?: number;
  bargeInMinSpeechMs?: number;
  ttsMaxQueueChunks?: number;
  rawAudioRetention?: boolean;
  maxTranscriptChars?: number;
  voiceReasoningProfile?: string;
  audioCaptureCommand?: string;
  audioPlaybackCommand?: string;
  sttEngineCommand?: string;
  ttsEngineCommand?: string;
}

/** Hard bound for the STT initial prompt (mirrored by the engine wrapper). */
export const STT_INITIAL_PROMPT_MAX_CHARS = 2048;

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v;
}

function envInt(key: string, fallback: number): number {
  const raw = envStr(key, String(fallback));
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = envStr(key, "").toLowerCase();
  if (raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * Load voice settings from ARTHUR_VOICE_* environment variables and camelCase
 * overrides (tests). Unknown override keys are ignored so a SettingsOverrides
 * bag can be shared with loadSettings.
 */
export function loadVoiceSettings(overrides: VoiceSettingsOverrides = {}): VoiceSettings {
  // Accept both the nested { voice: {...} } SettingsOverrides bag and the
  // flat voice-key bag; unknown keys are ignored either way.
  const source: VoiceSettingsOverrides = (overrides.voice ?? overrides) as VoiceSettingsOverrides;
  const pick = <T>(envKey: string, fallback: T, overKey: keyof VoiceSettingsOverrides): T => {
    const over = source[overKey];
    if (over !== undefined) return over as T;
    const raw = process.env[envKey];
    if (raw === undefined || raw === "") return fallback;
    return raw as unknown as T;
  };
  const pickInt = (envKey: string, fallback: number, overKey: keyof VoiceSettingsOverrides): number => {
    const over = source[overKey];
    if (over !== undefined) return Number(over);
    return envInt(envKey, fallback);
  };
  const pickBool = (envKey: string, fallback: boolean, overKey: keyof VoiceSettingsOverrides): boolean => {
    const over = source[overKey];
    if (over !== undefined) return Boolean(over);
    return envBool(envKey, fallback);
  };

  return {
    voiceEnabled: pickBool("ARTHUR_VOICE_ENABLED", DEFAULT_VOICE_SETTINGS.voiceEnabled, "voiceEnabled"),
    wakeEnabled: pickBool("ARTHUR_WAKE_ENABLED", DEFAULT_VOICE_SETTINGS.wakeEnabled, "wakeEnabled"),
    wakeWord: pick("ARTHUR_WAKE_WORD", DEFAULT_VOICE_SETTINGS.wakeWord, "wakeWord"),
    wakeProvider: pick("ARTHUR_WAKE_PROVIDER", DEFAULT_VOICE_SETTINGS.wakeProvider, "wakeProvider"),
    vadProvider: pick("ARTHUR_VAD_PROVIDER", DEFAULT_VOICE_SETTINGS.vadProvider, "vadProvider"),
    sttProvider: pick("ARTHUR_STT_PROVIDER", DEFAULT_VOICE_SETTINGS.sttProvider, "sttProvider"),
    ttsProvider: pick("ARTHUR_TTS_PROVIDER", DEFAULT_VOICE_SETTINGS.ttsProvider, "ttsProvider"),
    sttLanguage: pick("ARTHUR_STT_LANGUAGE", DEFAULT_VOICE_SETTINGS.sttLanguage, "sttLanguage"),
    sttInitialPrompt: pick("ARTHUR_STT_INITIAL_PROMPT", DEFAULT_VOICE_SETTINGS.sttInitialPrompt, "sttInitialPrompt"),
    sttModelPath: pick("ARTHUR_STT_MODEL_PATH", DEFAULT_VOICE_SETTINGS.sttModelPath, "sttModelPath"),
    ttsModelPath: pick("ARTHUR_TTS_MODEL_PATH", DEFAULT_VOICE_SETTINGS.ttsModelPath, "ttsModelPath"),
    ttsVoice: pick("ARTHUR_TTS_VOICE", DEFAULT_VOICE_SETTINGS.ttsVoice, "ttsVoice"),
    audioInputDevice: pick("ARTHUR_AUDIO_INPUT_DEVICE", DEFAULT_VOICE_SETTINGS.audioInputDevice, "audioInputDevice"),
    audioOutputDevice: pick("ARTHUR_AUDIO_OUTPUT_DEVICE", DEFAULT_VOICE_SETTINGS.audioOutputDevice, "audioOutputDevice"),
    vadEndSilenceMs: pickInt("ARTHUR_VAD_END_SILENCE_MS", DEFAULT_VOICE_SETTINGS.vadEndSilenceMs, "vadEndSilenceMs"),
    noSpeechTimeoutMs: pickInt("ARTHUR_VOICE_NO_SPEECH_TIMEOUT_MS", DEFAULT_VOICE_SETTINGS.noSpeechTimeoutMs, "noSpeechTimeoutMs"),
    maxUtteranceMs: pickInt("ARTHUR_VOICE_MAX_UTTERANCE_MS", DEFAULT_VOICE_SETTINGS.maxUtteranceMs, "maxUtteranceMs"),
    bargeInMinSpeechMs: pickInt("ARTHUR_VOICE_BARGE_IN_MIN_SPEECH_MS", DEFAULT_VOICE_SETTINGS.bargeInMinSpeechMs, "bargeInMinSpeechMs"),
    ttsMaxQueueChunks: pickInt("ARTHUR_TTS_MAX_QUEUE_CHUNKS", DEFAULT_VOICE_SETTINGS.ttsMaxQueueChunks, "ttsMaxQueueChunks"),
    rawAudioRetention: pickBool("ARTHUR_RAW_AUDIO_RETENTION", DEFAULT_VOICE_SETTINGS.rawAudioRetention, "rawAudioRetention"),
    sampleRateHz: DEFAULT_VOICE_SETTINGS.sampleRateHz,
    frameDurationMs: DEFAULT_VOICE_SETTINGS.frameDurationMs,
    maxTranscriptChars: pickInt("ARTHUR_VOICE_MAX_TRANSCRIPT_CHARS", DEFAULT_VOICE_SETTINGS.maxTranscriptChars, "maxTranscriptChars"),
    voiceReasoningProfile: pick("ARTHUR_VOICE_REASONING_PROFILE", DEFAULT_VOICE_SETTINGS.voiceReasoningProfile, "voiceReasoningProfile") as ReasoningProfile,
    audioCaptureCommand: pick("ARTHUR_AUDIO_CAPTURE_COMMAND", DEFAULT_VOICE_SETTINGS.audioCaptureCommand, "audioCaptureCommand"),
    audioPlaybackCommand: pick("ARTHUR_AUDIO_PLAYBACK_COMMAND", DEFAULT_VOICE_SETTINGS.audioPlaybackCommand, "audioPlaybackCommand"),
    sttEngineCommand: pick("ARTHUR_STT_ENGINE_COMMAND", DEFAULT_VOICE_SETTINGS.sttEngineCommand, "sttEngineCommand"),
    ttsEngineCommand: pick("ARTHUR_TTS_ENGINE_COMMAND", DEFAULT_VOICE_SETTINGS.ttsEngineCommand, "ttsEngineCommand"),
  };
}

/** Startup validation problems; empty array = valid. */
export function validateVoiceSettings(settings: VoiceSettings): string[] {
  const problems: string[] = [];
  const providers = ["local", "fake"];
  if (!providers.includes(settings.wakeProvider)) {
    problems.push(`ARTHUR_WAKE_PROVIDER must be one of ${providers.join(", ")} (got "${settings.wakeProvider}")`);
  }
  if (!providers.includes(settings.vadProvider)) {
    problems.push(`ARTHUR_VAD_PROVIDER must be one of ${providers.join(", ")} (got "${settings.vadProvider}")`);
  }
  if (!providers.includes(settings.sttProvider)) {
    problems.push(`ARTHUR_STT_PROVIDER must be one of ${providers.join(", ")} (got "${settings.sttProvider}")`);
  }
  if (!providers.includes(settings.ttsProvider)) {
    problems.push(`ARTHUR_TTS_PROVIDER must be one of ${providers.join(", ")} (got "${settings.ttsProvider}")`);
  }
  if (settings.sampleRateHz < 8000 || settings.sampleRateHz > 48000) {
    problems.push("ARTHUR_VOICE_SAMPLE_RATE must be within 8000..48000");
  }
  if (settings.frameDurationMs < 10 || settings.frameDurationMs > 100) {
    problems.push("ARTHUR_VOICE_FRAME_DURATION_MS must be within 10..100");
  }
  if (settings.vadEndSilenceMs < 100 || settings.vadEndSilenceMs > 10000) {
    problems.push("ARTHUR_VAD_END_SILENCE_MS must be within 100..10000");
  }
  if (settings.noSpeechTimeoutMs < 500 || settings.noSpeechTimeoutMs > 60000) {
    problems.push("ARTHUR_VOICE_NO_SPEECH_TIMEOUT_MS must be within 500..60000");
  }
  if (settings.maxUtteranceMs < 1000 || settings.maxUtteranceMs > 300000) {
    problems.push("ARTHUR_VOICE_MAX_UTTERANCE_MS must be within 1000..300000");
  }
  if (settings.bargeInMinSpeechMs < 40 || settings.bargeInMinSpeechMs > 1000) {
    problems.push("ARTHUR_VOICE_BARGE_IN_MIN_SPEECH_MS must be within 40..1000");
  }
  if (settings.ttsMaxQueueChunks < 1 || settings.ttsMaxQueueChunks > 256) {
    problems.push("ARTHUR_TTS_MAX_QUEUE_CHUNKS must be within 1..256");
  }
  if (settings.maxTranscriptChars < 100 || settings.maxTranscriptChars > 100000) {
    problems.push("ARTHUR_VOICE_MAX_TRANSCRIPT_CHARS must be within 100..100000");
  }
  if (settings.sttInitialPrompt.length > STT_INITIAL_PROMPT_MAX_CHARS) {
    problems.push(
      `ARTHUR_STT_INITIAL_PROMPT must be at most ${STT_INITIAL_PROMPT_MAX_CHARS} characters (got ${settings.sttInitialPrompt.length})`,
    );
  }
  return problems;
}