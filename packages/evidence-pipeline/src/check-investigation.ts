import type { AgentUsage, HarnessEvent } from '@qa/schemas';
import type { AgentNetworkPromptOptions, AgentRunId } from '@qa/shared';
import type { ObservedOperation } from './pipeline.js';
import type { ContextBudget } from './context-budget.js';
import { estimatePromptTokens, isContextWindowExceeded } from './context-budget.js';
import {
  MAX_APPROACH_ATTEMPTS,
  closingTriagesFailures,
  failedCommandsSince,
  turnExecutedReproduction,
  turnProducedProof,
  turnRepeatedRedProof,
  turnWatchdogStop,
  type TurnStop,
} from './depth.js';
import {
  PhaseDeadlineReached,
  investigationDeadline,
  limitPhase,
  watchTurn,
  type WatchedTurn,
} from './phase-budget.js';
import {
  buildAlternativeApproachPrompt,
  buildExecutionNudgePrompt,
  buildQaCheckInvestigationPrompt,
  renderCheckConclusions,
} from './stage-prompts.js';

/** What the shared loop needs from an adapter's collected turn. */
export interface InvestigationTurn {
  readonly text: string;
  readonly usage?: AgentUsage | undefined;
  /** Provider steps in the turn; adapters without step counts omit it (one turn = one step). */
  readonly steps?: number;
}

/** Everything vendor-specific the host-driven check loop delegates to an adapter. */
export interface CheckInvestigationHooks<T extends InvestigationTurn> {
  /** Display name used in status messages, e.g. "OpenCode". */
  readonly agentLabel: string;
  readonly agentRunId: AgentRunId;
  readonly plan: { readonly plannedChecks: readonly string[] };
  /** Undefined outside depth-policy (legacy) runs: no deadline, no salvage. */
  readonly depth: { readonly deadlineAt: number } | undefined;
  /** The adapter's live frozen-ledger map; read after every event. */
  readonly operations: ReadonlyMap<string, ObservedOperation>;
  readonly contextBudget: ContextBudget;
  /** Network guidance for the check prompt: web opt-in and whether this harness has web tools. */
  readonly network: AgentNetworkPromptOptions;
  /** Validated harness event factory (adapter-specific envelope). */
  readonly event: (body: Readonly<Record<string, unknown>>) => HarnessEvent;
  /** One investigation turn in the adapter's live session. */
  readonly streamTurn: (text: string) => AsyncGenerator<HarnessEvent, T>;
  /** Stops owned work in flight (closes the client / disposes the session). */
  readonly stop: () => Promise<void>;
  /** Discards the bloated session and starts a fresh one. */
  readonly freshSession: () => Promise<void>;
  /** Host-observed seed for a fresh investigation session. */
  readonly compactionSeed: (completedChecks: number, conclusions: string) => string;
  /** Switches the adapter to a fresh report-only context (called when investigation ends early). */
  readonly startReportContext: (conclusions: string) => Promise<void>;
  readonly cancelled: () => boolean;
  /** The adapter's own per-turn timeout error. */
  readonly isTurnTimeout: (cause: unknown) => boolean;
  /** Infrastructure loss with banked work (spawn failure, mid-run sandbox death) that must not fail the run. */
  readonly isSalvageable?: (cause: unknown) => boolean;
  /** Events a failed turn never flushed, emitted before the failure is handled. */
  readonly partialEvents?: (cause: unknown) => Iterable<HarnessEvent>;
  /** Cleanup after the investigation was interrupted (before the report context starts). */
  readonly onInterrupted?: () => void;
}

export interface CheckInvestigationResult {
  /** Checks the host ended early; they are reported inconclusive. */
  readonly blockedChecks: string[];
  /** Checks whose own turn produced no successful executable reproduction. */
  readonly unprovenChecks: string[];
  /** Checks that retried a failing proof command without triaging it, or exhausted approach attempts. */
  readonly redRetryChecks: string[];
  /** Per-check closing text (unverified agent statements), indexed like plannedChecks. */
  readonly checkConclusions: Array<string | undefined>;
  readonly usage: AgentUsage | undefined;
  readonly steps: number;
}

export function sumAgentUsage(first: AgentUsage | undefined, second: AgentUsage): AgentUsage {
  if (first === undefined) return second;
  const add = (a?: number, b?: number): number | undefined =>
    a === undefined ? b : b === undefined ? a : a + b;
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cachedInputTokens: add(first.cachedInputTokens, second.cachedInputTokens),
    turns: add(first.turns, second.turns),
    durationMs: add(first.durationMs, second.durationMs),
  };
}

/**
 * Stage 2 for every adapter: one host-driven turn per frozen check. Owns
 * context rotation, the live watchdog with different-approach attempts, the
 * execution nudge for read-only turns, and the per-check closure bookkeeping.
 * A turn that dies blocks only its remaining checks; earlier checks'
 * operations stay in the ledger and the caller reports from a fresh context.
 */
export async function* investigateChecks<T extends InvestigationTurn>(
  hooks: CheckInvestigationHooks<T>,
): AsyncGenerator<HarnessEvent, CheckInvestigationResult> {
  const { plan, depth, operations, contextBudget } = hooks;
  const blockedChecks: string[] = [];
  const unprovenChecks: string[] = [];
  const redRetryChecks: string[] = [];
  const checkConclusions: Array<string | undefined> = [];
  let usage: AgentUsage | undefined;
  let steps = 0;
  let seed = '';
  let currentCheck = 0;
  const description = (index: number): string => plan.plannedChecks[index] ?? '';
  const interrupted = (): boolean => hooks.cancelled();

  const rotate = async (completedChecks: number): Promise<void> => {
    await hooks.freshSession();
    seed = hooks.compactionSeed(completedChecks, renderCheckConclusions(plan, checkConclusions));
    contextBudget.reset();
  };

  /** One owned turn, stopped early on a behavioural signal and bounded by the investigation deadline. */
  const watched = (
    text: string,
    beforeKeys: ReadonlySet<string>,
  ): AsyncGenerator<HarnessEvent, WatchedTurn<T, TurnStop>> => {
    const source = watchTurn(
      hooks.streamTurn(text),
      () => turnWatchdogStop(beforeKeys, operations),
      hooks.stop,
    );
    return depth === undefined
      ? source
      : limitPhase(source, investigationDeadline(depth.deadlineAt), hooks.stop);
  };

  /** Runs a turn; a failed turn first flushes the events it never emitted. */
  async function* guarded(
    text: string,
    beforeKeys: ReadonlySet<string>,
  ): AsyncGenerator<HarnessEvent, WatchedTurn<T, TurnStop>> {
    try {
      return yield* watched(text, beforeKeys);
    } catch (cause) {
      for (const emitted of hooks.partialEvents?.(cause) ?? []) yield emitted;
      throw cause;
    }
  }

  const isDeadline = (cause: unknown): boolean =>
    cause instanceof PhaseDeadlineReached || hooks.isTurnTimeout(cause);
  const recoverable = (cause: unknown): boolean =>
    isContextWindowExceeded(cause) || (hooks.isSalvageable?.(cause) ?? false);

  try {
    for (; currentCheck < plan.plannedChecks.length; currentCheck += 1) {
      yield hooks.event({
        type: 'agent.status',
        status: 'investigating',
        message:
          hooks.agentLabel +
          ' is investigating check ' +
          (currentCheck + 1) +
          '/' +
          plan.plannedChecks.length +
          ': ' +
          description(currentCheck).slice(0, 120),
      });
      const ledgerBeforeTurn = new Set(operations.keys());
      const checkPrompt = buildQaCheckInvestigationPrompt(
        plan,
        currentCheck,
        operations,
        hooks.network,
      );
      // Prevention: rotate BEFORE the provider rejects a turn for context
      // overflow (host compaction; no model summary crosses the boundary).
      if (
        currentCheck > 0 &&
        seed === '' &&
        contextBudget.shouldRotate(estimatePromptTokens(checkPrompt))
      ) {
        await rotate(currentCheck);
        yield hooks.event({
          type: 'warning',
          code: 'QA_CONTEXT_COMPACTED',
          message:
            'Context budget reached during investigation; continuing in a fresh session seeded with host-observed facts only.',
        });
      }
      let turn: T | undefined;
      let issued = 0;
      let tripped: TurnStop | undefined;
      let contextRetried = false;
      while (turn === undefined) {
        const turnText = seed + checkPrompt;
        seed = '';
        try {
          const outcome = yield* guarded(turnText, ledgerBeforeTurn);
          if (outcome.stopped) tripped = outcome.reason;
          else issued = outcome.value.steps ?? 1;
          turn = outcome.stopped ? ({ text: '' } as T) : outcome.value;
        } catch (cause) {
          // Reactive compaction: one fresh-session retry of THIS check.
          if (!isContextWindowExceeded(cause) || contextRetried || hooks.cancelled()) throw cause;
          contextRetried = true;
          await rotate(currentCheck);
          yield hooks.event({
            type: 'warning',
            code: 'QA_CONTEXT_COMPACTED',
            message:
              'Provider reported context overflow during investigation; retrying this check once in a fresh session seeded with host-observed facts only.',
          });
        }
      }
      // The host stopped the turn on a behavioural signal (same command
      // failing again and again, or a read-only spiral): grant bounded
      // attempts with a different method, each in a fresh seeded session.
      let approachAttempts = 0;
      while (tripped !== undefined && approachAttempts < MAX_APPROACH_ATTEMPTS && !interrupted()) {
        approachAttempts += 1;
        const attemptBefore = new Set(operations.keys());
        await rotate(currentCheck);
        const attemptText =
          seed +
          buildAlternativeApproachPrompt(
            plan,
            currentCheck,
            tripped,
            approachAttempts,
            failedCommandsSince(ledgerBeforeTurn, operations),
          );
        seed = '';
        yield hooks.event({
          type: 'warning',
          code: 'QA_APPROACH_CHANGE',
          message:
            'Check turn stopped (' +
            (tripped.kind === 'red-retry'
              ? 'same command failed ' + tripped.failures + ' times'
              : tripped.reads + ' read-only calls without running anything') +
            '); attempt ' +
            approachAttempts +
            ' of ' +
            MAX_APPROACH_ATTEMPTS +
            ' with a different approach in a fresh session.',
        });
        try {
          const outcome = yield* guarded(attemptText, attemptBefore);
          if (outcome.stopped) tripped = outcome.reason;
          else {
            tripped = undefined;
            turn = {
              ...turn,
              text: outcome.value.text,
              usage: sumAgentUsage(turn.usage, outcome.value.usage ?? {}),
            };
            issued += outcome.value.steps ?? 1;
          }
        } catch (cause) {
          if (isDeadline(cause) || isContextWindowExceeded(cause) || interrupted()) throw cause;
          break; // Any other attempt failure keeps the banked work.
        }
      }
      if (tripped !== undefined) {
        yield hooks.event({
          type: 'warning',
          code: 'QA_APPROACH_EXHAUSTED',
          message:
            'Check could not be decided after ' +
            approachAttempts +
            ' approach change(s); it stays inconclusive and the failed approaches remain in the ledger.',
        });
        unprovenChecks.push(description(currentCheck));
        redRetryChecks.push(description(currentCheck));
      }
      if (
        tripped === undefined &&
        !turnProducedProof(ledgerBeforeTurn, operations) &&
        !turnExecutedReproduction(ledgerBeforeTurn, operations) &&
        !interrupted()
      ) {
        // Read-only turn: one bounded host nudge to execute.
        yield hooks.event({
          type: 'warning',
          code: 'QA_EXECUTION_NUDGE',
          message:
            'Check turn ended without executable proof; issuing one follow-up turn requiring a real reproduction.',
        });
        try {
          const nudged = yield* guarded(
            buildExecutionNudgePrompt(plan, currentCheck),
            new Set(operations.keys()),
          );
          if (!nudged.stopped) {
            turn = {
              ...turn,
              text: nudged.value.text,
              usage: sumAgentUsage(turn.usage, nudged.value.usage ?? {}),
            };
            issued += nudged.value.steps ?? 1;
          }
        } catch (cause) {
          if (isDeadline(cause) || isContextWindowExceeded(cause) || interrupted()) throw cause;
          // Any other nudge failure keeps the original turn's banked work.
        }
      }
      contextBudget.observeTurn(turn.usage);
      if (!turnProducedProof(ledgerBeforeTurn, operations))
        unprovenChecks.push(description(currentCheck));
      if (turnRepeatedRedProof(ledgerBeforeTurn, operations) && !closingTriagesFailures(turn.text))
        redRetryChecks.push(description(currentCheck));
      checkConclusions[currentCheck] = turn.text.slice(0, 1500);
      usage = sumAgentUsage(usage, turn.usage ?? {});
      steps += issued;
    }
  } catch (cause) {
    if (
      (depth === undefined && !recoverable(cause)) ||
      !(isDeadline(cause) || recoverable(cause)) ||
      hooks.cancelled()
    )
      throw cause;
    blockedChecks.push(...plan.plannedChecks.slice(currentCheck));
    hooks.onInterrupted?.();
    await hooks.startReportContext(renderCheckConclusions(plan, checkConclusions));
    yield hooks.event({
      type: 'warning',
      code: 'QA_INVESTIGATION_INCOMPLETE',
      message:
        'Investigation turn ended early; remaining checks are inconclusive. Reporting only this agent’s observed facts in a fresh report-only context; analysis is partial.',
    });
  }
  return { blockedChecks, unprovenChecks, redRetryChecks, checkConclusions, usage, steps };
}
