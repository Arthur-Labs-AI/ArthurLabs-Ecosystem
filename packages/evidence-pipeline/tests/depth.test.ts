import { describe, expect, it, vi } from 'vitest';
import {
  canChallenge,
  challengePrompt,
  coverageErrors,
  depthPolicy,
  reportableDepthPlan,
  validationBudgetMs,
  boundedValidation,
  groundCoverage,
  reviewNeedsUpdate,
  resolveReportChecks,
  reportCheckAliases,
} from '../src/depth.js';

describe('independent depth policy', () => {
  it('maps only stable check IDs or exact frozen names, never fuzzy descriptions', () => {
    const plan = { plannedChecks: ['Very long check: executed - inspected caller', 'Other check'] };
    const report = {
      checks: [
        { name: 'check_1', status: 'inconclusive', details: 'Unavailable' },
        { name: 'Other check', status: 'passed' },
      ],
    };
    expect(resolveReportChecks(plan, report).checks.map((c) => c.name)).toEqual(plan.plannedChecks);
    expect(reportCheckAliases(plan)).toContain('check_1');
    expect(
      resolveReportChecks(plan, { checks: [{ name: 'Very long check', status: 'passed' }] })
        .checks[0]?.name,
    ).toBe('Very long check');
  });
  it.each([
    'node -e "process.exit(1)"; pwd',
    'node failing-test.mjs\npwd',
    '/usr/bin/grep guard src/file.ts',
    'cd /tmp && cat src/file.ts',
  ])('does not certify ambiguous or source-only shell command: %s', (commandText) => {
    const report = {
      schemaVersion: 2 as const,
      summary: 'fixture',
      checks: [
        {
          name: 'tests',
          status: 'passed' as const,
          coverage: 'complete' as const,
          operationKeys: ['op_1'],
        },
      ],
      limitations: [],
      evidence: [],
      findings: [],
      hypotheses: [],
    };
    const op = {
      operationKey: 'op_1',
      operationId: 'operation_1' as never,
      toolName: 'bash',
      exitCode: 0,
      isTestOperation: true,
      commandText,
    };
    expect(groundCoverage(report, new Map([['op_1', op]])).checks[0]?.status).toBe('inconclusive');
  });
  it('avoids a second paid serialization when validation confirms the checkpoint unchanged', () => {
    expect(reviewNeedsUpdate('{"reportNeedsUpdate":false}')).toBe(false);
    expect(reviewNeedsUpdate('{"reportNeedsUpdate":true}')).toBe(true);
    expect(reviewNeedsUpdate('No changes')).toBe(true);
    expect(reviewNeedsUpdate('{"reportNeedsUpdate":false,"finding":"new"}')).toBe(true);
  });
  it('downgrades source-only and partial passes, and rejects masked shell success', () => {
    const report = {
      schemaVersion: 2 as const,
      summary: 'fixture',
      checks: [
        {
          name: 'full boundary',
          status: 'passed' as const,
          coverage: 'complete' as const,
          operationKeys: ['op_1'],
        },
      ],
      limitations: [],
      evidence: [],
      findings: [],
      hypotheses: [],
    };
    const op = {
      operationKey: 'op_1',
      operationId: 'operation_1' as never,
      toolName: 'bash',
      exitCode: 0,
      isTestOperation: true,
      commandText: 'node tests/boundary.mjs',
    };
    expect(groundCoverage(report, new Map()).checks[0]?.status).toBe('inconclusive');
    expect(
      groundCoverage(
        report,
        new Map([['op_1', { ...op, commandText: 'grep -n guard src/file.ts' }]]),
      ).checks[0]?.status,
    ).toBe('inconclusive');
    expect(
      groundCoverage(report, new Map([['op_1', { ...op, commandText: 'pnpm test | tail -10' }]]))
        .checks[0]?.status,
    ).toBe('inconclusive');
    expect(
      groundCoverage(
        { ...report, checks: [{ ...report.checks[0]!, coverage: 'partial' }] },
        new Map([['op_1', op]]),
      ).checks[0]?.status,
    ).toBe('inconclusive');
    expect(groundCoverage(report, new Map([['op_1', op]])).checks[0]?.status).toBe('passed');
  });
  it('stops owned validation on its own timeout rather than consuming finalization time', async () => {
    vi.useFakeTimers();
    let stopped = false;
    try {
      const pending = boundedValidation(
        () => new Promise<never>(() => undefined),
        100,
        async () => {
          stopped = true;
        },
      );
      const assertion = expect(pending).rejects.toThrow('QA_VALIDATION_TIMEOUT');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not spend the last reporting budget on an optional validation phase', () => {
    expect(validationBudgetMs(4 * 60_000, 0)).toBe(0);
    expect(validationBudgetMs(10 * 60_000, 0)).toBe(2 * 60_000);
  });
  it('rejects plans that cannot be represented by exact report names before investigation', () => {
    expect(() => reportableDepthPlan({ plannedChecks: ['x'.repeat(501)] }, true)).toThrow('500');
    expect(() => reportableDepthPlan({ plannedChecks: ['same', 'same'] }, true)).toThrow('unique');
    expect(
      reportableDepthPlan({ plannedChecks: ['x'.repeat(501)] }, false).plannedChecks,
    ).toHaveLength(1);
  });
  it('requires a supported coordinator policy and finite deadline', () => {
    expect(depthPolicy(undefined)).toBeUndefined();
    expect(depthPolicy({ qaDepth: { version: 2, deadlineAt: 100 } })).toBeUndefined();
    expect(depthPolicy({ qaDepth: { version: 1, deadlineAt: Infinity } })).toBeUndefined();
    expect(depthPolicy({ qaDepth: { version: 1, deadlineAt: 100 } })?.deadlineAt).toBe(100);
    expect(canChallenge(600_000, 0)).toBe(true);
    expect(canChallenge(4 * 60_000, 0)).toBe(false);
    expect(canChallenge(60_000, 0)).toBe(false);
  });
  it('rejects missing/duplicate checks and unexplained limitations', () => {
    const plan = { plannedChecks: ['auth', 'build'] };
    expect(coverageErrors(plan, { checks: [] })).toHaveLength(2);
    expect(
      coverageErrors(plan, {
        checks: [
          { name: 'auth', status: 'not_run' },
          { name: 'build', status: 'passed' },
        ],
      }),
    ).toHaveLength(1);
    expect(
      coverageErrors(plan, {
        checks: [
          { name: 'auth', status: 'passed' },
          { name: 'auth', status: 'passed' },
          { name: 'build', status: 'passed' },
        ],
      }),
    ).toHaveLength(1);
    expect(
      coverageErrors(plan, {
        checks: [
          { name: 'auth', status: 'not_run', details: 'Missing test toolchain' },
          { name: 'build', status: 'failed' },
        ],
      }),
    ).toEqual([]);
  });
  it('requires real call paths, independent work and allows zero findings', () => {
    const prompt = challengePrompt({ plannedChecks: ['auth'] });
    expect(prompt).toContain('real caller');
    expect(prompt).toContain('Zero findings is valid');
    expect(prompt).toContain('Never bypass sandboxing');
    expect(prompt).toContain('auth');
  });
});
