import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@qa/schemas';
import {
  NO_PROGRESS_LIMIT,
  failedCommandsSince,
  turnWatchdogStop,
  turnProducedProof,
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
      ...reads.slice(0, NO_PROGRESS_LIMIT - 5),
      { tool: 'bash', command: 'node p.mjs', exitCode: 0 },
      ...reads.slice(0, NO_PROGRESS_LIMIT - 5),
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

  it('accepts an interpreter inline script whose quoted body has semicolons and newlines', () => {
    const script =
      'node --input-type=module -e "import { rm } from \'node:fs/promises\'; const r = await rm(\'x\');\nconsole.log(r);" 2>&1';
    expect(isExecutableProofOperation(withFlag(script, false))).toBe(true);
    expect(isExecutableProofOperation(withFlag("python3 -c 'import os; print(1)'", false))).toBe(true);
    expect(isExecutableProofOperation(withFlag('node -e "a(); b()"', false))).toBe(true);
  });

  it('accepts an interpreter fed by one quoted heredoc and nothing else', () => {
    const body = "import { rm } from 'node:fs/promises';\nawait rm('x');\nconsole.log(1);";
    expect(isExecutableProofOperation(withFlag("node --input-type=module <<'EOF'\n" + body + '\nEOF', false))).toBe(true);
    expect(isExecutableProofOperation(withFlag('python3 - <<"PY"\nprint(1)\nPY\n', false))).toBe(true);
  });

  it('rejects a heredoc with unquoted tag, trailing commands or a second terminator', () => {
    const rejects = [
      "node - <<EOF\na();\nEOF",
      "node - <<'EOF'\na();\nEOF\nrm -rf x",
      "node - <<'EOF'\na();\nEOF\nrm -rf x\nEOF",
      "bash <<'EOF'\na; b\nEOF",
      "node - <<'EOF'\na();\nEOF && echo ok",
    ];
    for (const command of rejects) expect(isExecutableProofOperation(withFlag(command, true))).toBe(false);
  });

  it('still rejects what follows or hides behind an inline script', () => {
    const rejects = [
      'node -e "a(); b()" && node other.mjs',
      'node -e "a()"; rm -rf x',
      'node -e "a()" | grep ok',
      'node -e "a()" > out.txt',
      'node -e "$(whoami)"',
      'node -e "`id`"',
      'node -e "unterminated; a()',
      'bash -c "a; b"',
      'sh -c "a && b"',
      'node - <<EOF\na();\nEOF',
    ];
    for (const command of rejects) expect(isExecutableProofOperation(withFlag(command, true))).toBe(false);
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

describe('dependency installs never prove a check', () => {
  const ran = (command: string) =>
    ({
      ...(ledger([{ tool: 'bash', command, exitCode: 0 }]).get('op_1') as ObservedOperation),
    }) as ObservedOperation;

  it.each([
    'pnpm install --frozen-lockfile',
    'npm ci',
    'yarn install --immutable',
    'pip install -r requirements.txt',
    'python3 -m pip install pytest',
    'cargo fetch',
    'go mod download',
    'corepack enable',
    // environment prefixes and package builds are setup too (a run counted them as proof)
    'CI=true pnpm install --frozen-lockfile',
    'NODE_ENV=test npm ci',
    'pnpm --filter @qa/run-engine... build',
    'CI=true pnpm --filter @qa/shared --filter @qa/schemas run build',
    'pnpm exec turbo run build --filter=@qa/x',
    'npm run build',
  ])('does not certify %s as executable proof', (command) => {
    expect(isExecutableProofOperation(ran(command))).toBe(false);
    expect(turnExecutedReproduction(new Set(), new Map([['op_1', ran(command)]]))).toBe(false);
  });

  it.each([
    'pnpm test',
    'node probe.mjs',
    'cargo test',
    'pytest tests/a.py',
    'CI=true pnpm test',
    'pnpm --filter @qa/x test',
    'CI=1 node probe.mjs',
  ])('still certifies %s', (command) => {
    expect(isExecutableProofOperation(ran(command))).toBe(true);
  });
});

describe('read-only spiral counts every looking tool', () => {
  it.each([
    'read',
    'Read',
    'read_file',
    'grep',
    'grep_search',
    'glob',
    'list_dir',
    'list',
    'view',
    'find',
  ])('counts %s', (tool) => {
    const looks = Array.from({ length: NO_PROGRESS_LIMIT }, (_, i) => ({
      tool,
      command: 'target-' + i,
    }));
    expect(turnWatchdogStop(new Set(), ledger(looks))).toEqual({
      kind: 'no-progress',
      reads: NO_PROGRESS_LIMIT,
    });
  });

  it('mixes tools: 86 greps and reads in a row is a spiral', () => {
    const mixed = Array.from({ length: 86 }, (_, i) => ({
      tool: i % 3 === 0 ? 'read' : 'grep',
      command: 'q' + i,
    }));
    expect(turnWatchdogStop(new Set(), ledger(mixed))).toMatchObject({ kind: 'no-progress' });
  });

  it('does not count write, edit or bash as looking', () => {
    const work = Array.from({ length: NO_PROGRESS_LIMIT * 2 }, (_, i) => ({
      tool: i % 2 === 0 ? 'edit' : 'write',
      command: 'probe-' + i + '.mjs',
    }));
    expect(turnWatchdogStop(new Set(), ledger(work))).toBeUndefined();
  });
});

describe('a check that only installed and built has no proof', () => {
  it('leaves the check unproven so the second pass can take it', () => {
    const setup = ledger([
      {
        tool: 'bash',
        command: 'pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -n 20',
        exitCode: 0,
      },
      {
        tool: 'bash',
        command: 'CI=true pnpm install --frozen-lockfile --ignore-scripts',
        exitCode: 0,
      },
      {
        tool: 'bash',
        command: 'CI=true pnpm --filter @qa/run-engine... build 2>&1 | tail -n 30',
        exitCode: 0,
      },
    ]);
    expect(turnProducedProof(new Set(), setup)).toBe(false);
    setup.set('op_4', {
      ...(ledger([{ tool: 'bash', command: 'node check-probe.mjs', exitCode: 0 }]).get(
        'op_1',
      ) as ObservedOperation),
      operationKey: 'op_4',
    });
    expect(turnProducedProof(new Set(), setup)).toBe(true);
  });
});
