/**
 * HR-02 TtsRouter: deterministic cloud/local speech routing.
 *
 * Target flow: VoiceController -> TtsRouter -> (OpenAI cloud | local engine).
 *
 * Policies:
 * - cloud_preferred (production default): cloud speech when configured +
 *   usable; on pre-playback cloud failure the SAME canonical text is
 *   synthesized locally, exactly once.
 * - local_only: local backend only; cloud is never called.
 *
 * TTS fallback boundary (mandatory): automatic local fallback is allowed
 * ONLY when cloud output has not begun usable playback. Once playback
 * begins, provider ownership stays with that provider for the utterance:
 * no cross-provider audio stitching, no restart of the response.
 *
 * TASK-0024 preserved: the router only renders canonical final text handed
 * to it (provisional text never reaches TTS — enforced by the controller).
 */

import type { AudioChunk, TtsProvider, TtsRequest } from "../voice/contracts";
import type { RuntimeMode } from "./runtime_mode";
import type { RuntimeCapabilitySet, RuntimeProviderIdentity } from "./provider";
import { providerStatus, type ProviderStatus } from "./provider_status";
import { type RoutingDecision, type RoutingReason } from "./routing";
import { VoiceProviderError } from "./voice_errors";
import type { TtsPolicy } from "./voice_policy";

export interface TtsRouterDeps {
  /** Cloud TTS backend (openai-tts). Absent = cloud unavailable. */
  cloud?: TtsProvider;
  /** Local TTS backend (existing local engine / fake). Required. */
  local?: TtsProvider;
  provider?: TtsProvider;
  locality?: RuntimeMode;
  policy?: TtsPolicy;
  onEvent?: (event: {
    type: "voice.tts.route_selected" | "voice.tts.fallback" | "voice.tts.started" | "voice.tts.completed";
    provider_id: string;
    runtime_mode: RuntimeMode;
    routing_reason: RoutingReason;
    latency_ms?: number;
    fallback_count?: number;
  }) => void;
}

/** Minimal playback-began signal (OpenAiTtsProvider exposes hasPlaybackBegan). */
export interface PlaybackAwareTtsProvider extends TtsProvider {
  hasPlaybackBegan?(synthesisId: string): boolean;
}

export class TtsRouter implements TtsProvider {
  private readonly cloud: TtsProvider | undefined;
  private readonly local: TtsProvider;
  private readonly policy: TtsPolicy;
  private readonly onEvent?: TtsRouterDeps["onEvent"];
  private readonly lastDecisions = new Map<string, RoutingDecision>();
  private fallbackCount = 0;

  /** HR-01 legacy single-provider construction (frozen contract). */
  private readonly legacyReason: RoutingReason | undefined;
  constructor(deps: TtsRouterDeps) {
    const local = deps.local ?? deps.provider;
    if (!local) throw new Error("TtsRouter requires a local TTS provider");
    this.cloud = deps.cloud;
    this.local = local;
    this.legacyReason = deps.provider && !deps.cloud && !deps.policy ? "configured_default" : undefined;
    this.policy = deps.policy ?? "cloud_preferred";
    this.onEvent = deps.onEvent;
  }

  routingDecision(synthesisId?: string): RoutingDecision {
    if (synthesisId) {
      const decision = this.lastDecisions.get(synthesisId);
      if (decision) return { ...decision };
    }
    if (this.legacyReason) {
      return { provider_id: this.local.id(), runtime_mode: "local", reason: this.legacyReason };
    }
    if (this.policy === "local_only" || !this.cloud || !this.cloud.available) {
      return {
        provider_id: this.local.id(),
        runtime_mode: "local",
        reason: this.policy === "local_only" ? "local_only" : "cloud_unavailable",
      };
    }
    return { provider_id: this.cloud.id(), runtime_mode: "cloud", reason: "cloud_preferred" };
  }

  identity(): RuntimeProviderIdentity {
    const decision = this.routingDecision();
    return { id: decision.provider_id, kind: "tts", runtime_mode: decision.runtime_mode };
  }

  runtimeCapabilities(): RuntimeCapabilitySet {
    return ["speech.synthesize"];
  }

  status(): ProviderStatus {
    if (this.policy === "local_only") {
      return providerStatus(
        this.local.id(),
        "tts",
        "local",
        this.local.available ? "ready" : "unavailable",
        this.local.available ? "configured_default" : "engine_unavailable",
      );
    }
    if (this.cloud && this.cloud.available) {
      return providerStatus(this.cloud.id(), "tts", "cloud", "ready", "configured_default");
    }
    return providerStatus(
      this.local.id(),
      "tts",
      "local",
      this.local.available ? "ready" : "unavailable",
      this.local.available ? "configured_default" : "engine_unavailable",
    );
  }

  id(): string {
    return this.routingDecision().provider_id;
  }

  get available(): boolean {
    if (this.policy === "local_only") return this.local.available;
    return (this.cloud?.available ?? false) || this.local.available;
  }

  get activePolicy(): TtsPolicy {
    return this.policy;
  }

  get fallbacks(): number {
    return this.fallbackCount;
  }

  lastDecisionFor(synthesisId: string): RoutingDecision | undefined {
    const decision = this.lastDecisions.get(synthesisId);
    return decision ? { ...decision } : undefined;
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    const synthesisId = request.synthesisId;
    const useCloud = this.policy === "cloud_preferred" && this.cloud && this.cloud.available;
    if (!useCloud) {
      const reason: RoutingReason = this.policy === "local_only" ? "local_only" : "cloud_unavailable";
      this.recordDecision(synthesisId, this.local.id(), "local", reason);
      this.emit({ type: "voice.tts.route_selected", provider_id: this.local.id(), runtime_mode: "local", routing_reason: reason });
      const startedAt = Date.now();
      let started = false;
      for await (const chunk of this.local.synthesizeStream(request)) {
        if (!started) {
          started = true;
          this.emit({ type: "voice.tts.started", provider_id: this.local.id(), runtime_mode: "local", routing_reason: reason });
        }
        yield chunk;
      }
      this.emit({ type: "voice.tts.completed", provider_id: this.local.id(), runtime_mode: "local", routing_reason: reason, latency_ms: Date.now() - startedAt });
      return;
    }
    const cloud = this.cloud as PlaybackAwareTtsProvider;
    this.recordDecision(synthesisId, cloud.id(), "cloud", "cloud_preferred");
    this.emit({ type: "voice.tts.route_selected", provider_id: cloud.id(), runtime_mode: "cloud", routing_reason: "cloud_preferred" });
    const startedAt = Date.now();
    let yieldedAny = false;
    try {
      for await (const chunk of cloud.synthesizeStream(request)) {
        if (!yieldedAny) {
          yieldedAny = true;
          this.emit({ type: "voice.tts.started", provider_id: cloud.id(), runtime_mode: "cloud", routing_reason: "cloud_preferred" });
        }
        yield chunk;
      }
      this.emit({ type: "voice.tts.completed", provider_id: cloud.id(), runtime_mode: "cloud", routing_reason: "cloud_preferred", latency_ms: Date.now() - startedAt });
      return;
    } catch (err) {
      void (err instanceof VoiceProviderError ? err : undefined);
      const began = yieldedAny || (typeof cloud.hasPlaybackBegan === "function" && cloud.hasPlaybackBegan(synthesisId));
      if (began) {
        // Playback began: ownership stays with cloud for this utterance.
        // No restart via local (no cross-provider stitching). Surface the
        // failure so the controller ends speech without stale replay.
        throw err;
      }
      // Pre-playback failure: SAME canonical text -> local, exactly once.
      if (!this.local.available) throw err;
      try { await cloud.cancel(synthesisId).catch(() => undefined); } catch { /* best effort */ }
      this.fallbackCount += 1;
      this.recordDecision(synthesisId, this.local.id(), "local", "local_fallback");
      this.emit({
        type: "voice.tts.fallback",
        provider_id: this.local.id(),
        runtime_mode: "local",
        routing_reason: "local_fallback",
        latency_ms: Date.now() - startedAt,
        fallback_count: this.fallbackCount,
      });
      this.emit({ type: "voice.tts.started", provider_id: this.local.id(), runtime_mode: "local", routing_reason: "local_fallback" });
      for await (const chunk of this.local.synthesizeStream(request)) {
        yield chunk;
      }
      this.emit({ type: "voice.tts.completed", provider_id: this.local.id(), runtime_mode: "local", routing_reason: "local_fallback", latency_ms: Date.now() - startedAt });
      return;
    }
  }

  async cancel(synthesisId: string): Promise<void> {
    const pending: Array<Promise<void>> = [];
    if (this.cloud) pending.push(this.cloud.cancel(synthesisId).catch(() => undefined));
    pending.push(this.local.cancel(synthesisId).catch(() => undefined));
    await Promise.all(pending);
  }

  private recordDecision(synthesisId: string, provider_id: string, runtime_mode: RuntimeMode, reason: RoutingReason): void {
    this.lastDecisions.set(synthesisId, { provider_id, runtime_mode, reason });
    if (this.lastDecisions.size > 128) {
      const oldest = this.lastDecisions.keys().next().value as string | undefined;
      if (oldest) this.lastDecisions.delete(oldest);
    }
  }

  private emit(event: {
    type: "voice.tts.route_selected" | "voice.tts.fallback" | "voice.tts.started" | "voice.tts.completed";
    provider_id: string;
    runtime_mode: RuntimeMode;
    routing_reason: RoutingReason;
    latency_ms?: number;
    fallback_count?: number;
  }): void {
    try {
      this.onEvent?.(event);
    } catch { /* observability must never break routing */ }
  }
}
