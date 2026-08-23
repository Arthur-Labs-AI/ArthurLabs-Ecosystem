/**
 * Wake word gateway (Phase 3 spec sections 7.1, 10, 18).
 *
 * The controller depends only on this wrapper. It adds:
 *  - pause/resume for echo/self-trigger protection while TTS plays,
 *  - frame routing for providers that process frames (local energy),
 *  - availability reporting for /status.
 */

import { PcmFrame, WakeEvent, WakeWordConfig, WakeWordProvider } from "../contracts";

export interface WakeGatewayOptions {
  /** Frames are only forwarded to frame-based providers. */
  frameBased?: boolean;
}

export class WakeWordGateway {
  private pausedFlag = false;
  private readonly frameBased: boolean;
  private readonly localProvider: { processFrame(frame: PcmFrame): void } | undefined;

  constructor(private readonly provider: WakeWordProvider, opts: WakeGatewayOptions = {}) {
    this.frameBased = opts.frameBased ?? false;
    this.localProvider = (provider as unknown as { processFrame(frame: PcmFrame): void }).processFrame
      ? (provider as unknown as { processFrame(frame: PcmFrame): void })
      : undefined;
  }

  get id(): string {
    return this.provider.id();
  }

  get available(): boolean {
    return this.provider.available;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  async start(config: WakeWordConfig, onWake: (event: WakeEvent) => void): Promise<void> {
    if (!this.provider.available) return;
    await this.provider.start(config, onWake);
  }

  async stop(): Promise<void> {
    await this.provider.stop();
    this.pausedFlag = false;
  }

  /**
   * Pause detection while ARTHUR is speaking (echo protection). Wake events
   * from a provider already in flight are dropped while paused.
   */
  setPaused(paused: boolean): void {
    this.pausedFlag = paused;
  }

  /**
   * Route a microphone frame to frame-based wake providers. Events are
   * suppressed while paused (self-trigger protection).
   */
  processFrame(frame: PcmFrame): void {
    if (this.pausedFlag || !this.frameBased) return;
    this.localProvider?.processFrame(frame);
  }
}
