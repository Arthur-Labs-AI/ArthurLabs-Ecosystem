import { describe, expect, it } from 'vitest';
import { EvidenceSchema } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const base = {
  schemaVersion: 1,
  id: 'ev_01K7777777777777777777A8W9',
  qaRunId: 'run_01K7777777777777777777A8W3',
  type: 'command',
  strength: 'reproduced_failure',
  command: { command: 'pnpm vitest run', exitCode: 1 },
  artifactIds: [],
  createdAt: T,
};

describe('EvidenceSchema', () => {
  it('accepts command evidence with nonzero exit', () => {
    expect(EvidenceSchema.safeParse(base).success).toBe(true);
  });
  it('accepts browser evidence', () => {
    expect(
      EvidenceSchema.safeParse({
        ...base,
        type: 'browser',
        command: undefined,
        browser: { url: 'https://example.com' },
      }).success,
    ).toBe(true);
  });
  it('accepts static-analysis evidence', () => {
    const v = {
      ...base,
      type: 'static_analysis',
      command: undefined,
      staticAnalysis: { tool: 'tsc', message: 'boom' },
    };
    expect(EvidenceSchema.safeParse(v).success).toBe(true);
  });
  it('rejects negative duration and bad strength', () => {
    expect(
      EvidenceSchema.safeParse({ ...base, command: { command: 'x', exitCode: 0, durationMs: -5 } })
        .success,
    ).toBe(false);
    expect(EvidenceSchema.safeParse({ ...base, strength: 'grade-a' }).success).toBe(false);
  });
  it('documents exit-code semantics: any integer survives (cross-platform)', () => {
    expect(
      EvidenceSchema.safeParse({ ...base, command: { command: 'x', exitCode: 3221225477 } })
        .success,
    ).toBe(true);
  });
});
