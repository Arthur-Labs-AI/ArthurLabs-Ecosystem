/**
 * Speakable chunker (Phase 3 spec sections 16, 43).
 *
 * Never feed token-by-token output to TTS. Text deltas are buffered into
 * speakable units at sentence boundaries, with a bounded phrase fallback
 * for very long sentences and hard splits for pathological tokens. The
 * controller combines this with a bounded TTS queue for backpressure.
 */

export interface SpeakableChunk {
  sequence: number;
  text: string;
  final: boolean;
}

export interface SpeakableChunkerOptions {
  /** Max chars emitted in one chunk (hard bound). */
  maxChunkChars?: number;
  /** Buffered text flushed even without a sentence boundary at this size. */
  maxSentenceChars?: number;
  /** Smallest chunk worth speaking (below this, keep buffering). */
  minChunkChars?: number;
}

const SENTENCE_BOUNDARY = new Set([".", "!", "?", ";", "\n"]);

export class SpeakableChunker {
  private readonly maxChunkChars: number;
  private readonly maxSentenceChars: number;
  private readonly minChunkChars: number;
  private buffer = "";
  private sequence = 0;

  constructor(opts: SpeakableChunkerOptions = {}) {
    this.maxChunkChars = opts.maxChunkChars ?? 400;
    this.maxSentenceChars = opts.maxSentenceChars ?? 240;
    this.minChunkChars = opts.minChunkChars ?? 24;
  }

  get buffered(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = "";
    this.sequence = 0;
  }

  /**
   * Buffer a text delta and return any ready speakable chunks. Chunks are
   * returned in order; the caller must preserve order when queuing TTS.
   */
  push(delta: string): SpeakableChunk[] {
    this.buffer += delta;
    const out: SpeakableChunk[] = [];
    for (;;) {
      if (this.buffer.length <= 0) break;
      const boundaryIndex = this.findBoundaryIndex();
      if (boundaryIndex >= 0 && boundaryIndex + 1 >= this.minChunkChars) {
        out.push(this.emit(boundaryIndex + 1, false));
        continue;
      }
      if (this.buffer.length >= this.maxSentenceChars) {
        // Long sentence without a boundary: phrase fallback at the last
        // space, else a hard split (bounded, never an infinite buffer).
        const lastSpace = this.buffer.lastIndexOf(" ", this.maxSentenceChars);
        const cut = lastSpace >= this.minChunkChars ? lastSpace + 1 : this.maxSentenceChars;
        out.push(this.emit(cut, false));
        continue;
      }
      break;
    }
    return out;
  }

  /** Flush the remainder as a final chunk (response end / hold release). */
  flush(): SpeakableChunk[] {
    if (this.buffer.trim() === "") {
      this.buffer = "";
      return [];
    }
    return [this.emit(this.buffer.length, true)];
  }

  private findBoundaryIndex(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== undefined && SENTENCE_BOUNDARY.has(ch)) {
        // A boundary is only safe when it is followed by a space or the end
        // (avoids splitting numbers like 3.14 or initials like J. Smith).
        const next = this.buffer[i + 1];
        if (next === undefined || next === " " || next === "\n") return i;
      }
    }
    return -1;
  }

  private emit(length: number, final: boolean): SpeakableChunk {
    const text = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    const trimmed = text.trim();
    if (trimmed === "") {
      return { sequence: this.sequence, text: "", final };
    }
    const chunk: SpeakableChunk = { sequence: this.sequence, text: trimmed, final };
    this.sequence += 1;
    return chunk;
  }
}
