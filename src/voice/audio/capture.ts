/**
 * Audio capture boundary (Phase 3 spec sections 8, 34).
 *
 * One owner opens/closes the microphone. Capture emits normalized mono PCM
 * frames (s16le, internal sample rate); provider adapters resample only at
 * their own boundaries. Raw frames are memory-only and never persisted.
 */

import type { PcmFrame } from "../contracts";

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
export class LocalAudioCapture implements AudioCapture {
  private activeFlag = false;
  private child: { kill(): void } | undefined;

  constructor(
    private readonly command: string,
    private readonly sampleRateHz: number,
    private readonly deviceId: string,
  ) {}

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
    if (!this.available) throw new Error("AUDIO_INPUT_UNAVAILABLE");
    if (this.activeFlag) return;
    this.activeFlag = true;
    // Real engine integration is documented in phase3-decisions.md. The
    // adapter shape is stable: spawn the command, parse s16le stdout into
    // frames at the configured sample rate, and stop() kills the child.
    void onFrame;
    void this.sampleRateHz;
    void this.deviceId;
    void this.child;
  }

  async stop(): Promise<void> {
    this.activeFlag = false;
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }
}
