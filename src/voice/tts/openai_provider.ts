/**
 * HR-02 OpenAI cloud TTS provider ("openai-tts", runtime_mode = cloud).
 *
 * A speech renderer ONLY: it receives the canonical final ARTHUR text AFTER
 * ConversationLoopRunner completes. It never answers independently, never
 * summarizes, never calls tools, never touches memory, never creates a
 * second assistant turn. The canonical text stays authoritative even if
 * speech synthesis fails.
 *
 * TASK-0024 wire-body invariant: structured payload -> JSON.stringify ->
 * exact bytes sent. No regex redaction over serialized bodies; redaction
 * belongs to logs/diagnostics only (this file never logs the key).
 */

import type { AudioChunk, TtsProvider, TtsRequest } from "../contracts";
import { VoiceProviderError } from "../../runtime/voice_errors";

export const OPENAI_TTS_PROVIDER_ID = "openai-tts";
/** Request/session bound (120 s). */
export const OPENAI_TTS_TIMEOUT_MS = 120_000;
/** PCM chunk duration emitted to playback (100 ms). */
export const OPENAI_TTS_CHUNK_MS = 100;
/** Source sample rate of the OpenAI PCM stream (24 kHz). */
export const OPENAI_TTS_SOURCE_HZ = 24000;

export interface OpenAiTtsOptions {
  apiKey: string;
  model: string;
  voice: string;
  /** Speech endpoint base (default https://api.openai.com/v1/audio/speech). */
  baseUrl?: string;
  /** Target sample rate handed to playback (default request rate). */
  requestTimeoutMs?: number;
  chunkDurationMs?: number;
  fetchFn?: typeof fetch;
  logger?: { warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Models supported on POST /v1/audio/speech (renderer endpoint).
 * Realtime conversational models (gpt-realtime-*) do NOT belong here: that
 * endpoint has no model field for them and would reject the call. A future
 * realtime speech session is a separate transport, not this provider.
 */
export const OPENAI_SPEECH_ENDPOINT_MODELS = ["gpt-4o-mini-tts", "gpt-4o-mini-tts-2024-12-19", "tts-1", "tts-1-hd"] as const;

/** Fail-closed guard: never send a Realtime model to /v1/audio/speech. */
export function isSpeechEndpointModel(model: string): boolean {
  return (OPENAI_SPEECH_ENDPOINT_MODELS as readonly string[]).includes(model);
}

/** Structured speech payload (pure, testable, JSON-serialized verbatim). */
export function buildSpeechPayload(model: string, voice: string, input: string): Record<string, unknown> {
  if (!isSpeechEndpointModel(model)) {
    throw new Error("unsupported model for /v1/audio/speech: " + model);
  }
  return { model, voice, input, response_format: "pcm" };
}

/** Serialize the dispatch body: exactly JSON.stringify(payload). */
export function serializeSpeechBody(payload: Record<string, unknown>): string {
  const body = JSON.stringify(payload);
  JSON.parse(body);
  return body;
}

export class OpenAiTtsProvider implements TtsProvider {
  private readonly cancelled = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  /** Synthesis ids where usable playback began (first chunk yielded). */
  private readonly playbackBegan = new Set<string>();
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly chunkDurationMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly logger?: OpenAiTtsOptions["logger"];

  constructor(opts: OpenAiTtsOptions) {
    if (!isSpeechEndpointModel(opts.model)) {
      throw new Error("unsupported model for /v1/audio/speech: " + opts.model);
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.voice = opts.voice;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1/audio/speech").replace(/\/$/, "");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? OPENAI_TTS_TIMEOUT_MS;
    this.chunkDurationMs = opts.chunkDurationMs ?? OPENAI_TTS_CHUNK_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.logger = opts.logger;
  }

  id(): string {
    return OPENAI_TTS_PROVIDER_ID;
  }

  /** Cloud availability = configured (key + model + voice). No probing. */
  get available(): boolean {
    return this.apiKey.trim() !== "" && this.model.trim() !== "" && this.voice.trim() !== "";
  }

  /** Authorization header value (never logged). */
  authorizationHeader(): string {
    return "Bearer " + this.apiKey;
  }

  /** Whether usable playback began for a synthesis (router fallback guard). */
  hasPlaybackBegan(synthesisId: string): boolean {
    return this.playbackBegan.has(synthesisId);
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    const synthesisId = request.synthesisId;
    if (!this.available || this.cancelled.has(synthesisId)) return;
    if (typeof request.text !== "string" || request.text.trim() === "") return;
    const controller = new AbortController();
    this.controllers.set(synthesisId, controller);
    const timer = setTimeout(() => controller.abort(new Error("openai tts timed out")), this.requestTimeoutMs);
    try {
      const payload = buildSpeechPayload(this.model, this.voice, request.text);
      const body = serializeSpeechBody(payload);
      let response: Response;
      try {
        response = await this.fetchFn(this.baseUrl, {
          method: "POST",
          headers: { Authorization: this.authorizationHeader(), "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if (this.cancelled.has(synthesisId) || controller.signal.aborted) return;
        throw new VoiceProviderError("provider_request_failure", "openai tts: request failed");
      }
      if (this.cancelled.has(synthesisId)) return;
      if (!response.ok) {
        const status = response.status;
        const category = status === 401 || status === 403 ? "provider_auth_failure" : status === 408 || status === 429 || status >= 500 ? "provider_timeout" : "provider_request_failure";
        this.logger?.warn("openai tts request failed", { status });
        throw new VoiceProviderError(category, "openai tts: request failed with status " + status);
      }
      if (!response.body) {
        throw new VoiceProviderError("provider_protocol_failure", "openai tts: empty response body");
      }
      const targetHz = request.sampleRateHz;
      const bytesPerChunk = Math.max(2, Math.floor((OPENAI_TTS_SOURCE_HZ * this.chunkDurationMs) / 1000) * 2);
      const reader = response.body.getReader();
      let pending = Buffer.alloc(0);
      let seq = 0;
      const startTs = Date.now();
      let yieldedAny = false;
      try {
        for (;;) {
          if (this.cancelled.has(synthesisId)) { await reader.cancel().catch(() => undefined); return; }
          const { done, value } = await reader.read();
          if (done) break;
          pending = Buffer.concat([pending, Buffer.from(value)]);
          while (pending.length >= bytesPerChunk) {
            const raw = pending.subarray(0, bytesPerChunk);
            pending = pending.subarray(bytesPerChunk);
            const data = resampleS16le(raw, OPENAI_TTS_SOURCE_HZ, targetHz);
            const chunk: AudioChunk = {
              synthesisId,
              sequence: seq,
              timestamp_ms: startTs + seq * this.chunkDurationMs,
              sample_rate_hz: targetHz,
              channels: 1,
              sample_format: "s16le",
              duration_ms: this.chunkDurationMs,
              data,
            };
            seq += 1;
            yieldedAny = true;
            this.playbackBegan.add(synthesisId);
            yield chunk;
            if (this.cancelled.has(synthesisId)) { await reader.cancel().catch(() => undefined); return; }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (this.cancelled.has(synthesisId)) return;
      if (pending.length >= 2) {
        const data = resampleS16le(pending, OPENAI_TTS_SOURCE_HZ, targetHz);
        const durationMs = Math.max(1, Math.round((pending.length / 2 / OPENAI_TTS_SOURCE_HZ) * 1000));
        this.playbackBegan.add(synthesisId);
        yield {
          synthesisId,
          sequence: seq,
          timestamp_ms: startTs + seq * this.chunkDurationMs,
          sample_rate_hz: targetHz,
          channels: 1,
          sample_format: "s16le",
          duration_ms: durationMs,
          data,
          final: true,
        };
      } else if (yieldedAny) {
        // Zero-length tail: nothing further to emit; the consumer ends
        // the stream. (Final flags ride on real audio chunks.)
      }
      if (!yieldedAny && pending.length === 0) {
        throw new VoiceProviderError("speech_synthesis_failed", "openai tts: no audio returned");
      }
    } catch (err) {
      if (this.cancelled.has(synthesisId)) return;
      if (err instanceof VoiceProviderError) throw err;
      throw new VoiceProviderError("speech_synthesis_failed", "openai tts: synthesis failed");
    } finally {
      clearTimeout(timer);
      this.controllers.delete(synthesisId);
    }
  }

  async cancel(synthesisId: string): Promise<void> {
    this.cancelled.add(synthesisId);
    const controller = this.controllers.get(synthesisId);
    if (controller) {
      try { controller.abort(new Error("voice cancelled: " + synthesisId)); } catch { /* idempotent */ }
    }
  }

  /** Test helper: clear cancellation/playback latches. */
  resetForTest(synthesisId?: string): void {
    if (synthesisId) {
      this.cancelled.delete(synthesisId);
      this.playbackBegan.delete(synthesisId);
      return;
    }
    this.cancelled.clear();
    this.playbackBegan.clear();
  }
}

/** Nearest-neighbor s16le resample (deterministic, dependency-free). */
export function resampleS16le(input: Buffer, fromHz: number, toHz: number): Uint8Array {
  if (fromHz === toHz) {
    const out = new Uint8Array(input.length);
    out.set(input);
    return out;
  }
  const inSamples = Math.floor(input.length / 2);
  const outSamples = Math.max(1, Math.round((inSamples * toHz) / fromHz));
  const out = new Uint8Array(outSamples * 2);
  const inView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < outSamples; i++) {
    const src = Math.min(inSamples - 1, Math.floor((i * fromHz) / toHz));
    outView.setInt16(i * 2, inView.getInt16(src * 2, true), true);
  }
  return out;
}
