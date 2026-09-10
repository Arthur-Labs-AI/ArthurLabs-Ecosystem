import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_STATUSES,
  AGENT_TASK_TYPES,
  AgentRunSchema,
  AgentStackDefinitionSchema,
  AgentUsageSchema,
  EvidenceSchema,
  QARUN_MODES,
  ProjectSnapshotSchema,
  UnifiedIssueSchema,
} from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('Phase 1.1 contract corrections', () => {
  it('removes fix execution modes while adding retest and interruption states', () => {
    expect(QARUN_MODES).not.toContain('fix');
    expect(QARUN_MODES).toContain('retest');
    expect(AGENT_TASK_TYPES).not.toContain('fix');
    expect(AGENT_TASK_TYPES).toContain('retest');
    expect(AGENT_RUN_STATUSES).toContain('planning');
    expect(AGENT_RUN_STATUSES).toContain('interrupted');
  });

  it('rejects monetary usage and turn/token budget fields', () => {
    expect(AgentUsageSchema.safeParse({ estimatedCostUsd: 0.25 }).success).toBe(false);
    expect(AgentUsageSchema.safeParse({ providerReportedCostUsd: 0.25 }).success).toBe(false);

    const stack = {
      schemaVersion: 1,
      id: 'stack_muse_main',
      displayName: 'Muse QA Agent',
      enabled: true,
      model: { provider: 'meta', modelId: 'muse-1.3' },
      harness: { adapterId: 'muse-code', expectedProtocolVersion: 1 },
      execution: {},
      policy: { id: 'qa-standard', version: 1 },
    };
    expect(
      AgentStackDefinitionSchema.safeParse({ ...stack, executionSafeguards: { maxTurns: 5 } })
        .success,
    ).toBe(false);
    expect(
      AgentStackDefinitionSchema.safeParse({
        ...stack,
        executionSafeguards: { runTimeoutMs: 60_000, commandTimeoutMs: 10_000 },
      }).success,
    ).toBe(true);
  });

  it('requires snapshots to identify their immutable project revision', () => {
    const snapshot = {
      schemaVersion: 1,
      id: 'snap_01K7777777777777777777A8W2',
      projectId: 'proj_01K7777777777777777777A8W1',
      createdAt: T,
      sourceState: {},
      manifest: {
        entryCount: 0,
        fileCount: 0,
        directoryCount: 0,
        symlinkCount: 0,
        totalBytes: 0,
        artifactId: 'artifact_01K7777777777777777777A8WE',
      },
      contentHash: SHA,
    };
    expect(ProjectSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(
      ProjectSnapshotSchema.safeParse({
        ...snapshot,
        projectRevisionId: 'rev_01K7777777777777777777A8W9',
      }).success,
    ).toBe(true);
  });

  it('requires structured failure details for timed-out agent runs', () => {
    const run = {
      schemaVersion: 1,
      id: 'arun_01K7777777777777777777A8W4',
      qaRunId: 'run_01K7777777777777777777A8W3',
      agentStackId: 'stack_muse_main',
      taskType: 'qa',
      status: 'timed_out',
    };
    expect(AgentRunSchema.safeParse(run).success).toBe(false);
    expect(
      AgentRunSchema.safeParse({
        ...run,
        failure: {
          code: 'RUN_TIMEOUT',
          message: 'Agent exceeded configured run timeout.',
          retryable: true,
        },
      }).success,
    ).toBe(true);
  });

  it('requires evidence environment provenance and issue agreement state', () => {
    const evidence = {
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W8',
      qaRunId: 'run_01K7777777777777777777A8W3',
      strength: 'agent_reasoning',
      type: 'manual',
      manual: { summary: 'Observed behavior' },
      artifactIds: [],
      createdAt: T,
    };
    expect(EvidenceSchema.safeParse(evidence).success).toBe(false);
    expect(EvidenceSchema.safeParse({ ...evidence, environmentState: 'baseline' }).success).toBe(
      true,
    );

    const issue = {
      schemaVersion: 1,
      id: 'issue_01K7777777777777777777A8W9',
      qaRunId: 'run_01K7777777777777777777A8W3',
      title: 'Issue',
      category: 'logic',
      severity: 'medium',
      status: 'probable',
      findingIds: ['find_01K7777777777777777777A8W7'],
      sourceAgentStackIds: ['stack_muse_main'],
      evidenceIds: [],
      createdAt: T,
    };
    expect(UnifiedIssueSchema.safeParse(issue).success).toBe(false);
    expect(
      UnifiedIssueSchema.safeParse({ ...issue, agreementState: 'single_source' }).success,
    ).toBe(true);
  });
});
