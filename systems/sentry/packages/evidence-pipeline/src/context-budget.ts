/**
 * Shared context-window budget policy for all three AgentStacks.
 *
 * Source of truth for "how full is this session" is provider-reported
 * usage (the largest single-turn input token count observed in the
 * current session); the host ledger/tool notes are the source of truth
 * for the facts a compacted fresh session is re-seeded with. This module
 * owns only classification and arithmetic — session lifecycle (rotate,
 * dispose, re-seed) stays with each harness adapter, the only component
 * that can own its vendor session.
 */

const CONTEXT_EXCEEDED_PATTERN =
  /CONTEXT_WINDOW_EXCEEDED|context_length_exceeded|maximum context length|context window (?:exceeded|is full|overflow)|prompt is too long|input is too long|too many (?:input )?tokens|exceeds the (?:model's )?context/i;

function errorText(value: unknown): string {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    const cause = (value as { cause?: unknown }).cause;
    return (
      value.name +
      ' ' +
      (typeof code === 'string' ? code + ' ' : '') +
      value.message +
      (cause === undefined || cause === value ? '' : ' ' + errorText(cause))
    );
  }
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const record = value as { code?: unknown; message?: unknown };
    return (
      (typeof record.code === 'string' ? record.code + ' ' : '') +
      (typeof record.message === 'string' ? record.message : '')
    );
  }
  return '';
}

/** True when a provider/harness failure is a context-window overflow. */
export function isContextWindowExceeded(value: unknown): boolean {
  return CONTEXT_EXCEEDED_PATTERN.test(errorText(value));
}

/** Conservative text-size estimate (chars/4), used only for prompts the
 *  host itself is about to send; never presented as provider truth. */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Rotate before the window is actually full: the next turn still needs
 *  room for its own prompt plus a completion. */
export const CONTEXT_ROTATE_RATIO = 0.7;

export class ContextBudget {
  private peakInputTokens = 0;

  constructor(private readonly contextWindowTokens: number) {}

  /** Observe one completed turn. Summed per-turn input usage is an upper
   *  bound on session occupancy, so rotation errs early, never late. */
  observeTurn(usage: { readonly inputTokens?: number | undefined } | undefined): void {
    if (usage?.inputTokens !== undefined && Number.isFinite(usage.inputTokens)) {
      this.peakInputTokens = Math.max(this.peakInputTokens, usage.inputTokens);
    }
  }

  /** Seed the estimate for a session whose usage is not reported: the
   *  prompts the host sent are a lower bound on what the session holds. */
  observePrompt(text: string): void {
    this.peakInputTokens = Math.max(this.peakInputTokens, estimatePromptTokens(text));
  }

  get peakTokens(): number {
    return this.peakInputTokens;
  }

  shouldRotate(nextPromptTokens = 0): boolean {
    if (this.contextWindowTokens <= 0) return false;
    return (
      this.peakInputTokens + nextPromptTokens >= this.contextWindowTokens * CONTEXT_ROTATE_RATIO
    );
  }

  /** A fresh (compacted) session starts empty; prior facts cross only as
   *  the bounded host seed the adapter prepends to the next prompt. */
  reset(): void {
    this.peakInputTokens = 0;
  }
}
