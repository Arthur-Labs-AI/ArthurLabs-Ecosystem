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
