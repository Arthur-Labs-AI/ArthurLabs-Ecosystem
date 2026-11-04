/**
 * VAD gateway (Phase 3 spec section 7.2).
 *
 * Controller depends on this wrapper, never on a specific VAD engine.
 */

import { PcmFrame, VadProvider, VadResult } from "../contracts";

export class VadGateway implements VadProvider {
  constructor(private readonly provider: VadProvider) {}

  id(): string {
    return this.provider.id();
  }

  process(frame: PcmFrame): VadResult {
    return this.provider.process(frame);
  }

  reset(): void {
    this.provider.reset();
  }
}
