/**
 * FRS-02 §8: OpenAI cloud voice readiness (STT + TTS separately).
 *
 * Reuses the existing OpenAI STT/TTS provider implementations — no second
 * HTTP client. Each check tests the requested CLOUD provider DIRECTLY (no
 * local fallback), so "cloud failure + local fallback" can never falsely
 * report cloud READY.
 *
 * TTS: synthesize a very short fixed phrase, require valid non-empty
 * canonical audio output, discard it. Never played, never persisted,
 * never logged.
 *
 * STT: transcribe a deterministic tiny in-memory WAV-framed silence
 * sample (no microphone). Only the contract response shape is judged —
 * transcription quality is NOT judged (silence hallucination with a
 * structurally valid response is still READY).
 *
 * Explicit setup/diagnostic actions only; no startup probing.
 */

import { OpenAiSttProvider } from '../voice/stt/openai_provider';
import { OpenAiTtsProvider } from '../voice/tts/openai_provider';
import { VoiceProviderError } from '../runtime/voice_errors';
import type { PcmFrame } from '../voice/contracts';
import {
  failedResult,
  notConfigured,
  readyResult,
  type ProviderReadiness,
  type ReadinessFailureCategory,
} from './readiness';

export const OPENAI_STT_READINESS_ID = 'openai-stt';
export const OPENAI_TTS_READINESS_ID = 'openai-tts';
export const OPENAI_STT_READINESS_CAPABILITY = 'cloud_stt';
export const OPENAI_TTS_READINESS_CAPABILITY = 'cloud_tts';

/** Very short fixed TTS validation phrase (deterministic, minimal cost). */
export const VOICE_VALIDATION_PHRASE = 'Ready.';
/** Deterministic tiny silence sample: 400 ms @16 kHz mono s16le. */
export const STT_FIXTURE_MS = 400;
export const STT_FIXTURE_HZ = 16000;

function silenceFrames(totalMs = STT_FIXTURE_MS, hz = STT_FIXTURE_HZ): PcmFrame[] {
  const samplesPerFrame = Math.floor((hz * 20) / 1000);
  const frameCount = Math.max(1, Math.round(totalMs / 20));
  const frames: PcmFrame[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    frames.push({
      sequence: i,
      timestamp_ms: i * 20,
      sample_rate_hz: hz,
      channels: 1,
      sample_format: 's16le',
      duration_ms: 20,
      data: new Uint8Array(samplesPerFrame * 2),
    });
  }
  return frames;
}

async function* frameStream(frames: PcmFrame[]): AsyncIterable<PcmFrame> {
  for (const frame of frames) yield frame;
}

function classifyVoiceError(err: unknown): { status: ProviderReadiness['status']; category: ReadinessFailureCategory; httpStatus?: number } {
  if (err instanceof VoiceProviderError) {
    switch (err.category) {
      case 'provider_auth_failure':
        return { status: 'auth_failed', category: 'auth' };
      case 'provider_timeout':
        return { status: 'unavailable', category: 'timeout' };
      case 'provider_protocol_failure':
        return { status: 'failed', category: 'bad_response' };
      case 'provider_cancelled':
        return { status: 'failed', category: 'cancelled' };
      case 'speech_synthesis_failed':
        return { status: 'failed', category: 'empty_result' };
      default:
        return { status: 'unavailable', category: 'network' };
    }
  }
  if (err instanceof Error) {
    if (/cancel|abort/i.test(err.message)) return { status: 'failed', category: 'cancelled' };
    if (/timed?s*out/i.test(err.message)) return { status: 'unavailable', category: 'timeout' };
    if (/empty|no audio/i.test(err.message)) return { status: 'failed', category: 'empty_result' };
  }
  return { status: 'unavailable', category: 'network' };
}

export interface OpenAiSttReadinessConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface OpenAiSttReadinessDeps {
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
  frames?: PcmFrame[];
}

/**
 * Explicit cloud STT readiness: transcribe the deterministic fixture
 * through the REAL OpenAiSttProvider (REST path). Any structurally valid
 * final (even hallucinated text from silence) is READY; only transport /
 * auth / protocol failures are not.
 */
export async function checkOpenAiSttReadiness(
  config: OpenAiSttReadinessConfig,
  deps: OpenAiSttReadinessDeps = {},
): Promise<ProviderReadiness> {
  if (typeof config.apiKey !== 'string' || config.apiKey.trim() === '' || typeof config.model !== 'string' || config.model.trim() === '') {
    return notConfigured(OPENAI_STT_READINESS_ID, OPENAI_STT_READINESS_CAPABILITY);
  }
  const provider = new OpenAiSttProvider({
    apiKey: config.apiKey,
    model: config.model,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    requestTimeoutMs: deps.requestTimeoutMs ?? 30_000,
    ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
  });
  try {
    const frames = deps.frames ?? silenceFrames();
    let final: { text: string } | undefined;
    for await (const event of provider.transcribeStream(frameStream(frames), {
      utteranceId: 'frs02-stt-readiness',
      maxTranscriptChars: 8000,
    })) {
      if (event.type === 'final') {
        if (typeof event.text !== 'string') {
          return failedResult(OPENAI_STT_READINESS_ID, OPENAI_STT_READINESS_CAPABILITY, 'failed', 'bad_response');
        }
        final = { text: event.text };
      } else if (event.type === 'error') {
        // The provider already normalized the failure category into the
        // code: STT_AUTH_FAILED = auth, everything else = transport.
        if (event.code === 'STT_AUTH_FAILED') {
          return failedResult(OPENAI_STT_READINESS_ID, OPENAI_STT_READINESS_CAPABILITY, 'auth_failed', 'auth');
        }
        return failedResult(OPENAI_STT_READINESS_ID, OPENAI_STT_READINESS_CAPABILITY, 'unavailable', 'network');
      }
    }
    if (final === undefined) {
      return failedResult(OPENAI_STT_READINESS_ID, OPENAI_STT_READINESS_CAPABILITY, 'failed', 'bad_response');
    }
    return readyResult(OPENAI_STT_READINESS_ID, OPENAI_STT_READINESS_CAPABILITY, ['transcription']);
  } catch (err) {
    const classified = classifyVoiceError(err);
    return failedResult(OPENAI_STT_READINESS_ID, OPENAI_STT_READINESS_CAPABILITY, classified.status, classified.category, classified.httpStatus);
  }
}

export interface OpenAiTtsReadinessConfig {
  apiKey: string;
  model: string;
  voice: string;
  baseUrl?: string;
}

export interface OpenAiTtsReadinessDeps {
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
  phrase?: string;
}

/**
 * Explicit cloud TTS readiness: synthesize the fixed short phrase through
 * the REAL OpenAiTtsProvider and require non-empty canonical audio.
 * Audio is discarded (never played, persisted, or logged).
 */
export async function checkOpenAiTtsReadiness(
  config: OpenAiTtsReadinessConfig,
  deps: OpenAiTtsReadinessDeps = {},
): Promise<ProviderReadiness> {
  if (
    typeof config.apiKey !== 'string' || config.apiKey.trim() === '' ||
    typeof config.model !== 'string' || config.model.trim() === '' ||
    typeof config.voice !== 'string' || config.voice.trim() === ''
  ) {
    return notConfigured(OPENAI_TTS_READINESS_ID, OPENAI_TTS_READINESS_CAPABILITY);
  }
  let provider: OpenAiTtsProvider;
  try {
    provider = new OpenAiTtsProvider({
      apiKey: config.apiKey,
      model: config.model,
      voice: config.voice,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      requestTimeoutMs: deps.requestTimeoutMs ?? 30_000,
      ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    });
  } catch {
    // Unsupported model for the speech endpoint: invalid configuration,
    // never a network call.
    return failedResult(OPENAI_TTS_READINESS_ID, OPENAI_TTS_READINESS_CAPABILITY, 'invalid_config', 'rejected');
  }
  try {
    let totalBytes = 0;
    let chunks = 0;
    for await (const chunk of provider.synthesizeStream({
      synthesisId: 'frs02-tts-readiness',
      text: deps.phrase ?? VOICE_VALIDATION_PHRASE,
      voice: config.voice,
      sampleRateHz: 16000,
    })) {
      chunks += 1;
      totalBytes += chunk.data.byteLength;
      // Discard immediately: readiness proves output exists, keeps nothing.
    }
    if (chunks === 0 || totalBytes === 0) {
      return failedResult(OPENAI_TTS_READINESS_ID, OPENAI_TTS_READINESS_CAPABILITY, 'failed', 'empty_result');
    }
    return readyResult(OPENAI_TTS_READINESS_ID, OPENAI_TTS_READINESS_CAPABILITY, ['synthesis']);
  } catch (err) {
    const classified = classifyVoiceError(err);
    return failedResult(OPENAI_TTS_READINESS_ID, OPENAI_TTS_READINESS_CAPABILITY, classified.status, classified.category, classified.httpStatus);
  }
}
