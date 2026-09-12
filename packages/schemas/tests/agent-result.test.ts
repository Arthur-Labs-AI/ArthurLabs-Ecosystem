import { describe, expect, it } from 'vitest';
import {
  describeSentryAgentEvidenceContract,
  QARunSchema,
  SENTRY_AGENT_EVIDENCE_CONTRACT_FIELDS,
  SentryAgentEvidenceV1Schema,
  SentryAgentResultV1Schema,
  SentryInvestigationPlanV1Schema,
} from '../src/index.js';

describe('Phase 3 structured agent contracts', () => {
  it('requires a versioned plan with at least one planned check', () => {
    expect(
      SentryInvestigationPlanV1Schema.safeParse({
        schemaVersion: 1,
        projectUnderstanding: 'x',
        criticalFlows: [],
        weakPoints: [],
        plannedChecks: ['inspect'],
      }).success,
    ).toBe(true);
    expect(
      SentryInvestigationPlanV1Schema.safeParse({
        schemaVersion: 1,
        projectUnderstanding: 'x',
        criticalFlows: [],
        weakPoints: [],
        plannedChecks: [],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate or dangling temporary evidence keys', () => {
    const base = {
      schemaVersion: 1,
      summary: 'summary',
      checks: [],
      hypotheses: [],
      evidence: [
        { key: 'ev1', type: 'manual', strength: 'agent_reasoning', description: 'observation' },
      ],
      findings: [
        {
          title: 'finding',
          category: 'logic',
          severity: 'low',
          confidence: 'probable',
          description: 'description',
          locations: [{ relativePath: 'src/a.ts' }],
          evidenceKeys: ['missing'],
          reproductionSteps: [],
        },
      ],
      limitations: [],
    };
    expect(SentryAgentResultV1Schema.safeParse(base).success).toBe(false);
    expect(
      SentryAgentResultV1Schema.safeParse({
        ...base,
        findings: [],
        evidence: [base.evidence[0], base.evidence[0]],
      }).success,
    ).toBe(false);
  });

  it('requires every production finding to reference evidence', () => {
    const base = {
      schemaVersion: 1,
      summary: 'summary',
      checks: [],
      hypotheses: [],
      evidence: [
        { key: 'ev1', type: 'manual', strength: 'agent_reasoning', description: 'observation' },
      ],
      findings: [
        {
          title: 'finding',
          category: 'logic',
          severity: 'low',
          confidence: 'probable',
          description: 'description',
          locations: [{ relativePath: 'src/a.ts' }],
          evidenceKeys: [],
          reproductionSteps: [],
        },
      ],
      limitations: [],
    };
    expect(SentryAgentResultV1Schema.safeParse(base).success).toBe(false);
    expect(
      SentryAgentResultV1Schema.safeParse({
        ...base,
        findings: [{ ...base.findings[0], evidenceKeys: ['ev1'] }],
      }).success,
    ).toBe(true);
  });

  it('rejects confirmed findings backed only by manual reasoning', () => {
    const base = {
      schemaVersion: 1,
      summary: 'summary',
      checks: [],
      hypotheses: [],
      evidence: [{ key: 'ev1', type: 'manual', strength: 'agent_reasoning', description: 'hunch' }],
      findings: [
        {
          title: 'finding',
          category: 'logic',
          severity: 'low',
          confidence: 'confirmed',
          description: 'description',
          locations: [{ relativePath: 'src/a.ts' }],
          evidenceKeys: ['ev1'],
          reproductionSteps: [],
        },
      ],
      limitations: [],
    };
    expect(SentryAgentResultV1Schema.safeParse(base).success).toBe(false);
    expect(
      SentryAgentResultV1Schema.safeParse({
        ...base,
        evidence: [
          {
            key: 'ev1',
            type: 'code_reference',
            strength: 'strong_code_evidence',
            description: 'observed',
            relativePath: 'src/a.ts',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects strong findings backed only by manual reasoning', () => {
    const base = {
      schemaVersion: 1,
      summary: 'summary',
      checks: [],
      hypotheses: [],
      evidence: [{ key: 'ev1', type: 'manual', strength: 'agent_reasoning', description: 'hunch' }],
      findings: [
        {
          title: 'finding',
          category: 'logic',
          severity: 'low',
          confidence: 'strong',
          description: 'description',
          locations: [{ relativePath: 'src/a.ts' }],
          evidenceKeys: ['ev1'],
          reproductionSteps: [],
        },
      ],
      limitations: [],
    };
    expect(SentryAgentResultV1Schema.safeParse(base).success).toBe(false);
  });

  it('accepts operation-correlated evidence keys on the agent contract', () => {
    const result = {
      schemaVersion: 1,
      summary: 'summary',
      checks: [],
      hypotheses: [],
      evidence: [
        {
          key: 't1',
          type: 'test',
          strength: 'reproduced_failure',
          description: 'suite failed',
          framework: 'vitest',
          name: 'suite',
          status: 'failed',
          operationKey: 'op_1',
        },
      ],
      findings: [],
      limitations: [],
    };
    expect(SentryAgentResultV1Schema.safeParse(result).success).toBe(true);
    expect(
      SentryAgentResultV1Schema.safeParse({
        ...result,
        evidence: [{ ...result.evidence[0], operationKey: 'bad key!' }],
      }).success,
    ).toBe(false);
  });

  it('keeps the prompt contract consistent with the parser schema', () => {
    // Every field the parser accepts must appear in the prompt description:
    // if the contract gains a field without updating the description, the
    // describer throws and this test fails.
    const shapeKeys = Object.keys(SentryAgentEvidenceV1Schema.innerType().shape);
    expect([...SENTRY_AGENT_EVIDENCE_CONTRACT_FIELDS].sort()).toEqual(shapeKeys.sort());
    const description = describeSentryAgentEvidenceContract();
    for (const field of [
      'operationKey',
      'relativePath',
      'lineStart',
      'lineEnd',
      'command',
      'exitCode',
      'framework',
      'name',
      'status',
      'source',
    ] as const) {
      expect(description).toContain(field);
    }
  });

  it('keeps pre-Phase-3 persisted runs readable while accepting canonical execution kind', () => {
    const legacy = {
      schemaVersion: 1,
      id: 'run_01K7777777777777777777A8W3',
      projectId: 'proj_01K7777777777777777777A8W1',
      snapshotId: 'snap_01K7777777777777777777A8W2',
      projectContextSnapshotId: 'ctx_01K7777777777777777777A8W8',
      mode: 'full',
      status: 'created',
      configuration: {
        agentStackIds: ['stack_muse_main'],
        verificationLevel: 'strict',
        policy: { id: 'qa-standard', version: 1 },
      },
      createdAt: '2026-09-11T00:00:00.000Z',
    };
    expect(QARunSchema.safeParse(legacy).success).toBe(true);
    expect(QARunSchema.safeParse({ ...legacy, executionKind: 'production' }).success).toBe(true);
  });
});
