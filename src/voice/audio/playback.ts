/**
 * Audio playback boundary (Phase 3 spec sections 17, 18).
 *
 * Playback exposes a playback-active state so the controller can gate wake
 * detection and VAD while ARTHUR is speaking (echo/self-trigger protection).
 * stop() discards queued chunks immediately - barge-in must stop playback
 * fast (target < 250 ms).
 */
import type { AudioChunk } from "../contracts";
import type { ChildProcess } from "node:child_process";
import {
  BoundedTail,
  awaitSpawn,
  drainOrClose,
  killChild,
  spawnEngine,
  terminateChild,
  waitForClose,
} from "../process_util";
import type { LogSink, TextSanitizer } from "../process_util";

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
  private stopRequestedFlag = false;
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

  /** True when stop() was requested; latched until the next play(). */
  get stopRequested(): boolean {
    return this.stopRequestedFlag;
  }

  async play(chunks: AsyncIterable<AudioChunk>): Promise<void> {
    this.playCount += 1;
    this.stopRequestedFlag = false;
    this.playingFlag = true;
    try {
      this.events.onStarted?.();
      for await (const chunk of chunks) {
        if (this.stopRequestedFlag) break;
        if (this.delayPerChunkMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delayPerChunkMs));
        }
        if (this.stopRequestedFlag) break;
        void chunk; // fake device consumes (discards) the chunk
      }
    } catch (err) {
      this.events.onError?.(err);
    } finally {
      this.playingFlag = false;
      this.events.onStopped?.(this.stopRequestedFlag ? "stopped" : "completed");
      const waiter = this.stopWaiter;
      this.stopWaiter = undefined;
      waiter?.();
    }
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (!this.playingFlag && !this.stopRequestedFlag) return;
    this.stopRequestedFlag = true;
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
/**
 * Local playback adapter (Phase 3 spec sections 17, 18, 33).
 *
 * Spawns a configured local playback command (e.g. ffplay/aplay reading raw
 * mono s16le PCM from stdin) and streams AudioChunk PCM into its stdin with
 * backpressure, preserving chunk order. Explicit cancellation (stop():
 * barge-in, user interrupt, disable) kills the child immediately and
 * discards queued audio so barge-in stays under the 250 ms target; normal
 * completion instead waits on a dedicated EOF-drain deadline so a healthy
 * player draining its buffer is never misclassified as a failure. Once
 * stopped, stale-generation audio can never resume (the consumption loop is
 * latched and the child is reaped).
 */
export interface LocalAudioPlaybackOptions {
  /**
   * Grace window for terminating the child on EXPLICIT cancellation
   * (stop()/barge-in). Interruption latency target: <= 250 ms (default).
   */
  killGraceMs?: number;
  /**
   * Grace for NORMAL completion, measured after all PCM was written and
   * stdin was closed (default 2000 ms). A healthy player may legitimately
   * take longer than the kill grace to exit on EOF because it still has to
   * drain buffered audio. This window is additionally extended by the
   * estimated remaining buffered audio (from AudioChunk duration metadata),
   * capped by maxPlaybackMs. Distinct from killGraceMs on purpose: barge-in
   * must be fast, normal EOF must not be misclassified as a failure.
   */
  eofDrainGraceMs?: number;
  /** Hard cap on a single play() session (default 5 minutes). */
  maxPlaybackMs?: number;
  /** Secret-safe logger (app Logger redacts known secrets). */
  logger?: LogSink;
  /** Optional text sanitizer applied to stderr tails before logging. */
  sanitizer?: TextSanitizer;
  /** Extra environment passed to the playback command. */
  env?: Record<string, string>;
  events?: AudioPlaybackEvents;
}

export class LocalAudioPlayback implements AudioPlayback {
  private playingFlag = false;
  private stopped = false;
  private child: ChildProcess | undefined;
  private readonly killGraceMs: number;
  private readonly eofDrainGraceMs: number;
  private readonly maxPlaybackMs: number;
  private readonly logger: LogSink | undefined;
  private readonly sanitizer: TextSanitizer | undefined;
  private readonly extraEnv: Record<string, string>;
  private readonly events: AudioPlaybackEvents;

  constructor(
    private readonly command: string,
    opts: LocalAudioPlaybackOptions = {},
  ) {
    this.killGraceMs = opts.killGraceMs ?? 250;
    this.eofDrainGraceMs = opts.eofDrainGraceMs ?? 2_000;
    this.maxPlaybackMs = opts.maxPlaybackMs ?? 300_000;
    this.logger = opts.logger;
    this.sanitizer = opts.sanitizer;
    this.extraEnv = opts.env ?? {};
    this.events = opts.events ?? {};
  }

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
    if (!this.available) {
      throw new Error("AUDIO_OUTPUT_UNAVAILABLE: no playback command configured");
    }
    // Defensive single-consumer: an overlapping play() must not stack.
    if (this.child) {
      await this.stop();
    }
    const child = spawnEngine(this.command, { ...this.extraEnv, ARTHUR_AUDIO_OUTPUT_DEVICE: "default" });
    child.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    this.child = child;
    this.stopped = false;
    this.playingFlag = true;
    const stderrTail = new BoundedTail(8192);
    child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));
    try {
      await awaitSpawn(child);
    } catch (err) {
      if (this.child === child) this.child = undefined;
      this.playingFlag = false;
      await terminateChild(child, 300).catch(() => undefined);
      throw new Error(
        `AUDIO_OUTPUT_UNAVAILABLE: playback command failed to start (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    try {
      this.events.onStarted?.();
      const startedAtMs = Date.now();
      // Estimated audio still buffered inside the player at stdin EOF,
      // derived from the emitted AudioChunk duration metadata.
      let writtenAudioMs = 0;
      const deadline = startedAtMs + this.maxPlaybackMs;
      for await (const chunk of chunks) {
        if (this.stopped || this.child !== child) break;
        if (Date.now() > deadline) {
          killChild(child);
          throw new Error("playback exceeded max duration");
        }
        if (chunk.duration_ms > 0) writtenAudioMs += chunk.duration_ms;
        if (child.stdin && !child.stdin.write(chunk.data)) {
          await drainOrClose(child.stdin, child);
          if (this.stopped || this.child !== child) break;
        }
      }
      if (!this.stopped && this.child === child) {
        child.stdin?.end();
        // NORMAL completion is not an interruption. The player still has to
        // drain its internal buffer after stdin EOF, which can legitimately
        // exceed the 250 ms kill grace (observed with ffplay on Windows:
        // false "exited abnormally code:null" failures). Wait on a dedicated
        // normal-drain deadline: eofDrainGraceMs plus the estimated buffered
        // audio, capped by maxPlaybackMs - never unbounded.
        const elapsedMs = Math.max(0, Date.now() - startedAtMs);
        const remainingAudioMs = Math.max(0, writtenAudioMs - elapsedMs);
        const drainTimeoutMs = this.eofDrainGraceMs + Math.min(remainingAudioMs, this.maxPlaybackMs);
        let code = await waitForClose(child, drainTimeoutMs);
        if (this.stopped || this.child !== child) return;
        if (code === null) {
          // The player did not exit within the normal-drain deadline: reap it
          // (bounded by the kill grace) and only then classify as failure.
          await terminateChild(child, this.killGraceMs).catch(() => undefined);
          code = child.exitCode;
        }
        if (code !== 0) {
          this.logger?.warn("playback process exited abnormally", {
            code,
            stderr_tail: this.sanitizeTail(stderrTail.text),
          });
          throw new Error(`playback process exited with code ${String(code)}`);
        }
      }
    } catch (err) {
      this.events.onError?.(err);
      throw err;
    } finally {
      this.playingFlag = false;
      if (this.child === child) this.child = undefined;
      this.events.onStopped?.(this.stopped ? "stopped" : "completed");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.playingFlag = false;
    const child = this.child;
    this.child = undefined;
    if (child) {
      await terminateChild(child, this.killGraceMs).catch(() => undefined);
    }
  }

  private sanitizeTail(text: string): string {
    if (text === "") return "";
    const sanitized = this.sanitizer ? this.sanitizer.sanitizeText(text) : text;
    return sanitized.length > 2000 ? `${sanitized.slice(-2000)} (truncated)` : sanitized;
  }
}