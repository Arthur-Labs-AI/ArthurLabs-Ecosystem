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

export type WatchedTurn<T, S> =
  { readonly stopped: false; readonly value: T } | { readonly stopped: true; readonly reason: S };

/** Events of one tool batch arrive together; this is the silence that ends it. */
const BATCH_SETTLE_MS = 150;
const BATCH_DRAIN_LIMIT = 50;

/**
 * Stops OWNED work early on a behavioural signal instead of a clock. After
 * each event `probe` inspects the host ledger; once it reports a reason the
 * current tool batch is drained (so the ledger and command events stay
 * complete), a following tool.started is withheld, and the turn is stopped.
 * A source that finishes by itself is returned as a normal completion.
 */
export async function* watchTurn<T, S>(
  source: AsyncGenerator<HarnessEvent, T>,
  probe: () => S | undefined,
  stop: () => Promise<void>,
): AsyncGenerator<HarnessEvent, WatchedTurn<T, S>> {
  let pending: Promise<IteratorResult<HarnessEvent, T>> | undefined;
  const take = (): Promise<IteratorResult<HarnessEvent, T>> => {
    const next = (pending ??= source.next());
    pending = undefined;
    return next;
  };
  let finished = false;
  try {
    while (true) {
      const next = await take();
      if (next.done) {
        finished = true;
        return { stopped: false, value: next.value };
      }
      yield next.value;
      const reason = probe();
      if (reason === undefined) continue;
      for (let drained = 0; drained < BATCH_DRAIN_LIMIT; drained += 1) {
        const waiting = (pending ??= source.next());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          waiting,
          new Promise<'quiet'>((resolve) => {
            timer = setTimeout(() => resolve('quiet'), BATCH_SETTLE_MS);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (settled === 'quiet') break;
        pending = undefined;
        if (settled.done) {
          finished = true;
          return { stopped: false, value: settled.value };
        }
        if (settled.value.type === 'tool.started') break;
        yield settled.value;
      }
      void pending?.catch(() => undefined);
      await stop();
      await source.return(undefined as T).catch(() => undefined);
      finished = true;
      return { stopped: true, reason };
    }
  } finally {
    if (!finished) {
      await stop();
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

type NoteKind = 'read' | 'write' | 'command';
interface ToolNote {
  readonly text: string;
  readonly kind: NoteKind;
  /** A failing or erroring command: the evidence a review needs most. */
  readonly important: boolean;
}

const READ_TOOLS = /^(?:read|grep|glob|search|list|view|webfetch|websearch|todowrite|todoread)$/i;
const WRITE_TOOLS =
  /^(?:write|edit|patch|apply_patch|write_file|edit_file|create_file|str_replace\w*)$/i;
const FAILURE_SIGNAL =
  /exit code [1-9]|\b(?:FAIL(?:ED)?|AssertionError|Traceback|panic|ERR_[A-Z_]+|ELIFECYCLE)\b|Error:|✗|×/;
const NOTES_BUDGET_CHARS = 120_000;
const READ_NOTE_CHARS = 260;

/**
 * Only already-redacted public tool output, never model reasoning or peers.
 *
 * Kept as a digest, not a rolling tail: a long run reads hundreds of files,
 * and a flat "last N characters" buffer let those reads push out the
 * command output that carried the evidence. Under budget pressure reads go
 * first, then passing commands (their exit codes stay in the receipt), then
 * written probe sources (the reproduction), and failing commands last.
 */
export class ObservedToolNotes {
  private notes: ToolNote[] = [];
  private chars = 0;
  private truncated = false;

  add(event: HarnessEvent): void {
    if (event.type !== 'agent.message' || !/^(tool |observed tool )/.test(event.message)) return;
    const name = /^(?:observed )?tool\s+([A-Za-z_]+)/.exec(event.message)?.[1] ?? '';
    const kind: NoteKind = READ_TOOLS.test(name)
      ? 'read'
      : WRITE_TOOLS.test(name)
        ? 'write'
        : 'command';
    const limit = kind === 'read' ? READ_NOTE_CHARS : 4000;
    const text = event.message.length > limit ? event.message.slice(0, limit) : event.message;
    if (text.length < event.message.length) this.truncated = true;
    this.notes.push({ text, kind, important: kind === 'command' && FAILURE_SIGNAL.test(text) });
    this.chars += text.length;
    this.evict();
  }

  private evict(): void {
    const ranks: Array<(note: ToolNote) => boolean> = [
      (note) => note.kind === 'read',
      (note) => note.kind === 'command' && !note.important,
      (note) => note.kind === 'write',
      () => true,
    ];
    while (this.chars > NOTES_BUDGET_CHARS && this.notes.length > 1) {
      let removed = false;
      for (const matches of ranks) {
        const index = this.notes.findIndex(matches);
        if (index < 0 || index === this.notes.length - 1) continue;
        this.chars -= this.notes[index]!.text.length;
        this.notes.splice(index, 1);
        removed = true;
        break;
      }
      this.truncated = true;
      if (!removed) break;
    }
  }

  render(): string {
    return JSON.stringify({ truncated: this.truncated, outputs: this.notes.map((n) => n.text) });
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
