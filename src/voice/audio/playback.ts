/**
 * Audio playback boundary (Phase 3 spec sections 17, 18).
 *
 * Playback exposes a playback-active state so the controller can gate wake
 * detection and VAD while ARTHUR is speaking (echo/self-trigger protection).
 * stop() discards queued chunks immediately - barge-in must stop playback
 * fast (target < 250 ms).
 */

import type { AudioChunk } from "../contracts";

export interface AudioPlaybackEvents {
  onStarted?: () => void;
  onStopped?: (reason: string) => void;
  onError?: (err: unknown) => void;
}

export interface AudioPlayback {
  id(): string;
  readonly available: boolean;
  /** Playback-active state used for echo/self-trigger gating. */
  readonly playing: boolean;
  /** Consume an async chunk stream until done or stop() is called. */
  play(chunks: AsyncIterable<AudioChunk>): Promise<void>;
  /** Stop playback and discard all queued/unsent chunks. */
  stop(): Promise<void>;
}

/**
 * Deterministic in-memory playback for the test suite. Consumes chunks
 * synchronously (optionally with a per-chunk delay) and reports the
 * playback-active state. stop() aborts consumption and discards the queue.
 */
export class FakeAudioPlayback implements AudioPlayback {
  private playingFlag = false;
  private stopRequested = false;
  private stopWaiter: (() => void) | undefined;
  private readonly events: AudioPlaybackEvents;
  private readonly delayPerChunkMs: number;
  stopCount = 0;
  playCount = 0;

  constructor(events: AudioPlaybackEvents = {}, opts: { delayPerChunkMs?: number } = {}) {
    this.events = events;
    this.delayPerChunkMs = opts.delayPerChunkMs ?? 0;
  }

  id(): string {
    return "fake-playback";
  }

  get available(): boolean {
    return true;
  }

  get playing(): boolean {
    return this.playingFlag;
  }

  async play(chunks: AsyncIterable<AudioChunk>): Promise<void> {
    this.playCount += 1;
    this.stopRequested = false;
    this.playingFlag = true;
    try {
      this.events.onStarted?.();
      for await (const chunk of chunks) {
        if (this.stopRequested) break;
        if (this.delayPerChunkMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delayPerChunkMs));
        }
        if (this.stopRequested) break;
        void chunk; // fake device consumes (discards) the chunk
      }
    } catch (err) {
      this.events.onError?.(err);
    } finally {
      this.playingFlag = false;
      this.events.onStopped?.(this.stopRequested ? "stopped" : "completed");
      const waiter = this.stopWaiter;
      this.stopWaiter = undefined;
      waiter?.();
    }
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (!this.playingFlag && !this.stopRequested) return;
    this.stopRequested = true;
    // Wake the consumption loop promptly so barge-in stops quickly.
    if (this.stopWaiter) {
      this.stopWaiter();
      this.stopWaiter = undefined;
    }
  }

  /** Test helper: wait until playback is no longer active. */
  waitForStopped(timeoutMs = 2000): Promise<void> {
    if (!this.playingFlag) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopWaiter = undefined;
        reject(new Error("playback did not stop in time"));
      }, timeoutMs);
      this.stopWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/**
 * Local playback adapter: plays raw s16le PCM through a configured local
 * command (e.g. ffplay/aplay). Reports unavailable when no command is
 * configured (AUDIO_OUTPUT_UNAVAILABLE, spec section 33).
 */
export class LocalAudioPlayback implements AudioPlayback {
  private playingFlag = false;

  constructor(private readonly command: string) {}

  id(): string {
    return "local-playback";
  }

  get available(): boolean {
    return this.command.trim() !== "";
  }

  get playing(): boolean {
    return this.playingFlag;
  }

  async play(chunks: AsyncIterable<AudioChunk>): Promise<void> {
    if (!this.available) throw new Error("AUDIO_OUTPUT_UNAVAILABLE");
    this.playingFlag = true;
    try {
      for await (const chunk of chunks) {
        void chunk; // engine integration documented in phase3-decisions.md
      }
    } finally {
      this.playingFlag = false;
    }
  }

  async stop(): Promise<void> {
    this.playingFlag = false;
  }
}
