/**
 * Deterministic scripted TTS for tests (Phase 3 spec sections 7.4, 38).
 *
 * Splits the requested text into speakable chunks of a configured size and
 * emits real AudioChunks with monotonic timestamps. Supports cancellation
 * (stops emitting, releases the queue) and configurable inter-chunk delay.
 */

import { AudioChunk, TtsProvider, TtsRequest } from "../contracts";
import { estimateSpeechMs, syntheticAudioChunk } from "./contracts";

export interface FakeTtsOptions {
  /** Characters per synthesized chunk (default 40). */
  chunkChars?: number;
  /** Delay between chunks (default 0 for deterministic tests). */
  chunkDelayMs?: number;
  /** Frame duration of each emitted chunk (default 60). */
  chunkDurationMs?: number;
}

export class FakeTtsProvider implements TtsProvider {
  private readonly cancelled = new Set<string>();
  readonly requests: TtsRequest[] = [];
  readonly emittedChunks: AudioChunk[] = [];
  cancelCount = 0;

  constructor(private readonly opts: FakeTtsOptions = {}) {}

  id(): string {
    return "fake-tts";
  }

  get available(): boolean {
    return true;
  }

  isCancelled(synthesisId: string): boolean {
    return this.cancelled.has(synthesisId);
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    this.requests.push(request);
    const chunkChars = this.opts.chunkChars ?? 40;
    const chunkDurationMs = this.opts.chunkDurationMs ?? 60;
    const totalMs = estimateSpeechMs(request.text);
    const totalChunks = Math.max(1, Math.ceil(totalMs / chunkDurationMs));
    const textChunks: string[] = [];
    for (let i = 0; i < request.text.length; i += chunkChars) {
      textChunks.push(request.text.slice(i, i + chunkChars));
    }
    const count = Math.max(textChunks.length, totalChunks);
    let timestamp = Date.now();
    for (let i = 0; i < count; i++) {
      if (this.cancelled.has(request.synthesisId)) return;
      const chunk = syntheticAudioChunk(request.synthesisId, i, timestamp, chunkDurationMs, request.sampleRateHz, i);
      if (i === count - 1) chunk.final = true;
      this.emittedChunks.push(chunk);
      yield chunk;
      timestamp += chunkDurationMs;
      if (this.opts.chunkDelayMs && this.opts.chunkDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.opts.chunkDelayMs));
        if (this.cancelled.has(request.synthesisId)) return;
      }
    }
  }

  async cancel(synthesisId: string): Promise<void> {
    this.cancelCount += 1;
    this.cancelled.add(synthesisId);
  }
}