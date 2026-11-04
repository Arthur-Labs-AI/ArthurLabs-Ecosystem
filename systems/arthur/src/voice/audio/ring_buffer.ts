/**
 * Bounded in-memory ring buffer of PCM frames (Phase 3 spec sections 8, 10).
 *
 * Used for the wake pre-roll window so the first spoken syllable is not
 * lost. Memory-only by design: drain() returns the frames and clears the
 * buffer, and clear() drops everything - raw audio is never retained
 * (spec section 27).
 */

import type { PcmFrame } from "../contracts";

export class RingBuffer {
  private readonly frames: PcmFrame[] = [];
  private readonly maxMs: number;
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(opts: { maxMs: number; maxBytes: number }) {
    this.maxMs = opts.maxMs;
    this.maxBytes = opts.maxBytes;
  }

  get length(): number {
    return this.frames.length;
  }

  get oldestTimestampMs(): number | undefined {
    const first = this.frames[0];
    return first?.timestamp_ms;
  }

  push(frame: PcmFrame): void {
    this.frames.push(frame);
    this.totalBytes += frame.data.byteLength;
    // Evict from the head until both bounds hold (bounded memory).
    while (this.frames.length > 0) {
      const head = this.frames[0];
      const tail = this.frames[this.frames.length - 1];
      const spanMs = tail && head ? tail.timestamp_ms - head.timestamp_ms : 0;
      if (this.totalBytes <= this.maxBytes && spanMs <= this.maxMs) break;
      const dropped = this.frames.shift();
      if (dropped) this.totalBytes -= dropped.data.byteLength;
    }
  }

  /**
   * Return all buffered frames and clear the buffer (privacy: pre-roll is
   * cleared after each utterance).
   */
  drain(): PcmFrame[] {
    const out = this.frames.splice(0, this.frames.length);
    this.totalBytes = 0;
    return out;
  }

  /** Drop everything immediately (privacy / disable). */
  clear(): void {
    this.frames.length = 0;
    this.totalBytes = 0;
  }
}
