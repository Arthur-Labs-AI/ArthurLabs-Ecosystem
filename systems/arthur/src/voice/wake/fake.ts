/**
 * Deterministic wake word provider for tests (Phase 3 spec section 7.1).
 * Triggered explicitly via triggerWake(); never touches real audio.
 */

import { WakeEvent, WakeWordConfig, WakeWordProvider } from "../contracts";

export class FakeWakeWordProvider implements WakeWordProvider {
  private handler: ((event: WakeEvent) => void) | undefined;
  private startedFlag = false;
  startCount = 0;
  stopCount = 0;
  readonly detections: WakeEvent[] = [];
  private readonly providerId: string;

  constructor(opts: { id?: string } = {}) {
    this.providerId = opts.id ?? "fake-wake";
  }

  id(): string {
    return this.providerId;
  }

  get available(): boolean {
    return true;
  }

  get started(): boolean {
    return this.startedFlag;
  }

  async start(_config: WakeWordConfig, onWake: (event: WakeEvent) => void): Promise<void> {
    this.startedFlag = true;
    this.handler = onWake;
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.startedFlag = false;
    this.handler = undefined;
    this.stopCount += 1;
  }

  /** Test helper: fire a wake detection exactly as the engine would. */
  triggerWake(atMs = Date.now()): void {
    const event: WakeEvent = { kind: "wake_detected", detected_at_ms: atMs, provider: this.providerId };
    this.detections.push(event);
    this.handler?.(event);
  }
}
