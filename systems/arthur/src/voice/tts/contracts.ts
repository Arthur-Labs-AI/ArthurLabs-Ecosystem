/**
 * TTS-specific contracts (Phase 3 spec section 7.4).
 * Core types live in ../contracts; this module adds chunk timing helpers.
 */

import { AudioChunk } from "../contracts";

export type { AudioChunk, TtsRequest } from "../contracts";

/**
 * Rough estimate of synthesized audio duration for a text (used by fakes
 * to emit realistic chunk timings and by the chunker for pacing).
 * ~55 ms of audio per character is a reasonable neutral speaking rate.
 */
export function estimateSpeechMs(text: string, msPerChar = 55): number {
  const chars = text.replace(/\s+/g, "").length;
  return Math.max(100, chars * msPerChar);
}

/**
 * Deterministic PCM chunk for a text slice (fake synthesis). Generates a
 * gentle sine tone so chunk boundaries are observable and playback tests
 * can count delivered audio.
 */
export function syntheticAudioChunk(
  synthesisId: string,
  sequence: number,
  timestampMs: number,
  durationMs: number,
  sampleRateHz = 16000,
  seed = 0,
): AudioChunk {
  const samples = Math.round((sampleRateHz * durationMs) / 1000);
  const data = new Uint8Array(samples * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < samples; i++) {
    // 220 Hz tone with a seed-based phase offset; amplitude low enough
    // that the fake is never mistaken for meaningful audio.
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRateHz + seed) * 400);
    view.setInt16(i * 2, value, true);
  }
  return {
    synthesisId,
    sequence,
    timestamp_ms: timestampMs,
    sample_rate_hz: sampleRateHz,
    channels: 1,
    sample_format: "s16le",
    duration_ms: durationMs,
    data,
  };
}
