/**
 * HR-02.5E2: lazy local voice providers with STABLE lifetime identity.
 *
 * Production composition is synchronous but hardware probing is async.
 * Each leg fixes its provider identity SYNCHRONOUSLY at construction
 * from the persisted state snapshot (`peekSelectedModelId`: override /
 * manual / rank-first-auto with READY lifecycle, catalog + kind
 * checked, hardware NOT checked):
 *
 * - `id()` reports the managed provider id (parakeet-stt /
 *   omnivoice-tts / bgtts-tts) from birth when a READY selection
 *   exists, else the fallback id — and NEVER flips afterwards. Routing
 *   decisions, events, and the executing provider always agree.
 * - `available` reports true when a READY selection exists (the leg is
 *   the configured local provider), so `local_only` first requests can
 *   bootstrap: async hardware/artifact verification happens inside the
 *   first request and fails closed there — never silently substituted.
 * - the first request awaits async verification of THE ADVERTISED model
 *   (compatibility + artifacts + factory build); mismatch or failure
 *   fails that request closed. No fallback substitution behind the
 *   advertised id, no hidden model switching.
 * - when no READY selection exists, the fallback serves exactly as
 *   before (existing behavior bit-for-bit).
 *
 * No routing, no selection, no mutation — delegation with a stable id.
 */

import type { AudioChunk, PcmFrame, SttEvent, SttOptions, SttProvider, TtsProvider, TtsRequest } from '../../../voice/contracts';
import type { LocalModelKind } from '../contracts';
import type { LocalModelStateFile } from '../state_contracts';
import { peekSelectedModelId, providerIdForModel } from './selection_id';

export interface LazyResolve<T> {
  (): Promise<T | null>;
}

export interface StableLegDeps {
  kind: LocalModelKind;
  state: LocalModelStateFile;
  env?: NodeJS.ProcessEnv;
}

function advertisedId(deps: StableLegDeps, fallbackId: string): { modelId: string | null; providerId: string } {
  const modelId = peekSelectedModelId({ kind: deps.kind, state: deps.state, env: deps.env });
  if (!modelId) return { modelId: null, providerId: fallbackId };
  const providerId = providerIdForModel(modelId);
  if (!providerId) return { modelId: null, providerId: fallbackId };
  return { modelId, providerId };
}

async function settle<T>(resolve: LazyResolve<T>, expectedModelId: string | null, getId: (t: T) => string, expectedProviderId: string, fallbackId: string): Promise<{ provider: T | null; matched: boolean }> {
  let provider: T | null = null;
  try {
    provider = await resolve();
  } catch {
    return { provider: null, matched: false };
  }
  if (!provider || expectedModelId === null) return { provider, matched: provider !== null };
  // Strict: the async result must BE the advertised model. Provider
  // ids are stable per model (parakeet-stt/omnivoice-tts/bgtts-tts), so
  // comparing the built provider's id is exact — no catalog re-read.
  if (getId(provider) !== expectedProviderId) return { provider: null, matched: false };
  void fallbackId;
  return { provider, matched: true };
}

export class LazyLocalSttProvider implements SttProvider {
  private readonly resolve: LazyResolve<SttProvider>;
  private readonly fallback: SttProvider;
  private readonly advertisedModelId: string | null;
  private readonly stableId: string;
  private real: SttProvider | null = null;
  private resolving: Promise<SttProvider> | null = null;
  private settled = false;
  private verified = false;

  constructor(resolve: LazyResolve<SttProvider>, fallback: SttProvider, stable?: StableLegDeps) {
    this.resolve = resolve;
    this.fallback = fallback;
    if (stable) {
      const adv = advertisedId(stable, fallback.id());
      this.advertisedModelId = adv.modelId;
      this.stableId = adv.providerId;
    } else {
      this.advertisedModelId = null;
      this.stableId = fallback.id();
    }
  }

  get upgraded(): boolean {
    return this.settled && this.real !== null;
  }

  /** Stable lifetime identity: managed id when READY-selected, else fallback. Never flips. */
  id(): string {
    return this.stableId;
  }

  /** True when a READY selection was advertised (bootstrap-capable) or the fallback is available. */
  get available(): boolean {
    if (this.advertisedModelId !== null) return true;
    return this.fallback.available;
  }

  private ensure(): Promise<SttProvider> {
    if (this.settled) {
      if (this.real) return Promise.resolve(this.real);
      if (this.verified) return Promise.reject(new Error('local STT unavailable: ' + this.stableId + ' failed verification'));
      return Promise.resolve(this.fallback);
    }
    if (this.advertisedModelId === null) {
      // No READY selection was advertised: pure fallback leg. The async
      // resolver is never consulted (no identity to verify, no upgrade
      // that could flip the reported id).
      this.settled = true;
      return Promise.resolve(this.fallback);
    }
    if (!this.resolving) {
      this.resolving = settle(this.resolve, this.advertisedModelId, (p) => p.id(), this.stableId, this.fallback.id()).then(({ provider, matched }) => {
        this.settled = true;
        this.resolving = null;
        if (provider && matched) {
          this.real = provider;
          this.verified = true;
          return provider;
        }
        if (this.advertisedModelId !== null) {
          // Advertised managed identity but verification failed: fail
          // closed (no silent fallback behind the advertised id).
          this.verified = true;
          throw new Error('local STT unavailable: ' + this.stableId + ' failed verification');
        }
        return this.fallback;
      });
    }
    return this.resolving;
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    let provider: SttProvider;
    try {
      provider = await this.ensure();
    } catch {
      yield { type: 'error', code: 'STT_FAILED' };
      return;
    }
    yield* provider.transcribeStream(input, options);
  }

  async cancel(utteranceId: string): Promise<void> {
    await (this.settled && this.real ? this.real : this.fallback).cancel(utteranceId);
  }

  async shutdown(): Promise<void> {
    const real = this.real as (SttProvider & { shutdown?: () => Promise<void> }) | null;
    if (real && typeof real.shutdown === 'function') await real.shutdown();
  }
}

export class LazyLocalTtsProvider implements TtsProvider {
  private readonly resolve: LazyResolve<TtsProvider>;
  private readonly fallback: TtsProvider;
  private readonly advertisedModelId: string | null;
  private readonly stableId: string;
  private real: TtsProvider | null = null;
  private resolving: Promise<TtsProvider> | null = null;
  private settled = false;
  private verified = false;

  constructor(resolve: LazyResolve<TtsProvider>, fallback: TtsProvider, stable?: StableLegDeps) {
    this.resolve = resolve;
    this.fallback = fallback;
    if (stable) {
      const adv = advertisedId(stable, fallback.id());
      this.advertisedModelId = adv.modelId;
      this.stableId = adv.providerId;
    } else {
      this.advertisedModelId = null;
      this.stableId = fallback.id();
    }
  }

  get upgraded(): boolean {
    return this.settled && this.real !== null;
  }

  id(): string {
    return this.stableId;
  }

  get available(): boolean {
    if (this.advertisedModelId !== null) return true;
    return this.fallback.available;
  }

  private ensure(): Promise<TtsProvider> {
    if (this.settled) {
      if (this.real) return Promise.resolve(this.real);
      if (this.verified) return Promise.reject(new Error('local TTS unavailable: ' + this.stableId + ' failed verification'));
      return Promise.resolve(this.fallback);
    }
    if (this.advertisedModelId === null) {
      this.settled = true;
      return Promise.resolve(this.fallback);
    }
    if (!this.resolving) {
      this.resolving = settle(this.resolve, this.advertisedModelId, (p) => p.id(), this.stableId, this.fallback.id()).then(({ provider, matched }) => {
        this.settled = true;
        this.resolving = null;
        if (provider && matched) {
          this.real = provider;
          this.verified = true;
          return provider;
        }
        if (this.advertisedModelId !== null) {
          this.verified = true;
          throw new Error('local TTS unavailable: ' + this.stableId + ' failed verification');
        }
        return this.fallback;
      });
    }
    return this.resolving;
  }

  async *synthesizeStream(request: TtsRequest): AsyncIterable<AudioChunk> {
    let provider: TtsProvider;
    try {
      provider = await this.ensure();
    } catch {
      throw new Error('TTS synthesis failed: ' + this.stableId + ' unavailable');
    }
    yield* provider.synthesizeStream(request);
  }

  async cancel(synthesisId: string): Promise<void> {
    await (this.settled && this.real ? this.real : this.fallback).cancel(synthesisId);
  }

  async shutdown(): Promise<void> {
    const real = this.real as (TtsProvider & { shutdown?: () => Promise<void> }) | null;
    if (real && typeof real.shutdown === 'function') await real.shutdown();
  }
}
