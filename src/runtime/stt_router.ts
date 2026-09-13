/**
 * HR-02 SttRouter: deterministic cloud/local voice-plane routing.
 *
 * Target flow: VoiceController -> SttRouter -> (OpenAI cloud | Parakeet local).
 *
 * Policies:
 * - cloud_preferred (production default): cloud when configured + usable;
 *   on cloud failure the SAME complete utterance is re-transcribed locally.
 * - local_only: local backend only; cloud is never called.
 *
 * Complete-utterance ownership (mandatory invariant): the router buffers the
 * complete captured utterance (bounded, memory-only) before trying the
 * cloud. Cloud partials are observed as provider events and discarded on
 * fallback - the same complete audio bytes go to local, producing ONE final
 * transcript. Partial transcripts from different providers are never merged.
 *
 * No network probing: availability = configuration + provider readiness +
 * actual provider/session failure.
 */

import type { PcmFrame, SttEvent, SttOptions, SttProvider } from "../voice/contracts";
import type { RuntimeMode } from "./runtime_mode";
import type { RuntimeCapabilitySet, RuntimeProviderIdentity } from "./provider";
import { providerStatus, type ProviderStatus } from "./provider_status";
import { type RoutingDecision, type RoutingReason } from "./routing";
import { categorizeVoiceError, VoiceProviderError } from "./voice_errors";
import type { SttPolicy } from "./voice_policy";

/** Provider-neutral normalized final STT result. */
export interface SttResult {
  text: string;
  provider: string;
  language?: string;
  confidence?: number;
  latency_ms: number;
}

export interface SttRouterDeps {
  /** Cloud STT backend (openai-stt). Absent = cloud unavailable. */
  cloud?: SttProvider;
  /** Local STT backend (parakeet-stt / local engine / fake). Required. */
  local?: SttProvider;
  /** HR-01 legacy single-provider shape (frozen): treated as the local leg. */
  provider?: SttProvider;
  /** HR-01 legacy locality (frozen): accepted and ignored for routing. */
  locality?: RuntimeMode;
  policy?: SttPolicy;
  /** Complete-utterance buffer bound in bytes (default ~120 s s16le mono). */
  maxUtteranceBytes?: number;
  /** Structured routing-event sink (observability; never audio/transcripts). */
  onEvent?: (event: {
    type: "voice.stt.route_selected" | "voice.stt.fallback" | "voice.stt.completed";
    provider_id: string;
    runtime_mode: RuntimeMode;
    routing_reason: RoutingReason;
    latency_ms?: number;
    fallback_count?: number;
  }) => void;
}

/** Bounded complete-utterance retention (120 s @16 kHz mono s16le). */
export const STT_ROUTER_MAX_UTTERANCE_BYTES = 120 * 16000 * 2;

function framesToBytes(frames: PcmFrame[]): Buffer {
  const parts: Buffer[] = [];
  for (const frame of frames) {
    parts.push(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
  }
  return Buffer.concat(parts);
}

function bytesToFrames(audio: Buffer, startSequence = 0): PcmFrame[] {
  const frameBytes = 320 * 2;
  const out: PcmFrame[] = [];
  let sequence = startSequence;
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    const slice = audio.subarray(offset, offset + frameBytes);
    const data = new Uint8Array(slice.length);
    data.set(slice);
    out.push({
      sequence,
      timestamp_ms: sequence * 20,
      sample_rate_hz: 16000,
      channels: 1,
      sample_format: "s16le",
      duration_ms: Math.round((slice.length / 2 / 16000) * 1000),
      data,
    });
    sequence += 1;
  }
  return out;
}

async function* replayFrames(frames: PcmFrame[]): AsyncIterable<PcmFrame> {
  for (const frame of frames) yield frame;
}

/**
 * Live utterance tee: frames stream to the cloud provider as they arrive
 * while a bounded complete copy is retained for same-utterance local
 * fallback. live() yields frames progressively (never waits for utterance
 * end); replay() re-yields the retained copy after the drain completes.
 * Memory-only, bounded by maxBytes; overflow is latched (no silent trim).
 */
class UtteranceTee {
  private frames: PcmFrame[] = [];
  private waiters: Array<() => void> = [];
  private ended = false;
  private totalBytes = 0;
  private overflowFlag = false;

  constructor(private readonly maxBytes: number) {}

  get overflowed(): boolean {
    return this.overflowFlag;
  }

  push(frame: PcmFrame): void {
    if (this.ended || this.overflowFlag) return;
    this.totalBytes += frame.data.byteLength;
    if (this.totalBytes > this.maxBytes) {
      this.overflowFlag = true;
      this.end();
      return;
    }
    this.frames.push(frame);
    const waiter = this.waiters.shift();
    waiter?.();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter();
      waiter = this.waiters.shift();
    }
  }

  async *live(): AsyncIterable<PcmFrame> {
    let index = 0;
    for (;;) {
      while (index < this.frames.length) {
        yield this.frames[index] as PcmFrame;
        index += 1;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  async *replay(): AsyncIterable<PcmFrame> {
    for (const frame of this.frames) yield frame;
  }
}

export class SttRouter implements SttProvider {
  private readonly cloud: SttProvider | undefined;
  private readonly local: SttProvider;
  private readonly policy: SttPolicy;
  private readonly maxUtteranceBytes: number;
  private readonly onEvent?: SttRouterDeps["onEvent"];
  private readonly cancelled = new Set<string>();
  private readonly lastDecisions = new Map<string, RoutingDecision>();
  private fallbackCount = 0;

  /** HR-01 legacy single-provider construction (frozen contract). */
  private readonly legacyReason: RoutingReason | undefined;
  constructor(deps: SttRouterDeps) {
    const local = deps.local ?? deps.provider;
    if (!local) throw new Error("SttRouter requires a local STT provider");
    this.cloud = deps.cloud;
    this.local = local;
    this.legacyReason = deps.provider && !deps.cloud && !deps.policy ? "configured_default" : undefined;
    this.policy = deps.policy ?? "cloud_preferred";
    this.maxUtteranceBytes = deps.maxUtteranceBytes ?? STT_ROUTER_MAX_UTTERANCE_BYTES;
    this.onEvent = deps.onEvent;
  }

  routingDecision(utteranceId?: string): RoutingDecision {
    if (utteranceId) {
      const decision = this.lastDecisions.get(utteranceId);
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
    return { id: decision.provider_id, kind: "stt", runtime_mode: decision.runtime_mode };
  }

  runtimeCapabilities(): RuntimeCapabilitySet {
    return ["speech.transcribe"];
  }

  status(): ProviderStatus {
    if (this.policy === "local_only") {
      return providerStatus(
        this.local.id(),
        "stt",
        "local",
        this.local.available ? "ready" : "unavailable",
        this.local.available ? "configured_default" : "engine_unavailable",
      );
    }
    if (this.cloud && this.cloud.available) {
      return providerStatus(this.cloud.id(), "stt", "cloud", "ready", "configured_default");
    }
    return providerStatus(
      this.local.id(),
      "stt",
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

  get activePolicy(): SttPolicy {
    return this.policy;
  }

  get fallbacks(): number {
    return this.fallbackCount;
  }

  lastDecisionFor(utteranceId: string): RoutingDecision | undefined {
    const decision = this.lastDecisions.get(utteranceId);
    return decision ? { ...decision } : undefined;
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    const utteranceId = options.utteranceId;
    if (this.cancelled.has(utteranceId)) return;
    const useCloud = this.policy === "cloud_preferred" && this.cloud && this.cloud.available;
    // Single-provider utterances stream LIVE to the owning provider (no
    // buffering delay): frames reach STT during CAPTURING, preserving the
    // controller's streaming contract and realtime cloud partials.
    if (!useCloud) {
      const reason: RoutingReason = this.policy === "local_only" ? "local_only" : "cloud_unavailable";
      this.recordDecision(utteranceId, this.local.id(), "local", reason);
      this.emit({ type: "voice.stt.route_selected", provider_id: this.local.id(), runtime_mode: "local", routing_reason: reason });
      yield* this.runProvider(this.local, input, options);
      return;
    }
    // Cloud path: live-tee. Frames stream to cloud as they arrive while a
    // bounded copy is retained; on cloud failure the SAME complete utterance
    // replays to local (partials never merged across providers).
    const tee = new UtteranceTee(this.maxUtteranceBytes);
    const drain = this.drainIntoTee(input, tee, utteranceId);
    const cloud = this.cloud as SttProvider;
    this.recordDecision(utteranceId, cloud.id(), "cloud", "cloud_preferred");
    this.emit({ type: "voice.stt.route_selected", provider_id: cloud.id(), runtime_mode: "cloud", routing_reason: "cloud_preferred" });
    const startedAt = Date.now();
    let cloudFailed = false;
    let drainFailed = false;
    for await (const event of this.runProvider(cloud, tee.live(), options)) {
      if (this.cancelled.has(utteranceId)) return;
      if (event.type === "error") { cloudFailed = true; break; }
      if (event.type === "final") {
        this.emit({
          type: "voice.stt.completed",
          provider_id: cloud.id(),
          runtime_mode: "cloud",
          routing_reason: "cloud_preferred",
          latency_ms: Date.now() - startedAt,
          fallback_count: this.fallbackCount,
        });
        yield event;
        return;
      }
      yield event;
    }
    if (this.cancelled.has(utteranceId)) return;
    if (!cloudFailed) cloudFailed = true;
    if (!this.local.available) {
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    try { await cloud.cancel(utteranceId).catch(() => undefined); } catch { /* best effort */ }
    this.fallbackCount += 1;
    this.recordDecision(utteranceId, this.local.id(), "local", "cloud_failed");
    this.emit({
      type: "voice.stt.fallback",
      provider_id: this.local.id(),
      runtime_mode: "local",
      routing_reason: "cloud_failed",
      latency_ms: Date.now() - startedAt,
      fallback_count: this.fallbackCount,
    });
    drainFailed = await drain;
    if (tee.overflowed || drainFailed) {
      yield { type: "error", code: "STT_FAILED" };
      return;
    }
    let gotFinal = false;
    for await (const event of this.runProvider(this.local, tee.replay(), options)) {
      if (this.cancelled.has(utteranceId)) return;
      if (event.type === "error") { yield { type: "error", code: "STT_FAILED" }; return; }
      if (event.type === "final") {
        gotFinal = true;
        this.emit({
          type: "voice.stt.completed",
          provider_id: this.local.id(),
          runtime_mode: "local",
          routing_reason: "cloud_failed",
          latency_ms: Date.now() - startedAt,
          fallback_count: this.fallbackCount,
        });
        yield event;
        return;
      }
      yield event;
    }
    if (!gotFinal) {
      yield { type: "error", code: "STT_FAILED" };
    }
  }

  /** Background drain: retain live input into the tee (bounded, memory-only). */
  private async drainIntoTee(
    input: AsyncIterable<PcmFrame>,
    tee: UtteranceTee,
    utteranceId: string,
  ): Promise<boolean> {
    try {
      for await (const frame of input) {
        if (this.cancelled.has(utteranceId)) break;
        tee.push(frame);
        if (tee.overflowed) break;
      }
      return false;
    } catch {
      return true;
    } finally {
      tee.end();
    }
  }

  private async *runProvider(
    provider: SttProvider,
    input: AsyncIterable<PcmFrame>,
    options: SttOptions,
  ): AsyncIterable<SttEvent> {
    try {
      yield* provider.transcribeStream(input, options);
    } catch (err) {
      const category = err instanceof VoiceProviderError ? err.category : categorizeVoiceError(err);
      void category;
      yield { type: "error", code: "STT_FAILED" };
    }
  }

  async cancel(utteranceId: string): Promise<void> {
    this.cancelled.add(utteranceId);
    const pending: Array<Promise<void>> = [];
    if (this.cloud) pending.push(this.cloud.cancel(utteranceId).catch(() => undefined));
    pending.push(this.local.cancel(utteranceId).catch(() => undefined));
    await Promise.all(pending);
  }

  async transcribeFinal(input: AsyncIterable<PcmFrame>, options: SttOptions): Promise<SttResult> {
    const startedAt = Date.now();
    for await (const event of this.transcribeStream(input, options)) {
      if (event.type === "final") {
        const decision = this.lastDecisionFor(options.utteranceId);
        return {
          text: event.text,
          provider: decision?.provider_id ?? this.local.id(),
          language: event.language,
          confidence: event.confidence,
          latency_ms: Date.now() - startedAt,
        };
      }
      if (event.type === "error") {
        throw new Error("STT provider failed: " + event.code);
      }
    }
    throw new Error("STT provider produced no final transcript");
  }

  private recordDecision(utteranceId: string, provider_id: string, runtime_mode: RuntimeMode, reason: RoutingReason): void {
    this.lastDecisions.set(utteranceId, { provider_id, runtime_mode, reason });
    if (this.lastDecisions.size > 128) {
      const oldest = this.lastDecisions.keys().next().value as string | undefined;
      if (oldest) this.lastDecisions.delete(oldest);
    }
  }

  private emit(event: {
    type: "voice.stt.route_selected" | "voice.stt.fallback" | "voice.stt.completed";
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

/** Test helper: PCM bytes -> replayable PcmFrame stream (same utterance twice). */
export function utteranceFramesForTest(audio: Buffer, startSequence = 0): { frames: PcmFrame[]; stream(): AsyncIterable<PcmFrame> } {
  const frames = bytesToFrames(audio, startSequence);
  return {
    frames,
    stream(): AsyncIterable<PcmFrame> {
      return replayFrames(frames);
    },
  };
}

export { bytesToFrames, framesToBytes };
