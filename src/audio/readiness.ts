/**
 * FRS-03: reusable audio readiness representation (FRS-04/FRS-05 seam).
 *
 * Distinguishes the failure boundary the task requires: not_configured /
 * backend_missing / device_missing / capture_failed / playback_failed /
 * degraded / ready — and, separately, transport (bytes moved) from signal
 * (audible/acoustic content). Diagnostics are bounded static strings plus
 * safe numeric metrics; never raw FFmpeg stderr, never raw PCM.
 */

export const AUDIO_READINESS_STATUSES = [
  'not_configured',
  'backend_missing',
  'device_missing',
  'capture_failed',
  'playback_failed',
  'degraded',
  'ready',
] as const;

export type AudioReadinessStatus = (typeof AUDIO_READINESS_STATUSES)[number];

export interface AudioTransportMetrics {
  framesReceived: number;
  bytesReceived: number;
  durationMs: number;
  /** Peak |sample| observed (0..32768), safe numeric only. */
  peakLevel: number;
  /** RMS level (0..32768), safe numeric only. */
  rmsLevel: number;
  /** True when the observed level exceeds ambient-silence threshold. */
  signalDetected: boolean;
}

export interface AudioReadiness {
  backend: string;
  input: string;
  output: string;
  captureTransport: 'unknown' | 'ready' | 'failed';
  /** 'silent' still proves transport — signal is advisory, not a failure. */
  captureSignal: 'unknown' | 'detected' | 'silent';
  playbackTransport: 'unknown' | 'ready' | 'failed';
  audibleConfirmed: boolean | 'unknown';
  status: AudioReadinessStatus;
  metrics?: AudioTransportMetrics;
  diagnostics: string[];
}

export function emptyAudioMetrics(): AudioTransportMetrics {
  return { framesReceived: 0, bytesReceived: 0, durationMs: 0, peakLevel: 0, rmsLevel: 0, signalDetected: false };
}

/** Compute peak/RMS over s16le PCM bytes (pure, bounded, no retention). */
export function analyzePcmLevel(pcm: Buffer, maxBytes = 256 * 1024): { peak: number; rms: number } {
  const length = Math.min(pcm.length - (pcm.length % 2), maxBytes - (maxBytes % 2));
  if (length <= 0) return { peak: 0, rms: 0 };
  let peak = 0;
  let sumSquares = 0;
  const samples = Math.floor(length / 2);
  for (let i = 0; i < length; i += 2) {
    const sample = pcm.readInt16LE(i);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }
  return { peak, rms: Math.sqrt(sumSquares / Math.max(1, samples)) };
}

/** Ambient-silence threshold: below this RMS the line is silent but transport may be fine. */
export const SILENCE_RMS_THRESHOLD = 100;

export function notConfiguredReadiness(backend: string): AudioReadiness {
  return {
    backend,
    input: '',
    output: '',
    captureTransport: 'unknown',
    captureSignal: 'unknown',
    playbackTransport: 'unknown',
    audibleConfirmed: 'unknown',
    status: 'not_configured',
    diagnostics: ['audio is not configured; run arthur audio setup'],
  };
}