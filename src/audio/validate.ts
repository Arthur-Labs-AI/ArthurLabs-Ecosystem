/**
 * FRS-03: capture/playback transport validation over the EXISTING runtime.
 *
 * Capture reuses LocalAudioCapture (no second PCM interpretation); playback
 * reuses LocalAudioPlayback with a deterministic in-memory tone (no TTS, no
 * disk, no providers). Raw audio is memory-only and bounded; nothing is
 * persisted, logged, or sent anywhere. Validators take injectable factories
 * so unit tests drive fakes; the CLI passes the real adapters.
 */

import { LocalAudioCapture } from '../voice/audio/capture';
import { LocalAudioPlayback } from '../voice/audio/playback';
import { AUDIO_FRAME_DURATION_MS, AUDIO_SAMPLE_RATE_HZ } from './backend';
import { analyzePcmLevel, emptyAudioMetrics, SILENCE_RMS_THRESHOLD } from './readiness';
import type { AudioChunk, PcmFrame } from '../voice/contracts';
import type { AudioTransportMetrics } from './readiness';

export const VALIDATION_TONE_HZ = 660;
export const VALIDATION_TONE_MS = 750;
export const VALIDATION_TONE_AMPLITUDE = 8000;

export function buildValidationTone(sampleRateHz: number, durationMs: number, frequencyHz: number): Buffer {
  const samples = Math.max(1, Math.round((sampleRateHz * durationMs) / 1000));
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz) * VALIDATION_TONE_AMPLITUDE);
    pcm.writeInt16LE(value, i * 2);
  }
  return pcm;
}

export function defaultValidationTone(): Buffer {
  return buildValidationTone(AUDIO_SAMPLE_RATE_HZ, VALIDATION_TONE_MS, VALIDATION_TONE_HZ);
}

export interface ChunkedTone { synthesisId: string; chunks: AudioChunk[]; totalBytes: number; }

export function chunkPcmForPlayback(pcm: Buffer, synthesisId: string): AudioChunk[] {
  const bytesPerChunk = Math.max(2, Math.floor((AUDIO_SAMPLE_RATE_HZ * 100) / 1000) * 2);
  const chunks: AudioChunk[] = [];
  let sequence = 0;
  for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) {
    const slice = pcm.subarray(offset, offset + bytesPerChunk);
    const data = new Uint8Array(slice.length);
    data.set(slice);
    chunks.push({
      synthesisId,
      sequence,
      timestamp_ms: sequence * 100,
      sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
      channels: 1,
      sample_format: 's16le',
      duration_ms: Math.round((slice.length / 2 / AUDIO_SAMPLE_RATE_HZ) * 1000),
      data,
    });
    sequence += 1;
  }
  return chunks;
}

export interface CaptureValidationResult {
  transportReady: boolean;
  signalDetected: boolean;
  metrics: AudioTransportMetrics;
  failure?: string;
}

export interface CaptureValidatorDeps {
  createCapture?: (command: string) => { start(onFrame: (frame: PcmFrame) => void): Promise<void>; stop(): Promise<void> };
  windowMs?: number;
  now?: () => number;
}

export async function validateCaptureTransport(command: string, deps: CaptureValidatorDeps): Promise<CaptureValidationResult> {
  const windowMs = deps.windowMs !== undefined ? deps.windowMs : 1500;
  const clock = deps.now !== undefined ? deps.now : Date.now;
  const metrics: AudioTransportMetrics = emptyAudioMetrics();
  const startedAt = clock();
  let capture: { start(onFrame: (frame: PcmFrame) => void): Promise<void>; stop(): Promise<void> };
  try {
    capture = deps.createCapture !== undefined ? deps.createCapture(command) : new LocalAudioCapture(command, AUDIO_SAMPLE_RATE_HZ, 'validation');
  } catch {
    return { transportReady: false, signalDetected: false, metrics, failure: 'capture failed to start' };
  }
  const pcmParts: Buffer[] = [];
  let pcmBytes = 0;
  const onFrame = (frame: PcmFrame): void => {
    if (frame.sample_rate_hz !== AUDIO_SAMPLE_RATE_HZ || frame.channels !== 1 || frame.sample_format !== 's16le') return;
    metrics.framesReceived += 1;
    const bytes = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    metrics.bytesReceived += bytes.length;
    if (pcmBytes < 262144) {
      pcmParts.push(bytes);
      pcmBytes += bytes.length;
    }
  };
  try {
    await capture.start(onFrame);
  } catch {
    return { transportReady: false, signalDetected: false, metrics, failure: 'capture failed to start' };
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
  } finally {
    try { await capture.stop(); } catch { /* stop best effort */ }
  }
  metrics.durationMs = Math.max(0, clock() - startedAt);
  if (metrics.framesReceived === 0 || metrics.bytesReceived === 0) {
    return { transportReady: false, signalDetected: false, metrics, failure: 'no audio frames received within the capture window' };
  }
  const level = analyzePcmLevel(Buffer.concat(pcmParts));
  metrics.peakLevel = Math.round(level.peak);
  metrics.rmsLevel = Math.round(level.rms);
  metrics.signalDetected = level.rms >= SILENCE_RMS_THRESHOLD;
  return { transportReady: true, signalDetected: metrics.signalDetected, metrics };
}

export interface PlaybackValidationResult {
  transportReady: boolean;
  chunksAccepted: number;
  bytesAccepted: number;
  failure?: string;
}

export interface PlaybackValidatorDeps {
  createPlayback?: (command: string) => { play(chunks: AsyncIterable<AudioChunk>): Promise<void>; stop(): Promise<void> };
  tonePcm?: Buffer;
}

export async function validatePlaybackTransport(command: string, deps: PlaybackValidatorDeps): Promise<PlaybackValidationResult> {
  const tone = deps.tonePcm !== undefined ? deps.tonePcm : defaultValidationTone();
  let playback: { play(chunks: AsyncIterable<AudioChunk>): Promise<void>; stop(): Promise<void> };
  try {
    playback = deps.createPlayback !== undefined ? deps.createPlayback(command) : new LocalAudioPlayback(command);
  } catch {
    return { transportReady: false, chunksAccepted: 0, bytesAccepted: 0, failure: 'playback failed to start' };
  }
  const chunks = chunkPcmForPlayback(tone, 'frs03-validation');
  let chunksAccepted = 0;
  let bytesAccepted = 0;
  const counted: AsyncIterable<AudioChunk> = {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        chunksAccepted += 1;
        bytesAccepted += chunk.data.byteLength;
        yield chunk;
      }
    },
  };
  try {
    await playback.play(counted);
  } catch {
    return { transportReady: false, chunksAccepted, bytesAccepted, failure: 'playback exited abnormally' };
  }
  if (chunksAccepted === 0 || bytesAccepted === 0) {
    return { transportReady: false, chunksAccepted, bytesAccepted, failure: 'playback accepted no audio' };
  }
  return { transportReady: true, chunksAccepted, bytesAccepted };
}

export { AUDIO_FRAME_DURATION_MS };
