import { describe, expect, it } from 'vitest';
import {
  canChallenge,
  challengePrompt,
  coverageErrors,
  depthPolicy,
  reportableDepthPlan,
} from '../src/depth.js';

describe('independent depth policy', () => {
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
    expect(canChallenge(60_001, 0)).toBe(true);
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
