import { createHarnessEventId, nowIsoTimestamp } from '@qa/shared';
import type { HarnessEvent } from '@qa/schemas';
export class PhaseDeadlineReached extends Error {
  readonly code = 'QA_PHASE_DEADLINE';
  constructor(phase = 'Investigation') {
    super(
      phase === 'Investigation'
        ? 'Investigation stopped to preserve the reporting budget.'
        : 'Reporting attempt reached its protected deadline before a complete report was returned.',
    );
  }
}
/** Fixed reporting window protected at the safety fuse. It is deliberately
 *  NOT a fraction of the remaining budget: a larger fuse must give the
 *  investigation more peace, not a proportionally larger reporting slice. */
export const REPORTING_RESERVE_MS = 300_000;

export function investigationDeadline(deadlineAt: number, now = Date.now()): number {
  const remaining = Math.max(0, deadlineAt - now);
  // Tiny synthetic budgets keep a proportional reserve so short fixtures
  // still retain a usable reporting window.
  const reserve = Math.min(REPORTING_RESERVE_MS, Math.floor(remaining / 3));
  return deadlineAt - reserve;
}

/** A deadline stops OWNED work before reporting; it never extends the run. */
export async function* limitPhase<T>(
  source: AsyncGenerator<HarnessEvent, T>,
  deadlineAt: number,
  stop: () => Promise<void>,
  phase = 'Investigation',
): AsyncGenerator<HarnessEvent, T> {
  if (deadlineAt <= Date.now()) {
    await stop();
    await source.return(undefined as T);
    throw new PhaseDeadlineReached(phase);
  }
  const open = new Map<string, Extract<HarnessEvent, { type: 'tool.started' }>>();
  let expired = false,
    finished = false;
  let stopped: Promise<void> | undefined;
  const stopOnce = () => (stopped ??= Promise.resolve().then(stop));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        expired = true;
        reject(new PhaseDeadlineReached(phase));
      },
      Math.max(1, deadlineAt - Date.now()),
    );
  });
  // A completed source may never race the timer; keep rejection observed.
  void timeout.catch(() => undefined);
  try {
    while (true) {
      const next = await Promise.race([source.next(), timeout]);
      if (next.done) {
        finished = true;
        return next.value;
      }
      if (next.value.type === 'tool.started') open.set(next.value.operationId, next.value);
      if (next.value.type === 'tool.completed') open.delete(next.value.operationId);
      yield next.value;
    }
  } catch (cause) {
    if (!expired) {
      finished = true;
      throw cause;
    }
    await stopOnce(); // Failed shutdown must not authorize a new conversation.
    await source.return(undefined as T).catch(() => undefined);
    finished = true;
    for (const started of open.values())
      yield {
        ...started,
        eventId: createHarnessEventId(),
        timestamp: nowIsoTimestamp(),
        type: 'tool.completed',
        tool: {
          name: started.tool.name,
          errorPreview: 'Phase interrupted before the tool outcome was observed.',
        },
      };
    throw new PhaseDeadlineReached(phase);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!finished) {
      await stopOnce();
      await source.return(undefined as T).catch(() => undefined);
    }
  }
}

export function reportAttemptDeadline(
  deadlineAt: number,
  attempt: number,
  now = Date.now(),
): number {
  const remaining = Math.max(0, deadlineAt - now);
  const cleanup = Math.min(30000, remaining / 10);
  return now + Math.max(0, Math.floor((remaining - cleanup) / Math.max(1, 3 - attempt)));
}
export async function* promisePhase<T>(work: () => Promise<T>): AsyncGenerator<HarnessEvent, T> {
  yield* [];
  return await work();
}

/** Only already-redacted public tool output, never model reasoning or peers. */
export class ObservedToolNotes {
  private values: string[] = [];
  private chars = 0;
  private truncated = false;
  add(event: HarnessEvent): void {
    if (event.type !== 'agent.message' || !/^(tool |observed tool )/.test(event.message)) return;
    const value = event.message.slice(-80000);
    if (value.length < event.message.length) this.truncated = true;
    this.values.push(value);
    this.chars += value.length;
    while (this.chars > 80000 && this.values.length > 1) {
      this.chars -= this.values.shift()!.length;
      this.truncated = true;
    }
  }
  render(): string {
    return JSON.stringify({ truncated: this.truncated, outputs: this.values });
  }
}

/** Adapt callback-based provider observations to the existing event stream. */
export async function* streamObservedWork<T>(
  work: (emit: (event: HarnessEvent) => void) => Promise<T>,
  stop: () => Promise<void>,
): AsyncGenerator<HarnessEvent, T> {
  const queue: HarnessEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false,
    failed = false;
  let result: T | undefined, cause: unknown;
  const signal = () => {
    wake?.();
    wake = undefined;
  };
  void work((event) => {
    queue.push(event);
    signal();
  }).then(
    (value) => {
      result = value;
      done = true;
      signal();
    },
    (error) => {
      cause = error;
      failed = true;
      done = true;
      signal();
    },
  );
  try {
    while (!done || queue.length) {
      const event = queue.shift();
      if (event) yield event;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (failed) throw cause;
    return result as T;
  } finally {
    if (!done) await stop();
  }
}
