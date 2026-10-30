import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@qa/schemas';
import {
  NO_PROGRESS_LIMIT,
  failedCommandsSince,
  turnWatchdogStop,
  isExecutableProofOperation,
  retryKey,
  turnExecutedReproduction,
  buildAlternativeApproachPrompt,
  composeHostFallbackReport,
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

describe('host fallback report', () => {
  it('asserts no findings or passes and keeps conclusions as unverified', () => {
    const report = composeHostFallbackReport(
      { plannedChecks: ['A', 'B'] },
      ledger([{ tool: 'bash', command: 'node p.mjs', exitCode: 1 }]),
      ['Race is real: reproduced twice.', undefined],
      'the reporting stage reached its protected deadline.',
    );
    expect(report.findings).toEqual([]);
    expect(report.checks.map((c) => c.status)).toEqual(['inconclusive', 'not_run']);
    expect(report.checks[0]?.details).toContain('Unverified agent conclusion');
    expect(report.summary).toContain('1 command(s) ran (1 non-zero)');
    expect(report.limitations[0]).toContain('Host fallback');
  });
});

describe('proof certification of output handling', () => {
  const withFlag = (command: string, pipefail: boolean): ObservedOperation => ({
    ...(ledger([{ tool: 'bash', command, exitCode: 0 }]).get('op_1') as ObservedOperation),
    ...(pipefail ? { pipefail: true } : {}),
  });

  it('accepts stderr redirects, which never change the exit status', () => {
    expect(isExecutableProofOperation(withFlag('npx vitest run a.test.ts 2>&1', false))).toBe(true);
    expect(isExecutableProofOperation(withFlag('node p.mjs 2>/dev/null', false))).toBe(true);
  });

  it('accepts a trailing tail/head filter only under pipefail', () => {
    const cmd = 'npx vitest run a.test.ts 2>&1 | tail -40';
    expect(isExecutableProofOperation(withFlag(cmd, true))).toBe(true);
    expect(isExecutableProofOperation(withFlag(cmd, false))).toBe(false);
  });

  it('still rejects compound commands and other pipes under pipefail', () => {
    expect(isExecutableProofOperation(withFlag('node a.mjs && node b.mjs', true))).toBe(false);
    expect(isExecutableProofOperation(withFlag('node a.mjs | grep ok', true))).toBe(false);
    expect(isExecutableProofOperation(withFlag('node a.mjs > out.txt', true))).toBe(false);
  });
});

describe('retry identity and executed reproductions', () => {
  it('counts the same run with varying tail/redirect handling as one command', () => {
    const run = (n: number) => ({
      tool: 'bash',
      command: './node_modules/.bin/vitest run a.test.ts 2>&1 | tail -' + n,
      exitCode: 1,
    });
    const ops = ledger([run(100), run(120), run(150)]);
    expect(turnWatchdogStop(new Set(), ops)).toMatchObject({ kind: 'red-retry', failures: 3 });
    expect(failedCommandsSince(new Set(), ops)).toEqual([
      { command: './node_modules/.bin/vitest run a.test.ts', exitCode: 1, times: 3 },
    ]);
    expect(retryKey('node p.mjs   2>&1 | head -5')).toBe('node p.mjs');
  });

  it('treats a red probe as an executed reproduction but not a failed ls', () => {
    const red = ledger([{ tool: 'bash', command: 'vitest run probe.test.ts', exitCode: 1 }]);
    expect(turnExecutedReproduction(new Set(), red)).toBe(true);
    const looked = ledger([
      { tool: 'bash', command: 'ls missing', exitCode: 2 },
      { tool: 'read', command: 'src/a.ts' },
      { tool: 'edit', command: 'probe.test.ts' },
    ]);
    expect(turnExecutedReproduction(new Set(), looked)).toBe(false);
    expect(turnExecutedReproduction(new Set(['op_1']), red)).toBe(false);
  });
});
