/**
 * HR-01 TtsRouter seam.
 *
 * Target flow: VoiceController -> TtsRouter -> TtsProvider.
 *
 * HR-01 behavior: routes to the existing configured TTS provider only
 * (local engine or fake, per voice settings). No cloud/local fallback, no
 * provider switching during an active utterance.
 *
 * TASK-0024 semantics are preserved exactly by the controller (provisional
 * text never spoken, final streamed text spoken once, fallback display
 * text spoken once, barge-in cancels active speech, interrupted turns emit
 * no stale speech). This router only delegates speak/cancel/completion.
 */

import type { AudioChunk, TtsProvider, TtsRequest } from "../voice/contracts";
import type { RuntimeMode } from "./runtime_mode";
import type { RuntimeCapabilitySet, RuntimeProviderIdentity } from "./provider";
import { providerStatus, type ProviderStatus } from "./provider_status";
import { configuredDefaultDecision, type RoutingDecision } from "./routing";

export interface TtsRouterDeps {
  /** The existing configured TTS backend (local engine or fake). */
  provider: TtsProvider;
  /**
   * Actual execution locality of the wrapped TTS backend (trusted
   * construction metadata — never inferred from ids or probed). Both the
   * local engine and the in-process fake execute on-device: "local".
   */
  locality: RuntimeMode;
}

export class TtsRouter implements TtsProvider {
  private readonly provider: TtsProvider;
  private readonly locality: RuntimeMode;
  private readonly decision: RoutingDecision;

  constructor(deps: TtsRouterDeps) {
    this.provider = deps.provider;
    this.locality = deps.locality;
    this.decision = configuredDefaultDecision(deps.provider.id(), deps.locality);
  }

  /** Explicit, testable routing decision (HR-01: always configured_default). */
  routingDecision(): RoutingDecision {
    return { ...this.decision };
  }

  identity(): RuntimeProviderIdentity {
    return { id: this.provider.id(), kind: "tts", runtime_mode: this.locality };
  }

  runtimeCapabilities(): RuntimeCapabilitySet {
    return ["speech.synthesize"];
  }

  status(): ProviderStatus {
    return providerStatus(
      this.provider.id(),
      "tts",
      this.locality,
      this.provider.available ? "ready" : "unavailable",
      this.provider.available ? "configured_default" : "engine_unavailable",
    );
  }

  id(): string {
    return this.provider.id();
  }

  get available(): boolean {
    return this.provider.available;
  }

  synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    // Single provider per synthesis: never switch mid-utterance.
    return this.provider.synthesizeStream(request);
  }

  async cancel(synthesisId: string): Promise<void> {
    await this.provider.cancel(synthesisId);
  }
}
