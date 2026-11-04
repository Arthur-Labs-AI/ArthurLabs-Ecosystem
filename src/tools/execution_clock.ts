/**
 * Injectable clock + randomness for the execution lifecycle (SC-03 section 90).
 * Production uses the real clock/random; tests inject deterministic fakes for
 * deadlines, backoff, jitter, and recovery.
 */
export interface ExecutionClock {
  nowMs(): number;
  nowIso(): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * Deprecated compatibility stub (SC-03 section 90): retry jitter NEVER reads
   * this — the coordinator consumes only the injected RetryRandomSource.
   * Retained so existing fakes keep compiling; new code must not call it.
   * @deprecated Use the injected RetryRandomSource instead.
   */
  random01(): number;
}

/**
 * SC-03 section 90 retry randomness boundary. The lifecycle never calls
 * Math.random() directly: production wires DefaultRetryRandomSource (which may
 * use Math.random), deterministic tests inject a scripted source, and the
 * coordinator only ever calls this interface. This makes F19/F33 backoff values
 * exactly reproducible.
 */
export interface RetryRandomSource {
  next01(): number;
}

export class DefaultRetryRandomSource implements RetryRandomSource {
  next01(): number {
    return Math.random();
  }
}

export class ScriptedRetryRandomSource implements RetryRandomSource {
  private cursor = 0;
  constructor(private readonly values: number[] = [0.5]) {}
  next01(): number {
    const v = this.values[this.cursor % this.values.length] as number;
    this.cursor += 1;
    return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 1;
  }
}

/**
 * Production clock wiring. RealExecutionClock delegates randomness to the
 * injected RetryRandomSource in coordinator paths; its own random01() remains
 * only for interface compatibility and must not be used for retry decisions.
 */
export class RealExecutionClock implements ExecutionClock {
  nowMs(): number {
    return Date.now();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("sleep aborted"));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        reject(new Error("sleep aborted"));
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  random01(): number {
    return Math.random();
  }
}

/** Deterministic fake clock for tests: manual time + scripted randomness. */
export class FakeExecutionClock implements ExecutionClock {
  private t: number;
  private values: number[];
  private cursor = 0;

  constructor(startMs = 0, randomValues: number[] = [0.5]) {
    this.t = startMs;
    this.values = randomValues.length > 0 ? [...randomValues] : [0.5];
  }

  nowMs(): number {
    return this.t;
  }
  nowIso(): string {
    return new Date(this.t).toISOString();
  }
  advance(ms: number): void {
    this.t += ms;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  random01(): number {
    const v = this.values[this.cursor % this.values.length] as number;
    this.cursor += 1;
    return v;
  }
}

/**
 * Stable runtime identity: fresh per process startup (SC-03 section 59).
 * Uses crypto randomness (never Math.random): every runtime startup receives a
 * different id, and stale attempts from a dead runtime can never be mistaken
 * for locally active ones after restart.
 */
export function newRuntimeInstanceId(): string {
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return `runtime-${randomUUID()}`;
}
