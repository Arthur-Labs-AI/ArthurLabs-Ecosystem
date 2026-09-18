import { describe, expect, it } from 'vitest';
import { compareRetestSteps, classifyRetest, retestStepKey } from '../src/index.js';

const failedCmd = (command: string, exitCode: string) => ({
  type: 'command_replay',
  expected: { command, exitCode, cwdRelative: '.' },
  outcome: 'matched',
  matchStrength: 'strong_match',
});
const failedTest = (testName: string) => ({
  type: 'test_replay',
  expected: { testName, testStatus: 'failed' },
  outcome: 'matched',
  matchStrength: 'strong_match',
});
const passedCmd = (command: string) => ({
  type: 'command_replay',
  expected: { command, exitCode: '0', cwdRelative: '.' },
  outcome: 'matched',
  matchStrength: 'strong_match',
});
const passedTest = (testName: string) => ({
  type: 'test_replay',
  expected: { testName, testStatus: 'passed' },
  outcome: 'matched',
  matchStrength: 'strong_match',
});

describe('Phase 7 cross-revision comparison (§84–§87)', () => {
  it('keys replay intent exactly, excluding integrity and unsupported steps', () => {
    expect(
      retestStepKey({
        type: 'command_replay',
        expected: { command: 'pnpm test', cwdRelative: '.' },
      }),
    ).toBe('cmd|pnpm test|.');
    expect(retestStepKey({ type: 'test_replay', expected: { testName: 'divide suite' } })).toBe(
      'test|divide suite',
    );
    expect(
      retestStepKey({ type: 'source_integrity', expected: { relativePath: 'a.ts' } }),
    ).toBeUndefined();
    expect(retestStepKey({ type: 'unsupported_claim', expected: {} })).toBeUndefined();
    expect(retestStepKey({ type: 'command_replay', expected: {} })).toBeUndefined();
  });

  it('fixed: same target test failed on A, passes on B (§84)', () => {
    const compared = compareRetestSteps({
      sourceSteps: [failedTest('target Test A')],
      targetSteps: [passedTest('target Test A')],
    });
    expect(compared.baselineKeys).toHaveLength(1);
    expect(classifyRetest(compared.input).result).toBe('fixed');
  });

  it('still_reproducible: same failure identity on B (§85)', () => {
    const compared = compareRetestSteps({
      sourceSteps: [failedCmd('pnpm vitest run math.test.ts', '1')],
      targetSteps: [failedCmd('pnpm vitest run math.test.ts', '1')],
    });
    expect(classifyRetest(compared.input).result).toBe('still_reproducible');
  });

  it('partially_fixed: assertion A fixed, B still reproduces (§86)', () => {
    const compared = compareRetestSteps({
      sourceSteps: [failedTest('crash path'), failedTest('corruption path')],
      targetSteps: [passedTest('crash path'), failedTest('corruption path')],
    });
    expect(classifyRetest(compared.input).result).toBe('partially_fixed');
  });

  it('inconclusive: target test absent on B (§87)', () => {
    const compared = compareRetestSteps({
      sourceSteps: [failedTest('target Test A')],
      targetSteps: [],
    });
    expect(classifyRetest(compared.input).result).toBe('inconclusive');
    expect(compared.limitations.join(' ')).toContain('not observed');
  });

  it('inconclusive: weak source baseline never proves anything', () => {
    const compared = compareRetestSteps({
      sourceSteps: [{ ...failedTest('target Test A'), matchStrength: 'weak_match' }],
      targetSteps: [passedTest('target Test A')],
    });
    expect(compared.baselineKeys).toHaveLength(0);
    expect(classifyRetest(compared.input).result).toBe('inconclusive');
  });

  it('moved problem: different failure signature is inconclusive, never fixed (finish-pass §54)', () => {
    const compared = compareRetestSteps({
      sourceSteps: [failedCmd('pnpm test', '1')],
      targetSteps: [failedCmd('pnpm test', '2')],
    });
    expect(classifyRetest(compared.input).result).toBe('inconclusive');
    expect(compared.limitations.join(' ')).toContain('different signature');
  });

  it('fixed: same command failed on A, exits zero on B', () => {
    const compared = compareRetestSteps({
      sourceSteps: [failedCmd('pnpm vitest run math.test.ts', '1')],
      targetSteps: [passedCmd('pnpm vitest run math.test.ts')],
    });
    expect(classifyRetest(compared.input).result).toBe('fixed');
  });

  it('ignores integrity drift between revisions', () => {
    const compared = compareRetestSteps({
      sourceSteps: [
        failedTest('target Test A'),
        {
          type: 'source_integrity',
          expected: { relativePath: 'src/a.ts' },
          outcome: 'matched',
          matchStrength: 'strong_match',
        },
      ],
      targetSteps: [passedTest('target Test A')],
    });
    expect(compared.baselineKeys).toHaveLength(1);
    expect(classifyRetest(compared.input).result).toBe('fixed');
  });
});
