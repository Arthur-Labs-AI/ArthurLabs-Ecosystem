/**
 * Local wake provider (Phase 3 spec sections 10, 26).
 *
 * Zero-dependency offline detector based on sustained acoustic energy
 * bursts. DOCUMENTED LIMITATION: this is not a keyword spotter - it detects
 * a loud speech burst, not the literal word "Arthur". The push-to-talk
 * fallback is the robust path when a model-based wake engine (e.g. a
 * keyword-spotting model via the configured engine command) is unavailable.
 * The provider stays behind the WakeWordProvider contract so a real
 * keyword engine can be swapped in without touching core code.
 */

import { frameEnergy, PcmFrame, WakeEvent, WakeWordConfig, WakeWordProvider } from "../contracts";

export class LocalWakeWordProvider implements WakeWordProvider {
  private handler: ((event: WakeEvent) => void) | undefined;
  private active = false;
  private energyRun = 0;
  private readonly requiredBurstFrames: number;
  private readonly minEnergy: number;
  private readonly maxEnergy: number;

  constructor(opts: { requiredBurstFrames?: number; minEnergy?: number; maxEnergy?: number } = {}) {
    this.requiredBurstFrames = opts.requiredBurstFrames ?? 6;
    this.minEnergy = opts.minEnergy ?? 1200;
    this.maxEnergy = opts.maxEnergy ?? 8000;
  }

  id(): string {
    return "local-energy-wake";
  }

  get available(): boolean {
    return true;
  }

  async start(_config: WakeWordConfig, onWake: (event: WakeEvent) => void): Promise<void> {
    this.active = true;
    this.handler = onWake;
    this.energyRun = 0;
  }

  async stop(): Promise<void> {
    this.active = false;
    this.handler = undefined;
    this.energyRun = 0;
  }

  /** Feed a short audio frame (never persisted). */
  processFrame(frame: PcmFrame): void {
    if (!this.active) return;
    const energy = frameEnergy(frame);
    if (energy >= this.minEnergy) {
      this.energyRun += 1;
      if (this.energyRun >= this.requiredBurstFrames) {
        this.energyRun = 0;
        this.handler?.({ kind: "wake_detected", detected_at_ms: frame.timestamp_ms, provider: this.id() });
      }
    } else {
      this.energyRun = Math.max(0, this.energyRun - 1);
    }
  }
}
