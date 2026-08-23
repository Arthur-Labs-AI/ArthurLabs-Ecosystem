/**
 * Audio capture boundary (Phase 3 spec sections 8, 34).
 *
 * One owner opens/closes the microphone. Capture emits normalized mono PCM
 * frames (s16le, internal sample rate); provider adapters resample only at
 * their own boundaries. Raw frames are memory-only and never persisted.
 */
import type { PcmFrame } from "../contracts";
import { INTERNAL_FRAME_DURATION_MS } from "../contracts";
import type { ChildProcess } from "node:child_process";
import {
  BoundedTail,
  awaitSpawn,
  spawnEngine,
  terminateChild,
} from "../process_util";
import type { LogSink, TextSanitizer } from "../process_util";

export interface AudioCapture {
  id(): string;
  /** Whether a usable microphone exists in this environment. */
  readonly available: boolean;
  readonly active: boolean;
  /** Safe label only - never OS internals or private device details. */
  readonly deviceLabel: string;
  start(onFrame: (frame: PcmFrame) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Scripted capture used by the deterministic test suite. Frames are fed
 * explicitly via feedFrame(); no OS audio device is touched.
 */
export class FakeAudioCapture implements AudioCapture {
  private activeFlag = false;
  private handler: ((frame: PcmFrame) => void) | undefined;
  private nextSequence = 0;
  startCount = 0;
  stopCount = 0;

  constructor(private readonly label = "fake-input") {}

  id(): string {
    return "fake-capture";
  }

  get available(): boolean {
    return true;
  }

  get active(): boolean {
    return this.activeFlag;
  }

  get deviceLabel(): string {
    return this.label;
  }

  async start(onFrame: (frame: PcmFrame) => void): Promise<void> {
    if (this.activeFlag) return;
    this.activeFlag = true;
    this.handler = onFrame;
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    if (!this.activeFlag) return;
    this.activeFlag = false;
    this.handler = undefined;
    this.stopCount += 1;
  }

  /** Deterministic script: feed frames to the active handler (test helper). */
  feedFrame(frame: PcmFrame): void {
    if (!this.activeFlag || !this.handler) return;
    this.handler(frame);
  }

  nextSequenceNumber(): number {
    this.nextSequence += 1;
    return this.nextSequence - 1;
  }
}

/**
 * Local capture adapter: spawns a configured local capture command (e.g.
 * ffmpeg/sox writing raw s16le mono PCM to stdout). When no command is
 * configured the adapter reports unavailable and the controller fails
 * closed with AUDIO_INPUT_UNAVAILABLE (spec section 33).
 */
/**
 * Local capture adapter (Phase 3 spec sections 8, 33, 34).
 *
 * Spawns a configured local capture command (e.g. ffmpeg writing raw mono
 * s16le PCM to stdout) and converts its stdout into bounded PcmFrames at
 * the configured sample rate. When no command is configured the adapter
 * reports unavailable and the controller fails closed with
 * AUDIO_INPUT_UNAVAILABLE. Raw frames are memory-only and never persisted;
 * stderr is only ever logged through the secret-safe logger sink.
 */
export interface LocalAudioCaptureOptions {
  /** Capture frame duration in ms (default: internal 20 ms). */
  frameDurationMs?: number;
  /** Cap on buffered stdout bytes before frames are dropped (default 128 KiB). */
  maxPendingBytes?: number;
  /** Grace window for terminating the child (default 500 ms). */
  killGraceMs?: number;
  /** Secret-safe logger (app Logger redacts known secrets). */
  logger?: LogSink;
  /** Optional text sanitizer applied to stderr tails before logging. */
  sanitizer?: TextSanitizer;
  /** Extra environment passed to the capture command. */
  env?: Record<string, string>;
}

export class LocalAudioCapture implements AudioCapture {
  private activeFlag = false;
  private child: ChildProcess | undefined;
  private sequence = 0;
  private pending = Buffer.alloc(0);
  private overflowWarned = false;
  private readonly frameDurationMs: number;
  private readonly samplesPerFrame: number;
  private readonly maxPendingBytes: number;
  private readonly killGraceMs: number;
  private readonly logger: LogSink | undefined;
  private readonly sanitizer: TextSanitizer | undefined;
  private readonly extraEnv: Record<string, string>;

  constructor(
    private readonly command: string,
    private readonly sampleRateHz: number,
    private readonly deviceId: string,
    opts: LocalAudioCaptureOptions = {},
  ) {
    this.frameDurationMs = opts.frameDurationMs ?? INTERNAL_FRAME_DURATION_MS;
    this.samplesPerFrame = Math.max(1, Math.round((sampleRateHz * this.frameDurationMs) / 1000));
    this.maxPendingBytes = opts.maxPendingBytes ?? 128 * 1024;
    this.killGraceMs = opts.killGraceMs ?? 500;
    this.logger = opts.logger;
    this.sanitizer = opts.sanitizer;
    this.extraEnv = opts.env ?? {};
  }

  id(): string {
    return "local-capture";
  }

  get available(): boolean {
    return this.command.trim() !== "";
  }

  get active(): boolean {
    return this.activeFlag;
  }

  get deviceLabel(): string {
    return this.available ? "local input" : "no input device configured";
  }

  async start(onFrame: (frame: PcmFrame) => void): Promise<void> {
    if (!this.available) {
      throw new Error("AUDIO_INPUT_UNAVAILABLE: no capture command configured");
    }
    if (this.activeFlag) return;
    const child = spawnEngine(this.command, {
      ...this.extraEnv,
      ARTHUR_AUDIO_INPUT_DEVICE: this.deviceId,
    });
    // Permanent error listener: keeps 'error' from crashing the process and
    // lets awaitSpawn surface spawn failures deterministically.
    child.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    this.child = child;
    try {
      await awaitSpawn(child);
    } catch (err) {
      if (this.child === child) this.child = undefined;
      await terminateChild(child, 300).catch(() => undefined);
      throw new Error(
        `AUDIO_INPUT_UNAVAILABLE: capture command failed to start (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    this.activeFlag = true;
    this.sequence = 0;
    this.pending = Buffer.alloc(0);
    this.overflowWarned = false;
    const stderrTail = new BoundedTail(8192);
    child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));
    child.stdout?.on("data", (chunk: Buffer) => this.onStdoutData(child, chunk, onFrame));
    child.on("exit", (code, signal) => {
      const wasActive = this.child === child && this.activeFlag;
      if (this.child === child) this.child = undefined;
      if (wasActive) {
        this.activeFlag = false;
        this.logger?.warn("audio capture process exited unexpectedly", {
          code,
          signal,
          stderr_tail: this.sanitizeTail(stderrTail.text),
        });
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.activeFlag = false;
    this.pending = Buffer.alloc(0);
    if (child) {
      await terminateChild(child, this.killGraceMs).catch(() => undefined);
    }
  }

  private onStdoutData(child: ChildProcess, chunk: Buffer, onFrame: (frame: PcmFrame) => void): void {
    if (!this.activeFlag || this.child !== child) return;
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length > this.maxPendingBytes) {
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        this.logger?.warn("audio capture output exceeded the bounded buffer; dropping overflow");
      }
      this.pending = this.pending.subarray(this.pending.length - this.maxPendingBytes);
    }
    const bytesPerFrame = this.samplesPerFrame * 2;
    while (this.pending.length >= bytesPerFrame) {
      const raw = this.pending.subarray(0, bytesPerFrame);
      this.pending = this.pending.subarray(bytesPerFrame);
      const data = new Uint8Array(bytesPerFrame);
      data.set(raw);
      onFrame({
        sequence: this.sequence,
        timestamp_ms: Date.now(),
        sample_rate_hz: this.sampleRateHz,
        channels: 1,
        sample_format: "s16le",
        duration_ms: this.frameDurationMs,
        data,
      });
      this.sequence += 1;
    }
  }

  private sanitizeTail(text: string): string {
    if (text === "") return "";
    const sanitized = this.sanitizer ? this.sanitizer.sanitizeText(text) : text;
    // Never log more than a bounded tail of raw engine stderr.
    return sanitized.length > 2000 ? `${sanitized.slice(-2000)} (truncated)` : sanitized;
  }
}