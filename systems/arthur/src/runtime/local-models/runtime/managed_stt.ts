/**
 * HR-02.5E2-B: managed Parakeet STT provider (E1 runtime, HR-02 interface).
 *
 * Thin lifecycle adapter over the proven `ParakeetSttProvider`: the
 * worker COMMAND comes from the resolved `LocalRuntimeTarget` (managed
 * python + promoted worker + model/device/cache env) instead of operator
 * configuration. All protocol behavior — persistent worker, ID
 * correlation, bounded startup/request/shutdown, crash semantics — is
 * the existing hardened implementation; nothing is reimplemented here.
 *
 * Lifecycle: lazy-start on first request, `healthy` reflects worker
 * liveness, bounded per-request respawn after a crash via the inner
 * provider (never infinite retries), never duplicate delivery.
 * No shell, argv only.
 */

import type { PcmFrame, SttEvent, SttOptions, SttProvider } from '../../../voice/contracts';
import { ParakeetSttProvider, PARAKEET_TIMEOUT_MS } from '../../../voice/stt/parakeet_provider';
import type { LocalRuntimeTarget } from './resolution';

export interface ManagedSttOptions {
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

export class ManagedParakeetSttProvider implements SttProvider {
  private readonly inner: ParakeetSttProvider;
  private readonly target: LocalRuntimeTarget;

  constructor(target: LocalRuntimeTarget, opts: ManagedSttOptions = {}) {
    if (target.target !== 'stt-parakeet') {
      throw new Error('managed parakeet provider needs an stt-parakeet target');
    }
    this.target = target;
    this.inner = new ParakeetSttProvider({
      command: [target.pythonExecutable, target.entrypoint],
      model: target.extraEnv['PARAKEET_MODEL'] ?? 'nvidia/parakeet-tdt-0.6b-v3',
      env: { ...target.extraEnv, ...target.modelEnv },
      requestTimeoutMs: opts.requestTimeoutMs ?? PARAKEET_TIMEOUT_MS,
    });
  }

  id(): string {
    return this.inner.id();
  }

  get available(): boolean {
    return this.inner.available;
  }

  /** Worker liveness for router/health checks (no side effects). */
  get healthy(): boolean {
    return !this.inner.workerExited && this.inner.available;
  }

  describe(): LocalRuntimeTarget {
    return this.target;
  }

  async *transcribeStream(input: AsyncIterable<PcmFrame>, options: SttOptions): AsyncIterable<SttEvent> {
    yield* this.inner.transcribeStream(input, options);
  }

  async cancel(utteranceId: string): Promise<void> {
    await this.inner.cancel(utteranceId);
  }

  /** Bounded shutdown of the managed worker. */
  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }

  // Crash recovery is the inner provider's bounded per-request respawn
  // (ensureWorker re-spawns a dead worker on the next request; a failed
  // respawn surfaces local_worker_unavailable, never a retry loop).
}
