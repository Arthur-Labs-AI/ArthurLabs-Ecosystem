import { describe, expect, it } from 'vitest';
import {
  AgentRunSchema,
  DEFAULT_VERIFICATION_LEVEL,
  QARunSchema,
  RunActivitySchema,
  RunExportManifestSchema,
} from '../src/index.js';

const T = '2026-09-09T19:00:00.000Z';
const configuration = {
  agentStackIds: ['stack_muse_main', 'stack_deepseek_main', 'stack_glm_main', 'stack_future_main'],
  verificationLevel: 'strict',
  instructions: { message: 'Exercise authentication flows.', createdAt: T },
  policy: { id: 'qa-standard', version: 1 },
};
const run = {
  schemaVersion: 1,
  id: 'run_01K7777777777777777777A8W3',
  projectId: 'proj_01K7777777777777777777A8W1',
  snapshotId: 'snap_01K7777777777777777777A8W2',
  projectContextSnapshotId: 'ctx_01K7777777777777777777A8WA',
  mode: 'full',
  status: 'created',
  configuration,
  createdAt: T,
};

describe('run, retest, failure, and activity contracts', () => {
  it('supports arbitrary N-agent runs and recommends strict verification explicitly', () => {
    expect(DEFAULT_VERIFICATION_LEVEL).toBe('strict');
    for (const count of [1, 2, 3, 4]) {
      expect(
        QARunSchema.safeParse({
          ...run,
          configuration: {
            ...configuration,
            agentStackIds: configuration.agentStackIds.slice(0, count),
          },
        }).success,
      ).toBe(true);
    }
    expect(
      QARunSchema.safeParse({ ...run, configuration: { ...configuration, agentStackIds: [] } })
        .success,
    ).toBe(false);
  });

  it('requires retest lineage only for retest mode', () => {
    const target = {
      sourceQARunId: 'run_01K7777777777777777777A8WD',
      unifiedIssueId: 'issue_01K7777777777777777777A8WB',
    };
    expect(QARunSchema.safeParse({ ...run, mode: 'retest' }).success).toBe(false);
    expect(QARunSchema.safeParse({ ...run, mode: 'retest', retestTarget: target }).success).toBe(
      true,
    );
    expect(
      QARunSchema.safeParse({
        ...run,
        mode: 'retest',
        retestTarget: target,
        retestResult: {
          outcome: 'partially_fixed',
          evidenceIds: ['ev_01K7777777777777777777A8W9'],
          completedAt: T,
        },
      }).success,
    ).toBe(true);
    expect(QARunSchema.safeParse({ ...run, retestTarget: target }).success).toBe(false);
  });

  it('requires structured failure details for failed, interrupted, and timed-out agents', () => {
    const agent = {
      schemaVersion: 1,
      id: 'arun_01K7777777777777777777A8W4',
      qaRunId: run.id,
      agentStackId: 'stack_muse_main',
      taskType: 'qa',
    };
    expect(AgentRunSchema.safeParse({ ...agent, status: 'planning' }).success).toBe(true);
    expect(AgentRunSchema.safeParse({ ...agent, status: 'interrupted' }).success).toBe(false);
    expect(AgentRunSchema.safeParse({ ...agent, status: 'timed_out' }).success).toBe(false);
    expect(
      AgentRunSchema.safeParse({
        ...agent,
        status: 'interrupted',
        failure: { code: 'TRANSPORT_LOST', message: 'Worker exited unexpectedly' },
      }).success,
    ).toBe(true);
    expect(
      AgentRunSchema.safeParse({
        ...agent,
        status: 'completed',
        failure: { code: 'STALE', message: 'Should not be attached' },
      }).success,
    ).toBe(false);
  });

  it('models root and child activity with ordered timestamps and strict IDs', () => {
    const root = {
      schemaVersion: 1,
      id: 'activity_01K7777777777777777777A8WA',
      qaRunId: run.id,
      source: 'sentry',
      kind: 'run',
      status: 'running',
      title: 'Full QA run',
      startedAt: T,
      artifactIds: [],
    };
    expect(RunActivitySchema.safeParse(root).success).toBe(true);
    expect(
      RunActivitySchema.safeParse({
        ...root,
        id: 'activity_01K7777777777777777777A8WB',
        parentActivityId: root.id,
        agentRunId: 'arun_01K7777777777777777777A8W4',
        source: 'agent',
        kind: 'planning',
      }).success,
    ).toBe(true);
    expect(
      RunActivitySchema.safeParse({
        ...root,
        id: 'activity_01K7777777777777777777A8WB',
        parentActivityId: 'evt_01K7777777777777777777A8WX',
      }).success,
    ).toBe(false);
    expect(
      RunActivitySchema.safeParse({ ...root, id: 'evt_01K7777777777777777777A8WX' }).success,
    ).toBe(false);
    expect(RunActivitySchema.safeParse({ ...root, status: 'completed' }).success).toBe(false);
    expect(RunActivitySchema.safeParse({ ...root, status: 'warning' }).success).toBe(false);
    expect(
      RunActivitySchema.safeParse({ ...root, kind: 'browser', status: 'warning', completedAt: T })
        .success,
    ).toBe(true);
    expect(
      RunActivitySchema.safeParse({
        ...root,
        completedAt: '2026-09-09T18:59:59.000Z',
      }).success,
    ).toBe(false);
  });

  it('prepares versioned log and JSON export manifests without implementing exporters', () => {
    for (const format of ['log', 'json'] as const) {
      expect(
        RunExportManifestSchema.safeParse({
          schemaVersion: 1,
          qaRunId: run.id,
          format,
          artifactId: 'artifact_01K7777777777777777777A8WF',
          createdAt: T,
        }).success,
      ).toBe(true);
    }
  });
});
