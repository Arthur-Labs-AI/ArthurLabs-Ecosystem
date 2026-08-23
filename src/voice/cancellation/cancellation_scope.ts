/**
 * CancellationScope (Phase 3 spec sections 17, 29).
 *
 * One scope per voice turn owns: an AbortSignal for the DeepSeek stream,
 * cancellation of STT/TTS synthesis, audio playback stop, and cancellable
 * read-only tools. Cancellation is idempotent and records the first reason
 * only. It never rolls back already committed irreversible external actions
 * (that decision belongs to the tool/approval layer).
 */

export interface CancellableResource {
  id: string;
  cancel(): void | Promise<void>;
}

const noop = (): void => undefined;

export class CancellationScope {
  private readonly controller = new AbortController();
  private readonly resources = new Map<string, CancellableResource>();
  private cancelReason?: string;
  private cancelledFlag = false;

  /** Signal handed to providers (DeepSeek stream, STT, tools). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  get reason(): string | undefined {
    return this.cancelReason;
  }

  /**
   * Idempotent cancellation: the first reason wins, resources are each
   * cancelled at most once, and the abort signal fires exactly once.
   */
  async cancel(reason: string): Promise<void> {
    if (this.cancelledFlag) {
      // Late repeated cancellation is a safe no-op (spec section 17).
      return;
    }
    this.cancelledFlag = true;
    this.cancelReason = reason;
    try {
      this.controller.abort(new Error(`voice cancelled: ${reason}`));
    } catch {
      // abort() does not throw in practice; never let it break the caller.
    }
    const pending: Array<void | Promise<void>> = [];
    for (const resource of this.resources.values()) {
      try {
        pending.push(resource.cancel());
      } catch {
        // Resource cancellation failures must not block the remaining ones.
      }
    }
    this.resources.clear();
    await Promise.allSettled(pending);
  }

  /** Register a resource; returns an unregister function (idempotent). */
  register(resource: CancellableResource): () => void {
    if (this.cancelledFlag) {
      // Late registrations are cancelled immediately (stale-event guard).
      void Promise.resolve(resource.cancel()).catch(noop);
      return noop;
    }
    this.resources.set(resource.id, resource);
    return () => {
      this.resources.delete(resource.id);
    };
  }

  /** Convenience: register a plain AbortController-backed resource. */
  registerController(id: string, controller: AbortController): () => void {
    return this.register({
      id,
      cancel: () => controller.abort(new Error("voice cancellation")),
    });
  }

  throwIfCancelled(): void {
    if (this.cancelledFlag) {
      throw new Error(`voice turn cancelled: ${this.cancelReason ?? "unknown"}`);
    }
  }
}
