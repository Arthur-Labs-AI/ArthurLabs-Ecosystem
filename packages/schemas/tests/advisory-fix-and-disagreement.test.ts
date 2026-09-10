import { describe, expect, it } from 'vitest';
import { FixProposalSchema, UnifiedIssueSchema } from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';

describe('advisory fixes and visible disagreement', () => {
  it('accepts advice-only fix proposals and rejects application state', () => {
    const proposal = {
      schemaVersion: 1,
      id: 'fix_01K7777777777777777777A8WD',
      qaRunId: 'run_01K7777777777777777777A8W3',
      unifiedIssueId: 'issue_01K7777777777777777777A8WB',
      sourceSnapshotId: 'snap_01K7777777777777777777A8W2',
      generatedByAgentStackId: 'stack_muse_main',
      summary: 'Guard the boundary.',
      rationale: 'The current boundary accepts an invalid state.',
      suggestedChanges: [
        { relativePath: 'src/a.ts', operation: 'modify', description: 'Add validation.' },
      ],
      affectedPaths: ['src/a.ts'],
      suggestedRegressionTests: ['Test invalid state rejection.'],
      createdAt: T,
    };
    expect(FixProposalSchema.safeParse(proposal).success).toBe(true);
    expect(FixProposalSchema.safeParse({ ...proposal, status: 'applied' }).success).toBe(false);
    expect(FixProposalSchema.safeParse({ ...proposal, applyAutomatically: true }).success).toBe(
      false,
    );
  });

  it('preserves disputed agent agreement independently from verification status', () => {
    const issue = {
      schemaVersion: 1,
      id: 'issue_01K7777777777777777777A8WB',
      qaRunId: 'run_01K7777777777777777777A8W3',
      title: 'Disputed issue',
      category: 'logic',
      severity: 'medium',
      agreementState: 'disputed',
      findingIds: ['find_01K7777777777777777777A8W7'],
      sourceAgentStackIds: ['stack_muse_main'],
      evidenceIds: [],
      createdAt: T,
    };
    expect(UnifiedIssueSchema.safeParse({ ...issue, status: 'unverified' }).success).toBe(true);
    expect(UnifiedIssueSchema.safeParse({ ...issue, status: 'confirmed' }).success).toBe(true);
  });
});
