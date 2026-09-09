import { describe, expect, it } from 'vitest';
import { FindingSchema } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const base = {
  schemaVersion: 1,
  id: 'find_01K7777777777777777777A8W7',
  qaRunId: 'run_01K7777777777777777777A8W3',
  agentRunId: 'arun_01K7777777777777777777A8W4',
  sourceAgentStackId: 'stack_muse_main',
  title: 'Session never expires',
  category: 'authentication',
  severity: 'high',
  confidence: 'strong',
  description: 'No expiry check.',
  locations: [{ relativePath: 'src/auth/session.ts', startLine: 2, endLine: 5 }],
  evidenceIds: [],
  reproductionSteps: [],
  createdAt: T,
};

describe('FindingSchema', () => {
  it('accepts a valid finding', () => {
    expect(FindingSchema.safeParse(base).success).toBe(true);
  });
  it('rejects invalid severity / confidence', () => {
    expect(FindingSchema.safeParse({ ...base, severity: 'urgent' }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, confidence: 'certain' }).success).toBe(false);
  });
  it('rejects absolute locations', () => {
    expect(
      FindingSchema.safeParse({ ...base, locations: [{ relativePath: 'C:/x.ts' }] }).success,
    ).toBe(false);
    expect(
      FindingSchema.safeParse({ ...base, locations: [{ relativePath: '/x.ts' }] }).success,
    ).toBe(false);
  });
  it('rejects line 0 and endLine before startLine', () => {
    expect(
      FindingSchema.safeParse({ ...base, locations: [{ relativePath: 'a.ts', startLine: 0 }] })
        .success,
    ).toBe(false);
    expect(
      FindingSchema.safeParse({
        ...base,
        locations: [{ relativePath: 'a.ts', startLine: 9, endLine: 3 }],
      }).success,
    ).toBe(false);
  });
  it('rejects unknown top-level categories but accepts other + detail', () => {
    expect(FindingSchema.safeParse({ ...base, category: 'nope' }).success).toBe(false);
    const { category: _unusedCategory, ...rest } = base;
    void _unusedCategory;
    expect(FindingSchema.safeParse({ ...rest, category: 'other' }).success).toBe(false);
    expect(
      FindingSchema.safeParse({ ...rest, category: 'other', categoryDetail: 'custom area' })
        .success,
    ).toBe(true);
  });
});
