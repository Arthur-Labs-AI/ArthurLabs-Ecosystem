import { describe, expect, it } from 'vitest';
import {
  CANONICAL_QA_MODES,
  QAModeSchema,
  QARunSchema,
  TargetSpecSchema,
  targetSpecDigest,
} from '../src/index.js';

const RUN = {
  schemaVersion: 1,
  id: 'run_01K7777777777777777777A8W3',
  projectId: 'proj_01K7777777777777777777A8W1',
  snapshotId: 'snap_01K7777777777777777777A8W2',
  projectContextSnapshotId: 'ctx_01K7777777777777777777A8WA',
  status: 'created',
  configuration: {
    agentStackIds: ['stack_muse_main'],
    verificationLevel: 'strict',
    policy: { id: 'qa-standard', version: 1 },
  },
  createdAt: '2026-09-09T19:00:00.000Z',
} as const;

const SPEC = {
  schemaVersion: 1,
  qaRunId: 'run_01K7777777777777777777A8W3',
  snapshotId: 'snap_01K7777777777777777777A8W2',
  includePaths: ['src/auth'],
  issueIds: [],
  createdAt: '2026-09-09T19:00:00.000Z',
} as const;

describe('Phase 7 canonical QA modes (closure §30-§33)', () => {
  it('accepts canonical execution modes; retest stays a legacy workflow label', () => {
    expect(QAModeSchema.parse('full')).toBe('full');
    expect(QAModeSchema.parse('targeted')).toBe('targeted');
    expect(QAModeSchema.parse('retest')).toBe('retest');
    expect(CANONICAL_QA_MODES).toEqual(['full', 'targeted']);
  });
  it('rejects legacy inferred modes as QAMode', () => {
    for (const mode of ['quick', 'ci', 'verify', 'cicd']) {
      expect(QAModeSchema.safeParse(mode).success).toBe(false);
    }
  });
  it('keeps targeted as a standard QARun mode with lineage support', () => {
    const run = QARunSchema.parse({
      ...RUN,
      mode: 'targeted',
      lineage: { parentRunId: 'run_01K7777777777777777777A8WD' },
    });
    expect(run.mode).toBe('targeted');
    if (run.mode !== 'retest') {
      expect(run.lineage?.parentRunId).toBe('run_01K7777777777777777777A8WD');
    }
  });
  it('keeps historical rows without lineage decoding', () => {
    const run = QARunSchema.parse({ ...RUN, mode: 'full' });
    expect(run.lineage).toBeUndefined();
  });
});

describe('Phase 7 TargetSpec (§9-§10, §77)', () => {
  it('accepts a single-file target (§82)', () => {
    const spec = TargetSpecSchema.parse({ ...SPEC, includePaths: ['src/auth/login.ts'] });
    expect(spec.includePaths).toEqual(['src/auth/login.ts']);
  });
  it('accepts multiple path targets (§82)', () => {
    const spec = TargetSpecSchema.parse({
      ...SPEC,
      includePaths: ['src/auth', 'src/middleware', 'src/payments/api.ts'],
    });
    expect(spec.includePaths).toHaveLength(3);
  });
  it('rejects absolute paths (§10)', () => {
    expect(TargetSpecSchema.safeParse({ ...SPEC, includePaths: ['/etc/passwd'] }).success).toBe(
      false,
    );
    expect(
      TargetSpecSchema.safeParse({ ...SPEC, includePaths: ['C:/Windows/System32'] }).success,
    ).toBe(false);
  });
  it('rejects traversal escapes (§10)', () => {
    expect(TargetSpecSchema.safeParse({ ...SPEC, includePaths: ['../outside'] }).success).toBe(
      false,
    );
    expect(TargetSpecSchema.safeParse({ ...SPEC, includePaths: ['src/../../etc'] }).success).toBe(
      false,
    );
  });
  it('rejects backslash paths', () => {
    expect(TargetSpecSchema.safeParse({ ...SPEC, includePaths: ['src\\auth'] }).success).toBe(
      false,
    );
  });
  it('rejects empty targets and duplicates', () => {
    expect(TargetSpecSchema.safeParse({ ...SPEC, includePaths: [] }).success).toBe(false);
    expect(
      TargetSpecSchema.safeParse({ ...SPEC, includePaths: ['src/auth', 'src/auth'] }).success,
    ).toBe(false);
  });
  it('persists target instructions (§40, §77)', () => {
    const spec = TargetSpecSchema.parse({
      ...SPEC,
      userInstructions: 'Focus on token refresh and expired-token handling',
    });
    expect(spec.userInstructions).toContain('token refresh');
  });
  it('computes a deterministic input digest independent of order', () => {
    const base = {
      issueIds: [] as string[],
      agentStackIds: ['stack_muse_main', 'stack_glm_main'],
      snapshotId: 'snap_01K7777777777777777777A8W2',
      policyId: 'qa-standard',
      policyVersion: 1,
    };
    const a = targetSpecDigest({ ...base, includePaths: ['src/b', 'src/a'] });
    const b = targetSpecDigest({ ...base, includePaths: ['src/a', 'src/b'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
    const c = targetSpecDigest({ ...base, includePaths: ['src/a', 'src/c'] });
    expect(c).not.toBe(a);
  });
});
