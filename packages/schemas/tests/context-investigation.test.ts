import { describe, expect, it } from 'vitest';
import {
  AgentInvestigationPlanSchema,
  EmergentHypothesisSchema,
  ProjectContextSnapshotSchema,
  RunInstructionsSchema,
} from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const context = {
  schemaVersion: 1,
  id: 'ctx_01K7777777777777777777A8WA',
  projectId: 'proj_01K7777777777777777777A8W1',
  projectRevisionId: 'rev_01K7777777777777777777A8W9',
  purpose: 'Full QA baseline',
  architectureSummary: 'A local TypeScript service.',
  criticalFlows: [
    {
      name: 'Session validation',
      description: 'Checks active user sessions.',
      entryPoints: ['src/auth/session.ts'],
      sources: [{ kind: 'source', relativePath: 'src/auth/session.ts' }],
    },
  ],
  businessRules: [
    {
      statement: 'Sessions expire after the configured TTL.',
      sources: [{ kind: 'documentation', relativePath: 'README.md' }],
    },
  ],
  constraints: [],
  knownLimitations: [],
  outOfScope: [],
  detectedStack: {
    languages: ['TypeScript'],
    frameworks: [],
    packageManagers: ['pnpm'],
    testFrameworks: ['vitest'],
    sources: [{ kind: 'configuration', relativePath: 'package.json' }],
  },
  createdAt: T,
};

const plan = {
  schemaVersion: 1,
  id: 'plan_01K7777777777777777777A8WB',
  qaRunId: 'run_01K7777777777777777777A8W3',
  agentRunId: 'arun_01K7777777777777777777A8W4',
  agentStackId: 'stack_muse_main',
  projectSnapshotId: 'snap_01K7777777777777777777A8W2',
  projectContextSnapshotId: context.id,
  projectUnderstanding: 'Sessions are validated in the auth boundary.',
  criticalFlows: ['Session validation'],
  weakPoints: ['Expiry comparison'],
  plannedChecks: ['Run the auth tests', 'Inspect TTL enforcement'],
  createdAt: T,
};

describe('context and independent investigation contracts', () => {
  it('preserves contextual facts with explicit provenance', () => {
    expect(ProjectContextSnapshotSchema.safeParse(context).success).toBe(true);
    expect(
      ProjectContextSnapshotSchema.safeParse({
        ...context,
        businessRules: [
          { statement: 'Bad path', sources: [{ kind: 'source', relativePath: 'C:/secret.ts' }] },
        ],
      }).success,
    ).toBe(false);
    expect(ProjectContextSnapshotSchema.safeParse({ ...context, surprise: true }).success).toBe(
      false,
    );
  });

  it('keeps instructions strict, bounded, and run-scoped as an embedded value', () => {
    expect(
      RunInstructionsSchema.safeParse({ message: 'Focus on expiry.', createdAt: T }).success,
    ).toBe(true);
    expect(
      RunInstructionsSchema.safeParse({ message: 'x'.repeat(50_001), createdAt: T }).success,
    ).toBe(false);
    expect(
      RunInstructionsSchema.safeParse({ message: 'Focus.', createdAt: T, mutatesContext: true })
        .success,
    ).toBe(false);
  });

  it('accepts an initial plan and rejects priority-based skipping fields', () => {
    expect(
      AgentInvestigationPlanSchema.safeParse({
        ...plan,
        criticalFlows: ['Session validation', 'Login'],
        weakPoints: ['Expiry comparison', 'Clock boundary'],
      }).success,
    ).toBe(true);
    expect(AgentInvestigationPlanSchema.safeParse({ ...plan, priority: 'high' }).success).toBe(
      false,
    );
    expect(AgentInvestigationPlanSchema.safeParse({ ...plan, plannedChecks: [] }).success).toBe(
      false,
    );
    expect(
      AgentInvestigationPlanSchema.safeParse({ ...plan, emergentHypotheses: [] }).success,
    ).toBe(false);
  });

  it('models emergent hypotheses separately from the immutable initial plan', () => {
    expect(
      EmergentHypothesisSchema.safeParse({
        schemaVersion: 1,
        id: 'hyp_01K7777777777777777777A8WC',
        qaRunId: plan.qaRunId,
        agentRunId: plan.agentRunId,
        title: 'TTL is parsed but not enforced',
        rationale: 'The configuration is read but never compared.',
        relatedPaths: ['src/auth/session.ts'],
        plannedChecks: ['Trace the parsed value'],
        discoveredAt: T,
      }).success,
    ).toBe(true);
  });
});
