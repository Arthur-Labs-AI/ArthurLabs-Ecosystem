import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@qa/schemas';
import {
  NO_PROGRESS_LIMIT,
  failedCommandsSince,
  turnWatchdogStop,
  buildAlternativeApproachPrompt,
} from '../src/index.js';
import { watchTurn } from '../src/phase-budget.js';
import type { ObservedOperation } from '../src/pipeline.js';

function ledger(
  ops: Array<{ tool: string; command?: string; exitCode?: number }>,
): Map<string, ObservedOperation> {
  return new Map(
    ops.map((op, i) => [
      'op_' + (i + 1),
      {
        operationId: 'oid_' + i,
        operationKey: 'op_' + (i + 1),
        toolName: op.tool,
        commandText: op.command,
        ...(op.exitCode === undefined ? {} : { exitCode: op.exitCode }),
        isTestOperation: false,
      } as unknown as ObservedOperation,
    ]),
  );
}

describe('turn watchdog', () => {
  const red = { tool: 'bash', command: 'vitest run a.test.ts', exitCode: 1 };

  it('stops a turn when the same command fails three times, edits between', () => {
    const ops = ledger([red, { tool: 'edit', command: 'a.test.ts' }, red, red]);
    expect(turnWatchdogStop(new Set(), ops)).toEqual({
      kind: 'red-retry',
      command: 'vitest run a.test.ts',
      failures: 3,
    });
  });

  it('ignores failures from earlier checks and different commands', () => {
    const ops = ledger([red, red, { ...red, command: 'node b.mjs' }, red]);
    expect(turnWatchdogStop(new Set(['op_1', 'op_2']), ops)).toBeUndefined();
  });

  it('stops a read-only spiral but not reads interleaved with execution', () => {
    const reads = Array.from({ length: NO_PROGRESS_LIMIT }, (_, i) => ({
      tool: i % 2 ? 'grep' : 'read',
      command: 'f' + i,
    }));
    expect(turnWatchdogStop(new Set(), ledger(reads))).toEqual({
      kind: 'no-progress',
      reads: NO_PROGRESS_LIMIT,
    });
    const mixed = [
      ...reads.slice(0, 20),
      { tool: 'bash', command: 'node p.mjs', exitCode: 0 },
      ...reads.slice(0, 20),
    ];
    expect(turnWatchdogStop(new Set(), ledger(mixed))).toBeUndefined();
  });

  it('lists distinct failed commands for the approach brief', () => {
    const ops = ledger([red, red, { tool: 'bash', command: 'ls x', exitCode: 2 }]);
    expect(failedCommandsSince(new Set(), ops)).toEqual([
      { command: 'vitest run a.test.ts', exitCode: 1, times: 2 },
      { command: 'ls x', exitCode: 2, times: 1 },
    ]);
  });

  it('builds a brief that forbids loosening assertions and repeating failures', () => {
    const text = buildAlternativeApproachPrompt(
      { plannedChecks: ['Cancel race'] },
      0,
      { kind: 'red-retry', command: 'vitest run a.test.ts', failures: 3 },
      2,
      [{ command: 'vitest run a.test.ts', exitCode: 1, times: 3 }],
    );
    expect(text).toContain('attempt 2 of 3');
    expect(text).toContain('DIFFERENT method');
    expect(text).toContain('do not weaken');
    expect(text).toContain('vitest run a.test.ts');
    expect(text).toContain('defect candidate');
  });
});

describe('watchTurn', () => {
  const ev = (type: string): HarnessEvent => ({ type }) as unknown as HarnessEvent;

  async function* source(
    events: HarnessEvent[],
    after?: () => Promise<void>,
  ): AsyncGenerator<HarnessEvent, string> {
    for (const e of events) yield e;
    await after?.();
    return 'done';
  }

  it('passes a finished turn through untouched', async () => {
    const gen = watchTurn(
      source([ev('a'), ev('b')]),
      () => undefined,
      async () => undefined,
    );
    const seen: string[] = [];
    let step = await gen.next();
    while (!step.done) {
      seen.push((step.value as unknown as { type: string }).type);
      step = await gen.next();
    }
    expect(seen).toEqual(['a', 'b']);
    expect(step.value).toEqual({ stopped: false, value: 'done' });
  });

  it('stops after the signal, drains the batch and withholds the next tool start', async () => {
    let stops = 0;
    let tripped = false;
    const gen = watchTurn(
      source(
        [ev('tool.completed'), ev('command.executed'), ev('tool.started'), ev('later')],
        () => new Promise(() => undefined),
      ),
      () => {
        if (tripped) return undefined;
        tripped = true;
        return 'red';
      },
      async () => {
        stops += 1;
      },
    );
    const seen: string[] = [];
    let step = await gen.next();
    while (!step.done) {
      seen.push((step.value as unknown as { type: string }).type);
      step = await gen.next();
    }
    expect(seen).toEqual(['tool.completed', 'command.executed']);
    expect(step.value).toEqual({ stopped: true, reason: 'red' });
    expect(stops).toBe(1);
  });
});
