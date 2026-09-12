/**
 * HR-01 SttRouter seam.
 *
 * Target flow: VoiceController -> SttRouter -> SttProvider.
 *
 * HR-01 behavior: routes to the existing configured STT provider only
 * (local engine or fake, per voice settings). No cloud/local switching yet.
 * The routing decision is explicit and testable instead of hardcoded
 * throughout VoiceController.
 *
 * Turn ownership: the router resolves once per utterance; partials from
 * different providers must never be concatenated (see routing.ts). HR-01
 * performs no failover, so the wrapped provider owns the whole utterance.
 *
 * Provider-neutral final result: only the committed final transcript may
 * enter ConversationLoopRunner (the controller already enforces this; the
 * normalized SttResult helper below re-states it for future callers).
 */

import type { PcmFrame, SttEvent, SttOptions, SttProvider } from "../voice/contracts";
import type { RuntimeMode } from "./runtime_mode";
import type { RuntimeCapabilitySet, RuntimeProviderIdentity } from "./provider";
import { providerStatus, type ProviderStatus } from "./provider_status";
import { configuredDefaultDecision, type RoutingDecision } from "./routing";

/** Provider-neutral normalized final STT result. */
export interface SttResult {
  text: string;
  provider: string;
  language?: string;
  confidence?: number;
  latency_ms: number;
}

export interface SttRouterDeps {
  /** The existing configured STT backend (local engine or fake). */
  provider: SttProvider;
  /**
   * Actual execution locality of the wrapped STT backend (trusted
   * construction metadata — never inferred from ids or probed). Both the
   * local engine and the in-process fake execute on-device: "local".
   */
  locality: RuntimeMode;
}

export class SttRouter implements SttProvider {
  private readonly provider: SttProvider;
  private readonly locality: RuntimeMode;
  private readonly decision: RoutingDecision;

  constructor(deps: SttRouterDeps) {
    this.provider = deps.provider;
    this.locality = deps.locality;
    this.decision = configuredDefaultDecision(deps.provider.id(), deps.locality);
  }

  /** Explicit, testable routing decision (HR-01: always configured_default). */
  routingDecision(): RoutingDecision {
    return { ...this.decision };
  }

  identity(): RuntimeProviderIdentity {
    return { id: this.provider.id(), kind: "stt", runtime_mode: this.locality };
  }

  runtimeCapabilities(): RuntimeCapabilitySet {
    return ["speech.transcribe"];
  }

  status(): ProviderStatus {
    return providerStatus(
      this.provider.id(),
      "stt",
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

  transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    // Single provider per utterance: no cross-provider partial stitching.
    return this.provider.transcribeStream(input, options);
  }

  async cancel(utteranceId: string): Promise<void> {
    await this.provider.cancel(utteranceId);
  }

  /**
   * Normalized final-transcript helper: drains the provider stream and
   * returns only the committed final result (partials observed internally
   * and discarded). Preserves cancellation semantics of the underlying
   * provider.
   */
  async transcribeFinal(input: AsyncIterable<PcmFrame>, options: SttOptions): Promise<SttResult> {
    const startedAt = Date.now();
    for await (const event of this.transcribeStream(input, options)) {
      if (event.type === "final") {
        return {
          text: event.text,
          provider: this.provider.id(),
          language: event.language,
          confidence: event.confidence,
          latency_ms: Date.now() - startedAt,
        };
      }
      if (event.type === "error") {
        throw new Error(`STT provider failed: ${event.code}`);
      }
      // partial: provider-specific observability only, never final truth.
    }
    throw new Error("STT provider produced no final transcript");
  }
}
