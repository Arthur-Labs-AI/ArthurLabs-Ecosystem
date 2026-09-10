import { describe, expect, it } from 'vitest';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  ArtifactIdSchema,
  CICDPlanIdSchema,
  EvidenceIdSchema,
  FindingIdSchema,
  FixProposalIdSchema,
  HarnessEventIdSchema,
  ProjectIdSchema,
  QARunIdSchema,
  SnapshotIdSchema,
  UnifiedIssueIdSchema,
  VerificationIdSchema,
} from '../src/index.js';

describe('central ID schemas', () => {
  it.each([
    ['ProjectId', ProjectIdSchema],
    ['SnapshotId', SnapshotIdSchema],
    ['QARunId', QARunIdSchema],
    ['AgentRunId', AgentRunIdSchema],
    ['FindingId', FindingIdSchema],
    ['EvidenceId', EvidenceIdSchema],
    ['UnifiedIssueId', UnifiedIssueIdSchema],
    ['VerificationId', VerificationIdSchema],
    ['FixProposalId', FixProposalIdSchema],
    ['CICDPlanId', CICDPlanIdSchema],
    ['ArtifactId', ArtifactIdSchema],
    ['HarnessEventId', HarnessEventIdSchema],
  ])('rejects malformed %s values', (_label, schema) => {
    expect(schema.safeParse('banana').success).toBe(false);
  });

  it('rejects cross-entity prefixes', () => {
    expect(QARunIdSchema.safeParse('snap_01K7777777777777777777A8W2').success).toBe(false);
    expect(SnapshotIdSchema.safeParse('run_01K7777777777777777777A8W3').success).toBe(false);
    expect(ArtifactIdSchema.safeParse('proj_01K7777777777777777777A8W1').success).toBe(false);
  });

  it('allows deliberate stable human-authored AgentStack IDs only for stacks', () => {
    expect(AgentStackIdSchema.safeParse('stack_future_main').success).toBe(true);
    expect(AgentRunIdSchema.safeParse('arun_future_main').success).toBe(false);
  });
});
