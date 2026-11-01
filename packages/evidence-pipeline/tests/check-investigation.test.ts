import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@qa/schemas';
import { createAgentRunId } from '@qa/shared';
import {
  ContextBudget,
  PhaseDeadlineReached,
  investigateChecks,
  promisePhase,
  type CheckInvestigationHooks,
  type InvestigationTurn,
} from '../src/index.js';
import type { ObservedOperation } from '../src/pipeline.js';

type Ops = Map<string, ObservedOperation>;

function addOp(ops: Ops, tool: string, command: string, exitCode?: number): void {
  const key = 'op_' + (ops.size + 1);
  ops.set(key, {
    operationId: ('oid_' + key) as never,
    operationKey: key,
    toolName: tool,
    commandText: command,
    ...(exitCode === undefined ? {} : { exitCode }),
    isTestOperation: false,
  });
}

const eventOf = (body: Readonly<Record<string, unknown>>): HarnessEvent =>
  ({ schemaVersion: 1, eventId: 'evt', timestamp: 't', ...body }) as unknown as HarnessEvent;

async function drain<T>(
  gen: AsyncGenerator<HarnessEvent, T>,
): Promise<{ events: HarnessEvent[]; value: T }> {
  const events: HarnessEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, value: step.value };
}

function harness(
  script: (text: string, ops: Ops) => Promise<InvestigationTurn> | InvestigationTurn,
  overrides: Partial<CheckInvestigationHooks<InvestigationTurn>> = {},
) {
  const ops: Ops = new Map();
  const prompts: string[] = [];
  const sessions = { fresh: 0, reportContext: 0 };
  const hooks: CheckInvestigationHooks<InvestigationTurn> = {
    agentLabel: 'Test',
    agentRunId: createAgentRunId(),
    plan: { plannedChecks: ['Check A', 'Check B'] },
    depth: undefined,
    operations: ops,
    contextBudget: new ContextBudget(200_000),
    event: eventOf,
    streamTurn: (text) =>
      promisePhase(async () => {
        prompts.push(text);
        return await script(text, ops);
      }),
    stop: async () => undefined,
    freshSession: async () => {
      sessions.fresh += 1;
    },
    compactionSeed: () => 'SEED\n',
    startReportContext: async () => {
      sessions.reportContext += 1;
    },
    cancelled: () => false,
    isTurnTimeout: () => false,
    ...overrides,
  };
  return { hooks, ops, prompts, sessions };
}

const codes = (events: HarnessEvent[]): string[] =>
  events.flatMap((e) => ((e as { code?: string }).code ? [(e as { code: string }).code] : []));

describe('investigateChecks', () => {
  it('runs one turn per check and records proof, conclusions and usage', async () => {
    const { hooks, prompts } = harness((_text, ops) => {
      addOp(ops, 'bash', 'node probe.mjs', 0);
      return { text: 'Decided.', usage: { inputTokens: 10 }, steps: 2 };
    });
    const { events, value } = await drain(investigateChecks(hooks));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('INVESTIGATE CHECK');
    expect(value.unprovenChecks).toEqual([]);
    expect(value.redRetryChecks).toEqual([]);
    expect(value.checkConclusions).toEqual(['Decided.', 'Decided.']);
    expect(value.usage?.inputTokens).toBe(20);
    expect(value.steps).toBe(4);
    expect(codes(events)).toEqual([]);
  });

  it('nudges a read-only turn once and keeps the check unproven if it stays read-only', async () => {
    const { hooks, prompts } = harness((_text, ops) => {
      addOp(ops, 'read', 'src/a.ts');
      return { text: 'Looks fine.' };
    });
    const { events, value } = await drain(investigateChecks(hooks));
    expect(prompts.filter((p) => p.includes('EXECUTION REQUIRED'))).toHaveLength(2);
    expect(codes(events).filter((c) => c === 'QA_EXECUTION_NUDGE')).toHaveLength(2);
    expect(value.unprovenChecks).toEqual(['Check A', 'Check B']);
  });

  it('does not nudge a turn whose executed probe failed', async () => {
    const { hooks, prompts } = harness((_text, ops) => {
      addOp(ops, 'bash', 'node probe.mjs', 1);
      return { text: 'Reproduced the defect.' };
    });
    const { events, value } = await drain(investigateChecks(hooks));
    expect(prompts.some((p) => p.includes('EXECUTION REQUIRED'))).toBe(false);
    expect(codes(events)).not.toContain('QA_EXECUTION_NUDGE');
    // A red-only turn is executed but not proof: a pass would still be downgraded.
    expect(value.unprovenChecks).toEqual(['Check A', 'Check B']);
  });

  it('rotates into a fresh seeded session once on context overflow and retries the check', async () => {
    let calls = 0;
    const { hooks, prompts, sessions } = harness(
      (_text, ops) => {
        calls += 1;
        if (calls === 1) throw new Error('prompt is too long: 213462 tokens > 200000 maximum');
        addOp(ops, 'bash', 'node probe.mjs', 0);
        return { text: 'ok' };
      },
      { plan: { plannedChecks: ['Check A'] } },
    );
    const { events } = await drain(investigateChecks(hooks));
    expect(sessions.fresh).toBe(1);
    expect(prompts[1]).toContain('SEED');
    expect(codes(events)).toContain('QA_CONTEXT_COMPACTED');
  });

  it('blocks the remaining checks and reports from a fresh context when a turn hits the deadline', async () => {
    let calls = 0;
    const { hooks, sessions } = harness(
      (_text, ops) => {
        calls += 1;
        if (calls === 1) {
          addOp(ops, 'bash', 'node probe.mjs', 0);
          return { text: 'ok' };
        }
        throw new PhaseDeadlineReached();
      },
      { depth: { deadlineAt: Date.now() + 600_000 } },
    );
    const { events, value } = await drain(investigateChecks(hooks));
    expect(value.blockedChecks).toEqual(['Check B']);
    expect(sessions.reportContext).toBe(1);
    expect(codes(events)).toContain('QA_INVESTIGATION_INCOMPLETE');
  });

  it('salvages banked work on an adapter-declared infrastructure loss but rethrows unknown errors', async () => {
    const lost = new Error('spawn E2BIG');
    const first = harness(
      (_text, ops) => {
        addOp(ops, 'bash', 'node probe.mjs', 0);
        throw lost;
      },
      { depth: { deadlineAt: Date.now() + 600_000 }, isSalvageable: (cause) => cause === lost },
    );
    const salvaged = await drain(investigateChecks(first.hooks));
    expect(salvaged.value.blockedChecks).toEqual(['Check A', 'Check B']);
    expect(first.sessions.reportContext).toBe(1);

    const second = harness(() => {
      throw new Error('boom');
    });
    await expect(drain(investigateChecks(second.hooks))).rejects.toThrow('boom');
  });

  it('never salvages a cancelled run', async () => {
    const { hooks } = harness(
      () => {
        throw new PhaseDeadlineReached();
      },
      { cancelled: () => true },
    );
    await expect(drain(investigateChecks(hooks))).rejects.toBeInstanceOf(PhaseDeadlineReached);
  });

  it('flushes events a failed turn never emitted before handling the failure', async () => {
    const tail = eventOf({ type: 'agent.message', message: 'unflushed tail' });
    const { hooks } = harness(
      () => {
        throw new PhaseDeadlineReached();
      },
      { partialEvents: () => [tail], depth: { deadlineAt: Date.now() + 600_000 } },
    );
    const { events } = await drain(investigateChecks(hooks));
    expect(events).toContain(tail);
  });
});

describe('investigateChecks conclusions handoff', () => {
  it('gives fresh sessions the investigator’s closing statements so far', async () => {
    const seeds: string[] = [];
    let calls = 0;
    const { hooks } = harness(
      (_text, ops) => {
        calls += 1;
        if (calls === 1) {
          addOp(ops, 'bash', 'node probe.mjs', 0);
          return { text: 'Check A: the race is real, reproduced twice.' };
        }
        // Check B overflows once: the fresh session is seeded with check A's statement.
        if (calls === 2) throw new Error('prompt is too long: 213462 tokens > 200000 maximum');
        addOp(ops, 'bash', 'node probe-b.mjs', 0);
        return { text: 'Check B: fine.' };
      },
      {
        compactionSeed: (completed, conclusions) => {
          seeds.push(completed + '|' + conclusions);
          return 'SEED\n';
        },
      },
    );
    await drain(investigateChecks(hooks));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toContain('1|');
    expect(seeds[0]).toContain('the race is real, reproduced twice');
    expect(seeds[0]).not.toContain('Check B');
  });

  it('hands the statements to the report context when investigation ends early', async () => {
    const reportBlocks: string[] = [];
    let calls = 0;
    const { hooks } = harness(
      (_text, ops) => {
        calls += 1;
        if (calls === 1) {
          addOp(ops, 'bash', 'node probe.mjs', 0);
          return { text: 'Check A: the race is real.' };
        }
        throw new PhaseDeadlineReached();
      },
      {
        depth: { deadlineAt: Date.now() + 600_000 },
        startReportContext: async (conclusions) => {
          reportBlocks.push(conclusions);
        },
      },
    );
    await drain(investigateChecks(hooks));
    expect(reportBlocks).toHaveLength(1);
    expect(reportBlocks[0]).toContain('the race is real');
  });
});

describe('investigateChecks conclusion capture', () => {
  it('keeps the closing statement, not the start of the narration', async () => {
    const narration = 'Let me read the code. '.repeat(200);
    const closing =
      'Conclusion: the evidence pipeline trusts a model-declared strength.\nBreaks attempted: synthetic V2 report with exit 0 cited as reproduced_failure.';
    const { hooks } = harness(
      (_text, ops) => {
        addOp(ops, 'bash', 'node probe.mjs', 0);
        return { text: narration + closing };
      },
      { plan: { plannedChecks: ['Check A'] } },
    );
    const { value } = await drain(investigateChecks(hooks));
    const kept = value.checkConclusions[0] ?? '';
    expect(kept.length).toBeLessThanOrEqual(1500);
    expect(kept.endsWith('as reproduced_failure.')).toBe(true);
    expect(kept).toContain('Conclusion: the evidence pipeline trusts');
    expect(kept).toContain('Breaks attempted:');
  });
});

describe('investigateChecks soft time share', () => {
  const MIN = 60_000;

  it('computes a share-based soft budget, floored and capped by what is left', async () => {
    const { checkSoftBudgetMs } = await import('../src/index.js');
    expect(checkSoftBudgetMs(160 * MIN, 4)).toBe(80 * MIN);
    expect(checkSoftBudgetMs(30 * MIN, 8)).toBe(8 * MIN);
    expect(checkSoftBudgetMs(5 * MIN, 3)).toBe(5 * MIN);
    expect(checkSoftBudgetMs(100 * MIN, 1)).toBe(100 * MIN);
    expect(checkSoftBudgetMs(0, 2)).toBe(0);
  });

  it('ends a check that used twice its share, records its conclusion, and runs the rest', async () => {
    const start = Date.now();
    const clock = { t: start };
    const prompts: string[] = [];
    const { hooks } = harness(() => ({ text: 'unused' }), {
      plan: { plannedChecks: ['Check A', 'Check B', 'Check C', 'Check D'] },
      // 160 minutes of investigation window for 4 checks: share 40, soft limit 80
      depth: { deadlineAt: start + 172 * MIN },
      now: () => clock.t,
      streamTurn: (text: string) =>
        (async function* () {
          prompts.push(text);
          if (text.includes('TIME SHARE REACHED'))
            return {
              text: 'WRAP: the lease race looked real. Breaks attempted: concurrent start.',
            };
          if (text.includes('INVESTIGATE CHECK check_1')) {
            for (let i = 0; i < 20; i += 1) {
              // a real model call takes time: the host sees the pause between steps
              await new Promise((resolve) => setTimeout(resolve, 200));
              clock.t += 10 * MIN;
              addOp(ops(), 'bash', 'node probe-' + i + '.mjs', 0);
              yield eventOf({ type: 'tool.completed' });
            }
            return { text: 'never reached' };
          }
          clock.t += 1 * MIN;
          addOp(ops(), 'bash', 'node quick-' + prompts.length + '.mjs', 0);
          yield eventOf({ type: 'tool.completed' });
          return { text: 'done ' + prompts.length };
        })(),
    });
    // the harness helper owns the ledger map; expose it to the script above
    function ops(): Ops {
      return hooks.operations as Ops;
    }
    const { events, value } = await drain(investigateChecks(hooks));
    expect(codes(events)).toContain('QA_CHECK_BUDGET_REACHED');
    expect(codes(events)).not.toContain('QA_APPROACH_CHANGE');
    expect(codes(events)).not.toContain('QA_INVESTIGATION_INCOMPLETE');
    expect(prompts.some((p) => p.includes('TIME SHARE REACHED — CHECK check_1'))).toBe(true);
    expect(value.blockedChecks).toEqual(['Check A']);
    expect(value.checkConclusions[0]).toContain('WRAP: the lease race looked real');
    // the other three checks all ran
    expect(value.checkConclusions.slice(1).every((text) => (text ?? '').startsWith('done'))).toBe(
      true,
    );
    expect(prompts.filter((p) => p.includes('INVESTIGATE CHECK'))).toHaveLength(4);
  });

  it('applies no soft limit outside depth-policy runs', async () => {
    const start = Date.now();
    const clock = { t: start };
    let steps = 0;
    const { hooks } = harness(() => ({ text: 'x' }), {
      plan: { plannedChecks: ['Check A'] },
      now: () => clock.t,
      streamTurn: () =>
        (async function* () {
          for (let i = 0; i < 30; i += 1) {
            steps += 1;
            clock.t += 60 * MIN;
            addOp(hooks.operations as Ops, 'bash', 'node p' + i + '.mjs', 0);
            yield eventOf({ type: 'tool.completed' });
          }
          return { text: 'finished' };
        })(),
    });
    const { events, value } = await drain(investigateChecks(hooks));
    expect(steps).toBe(30);
    expect(codes(events)).not.toContain('QA_CHECK_BUDGET_REACHED');
    expect(value.checkConclusions[0]).toBe('finished');
  });
});
