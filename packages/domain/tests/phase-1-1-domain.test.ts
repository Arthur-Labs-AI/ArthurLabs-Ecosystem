import { describe, expect, it } from 'vitest';
import {
  AgentInvestigationPlanSchema,
  AgentRunSchema,
  ProjectContextSnapshotSchema,
  ProjectRevisionSchema,
  ProjectSnapshotSchema,
  QARunSchema,
  RunActivitySchema,
  UnifiedIssueSchema,
} from '@qa/schemas';
import {
  aggregateAgentRunOutcome,
  aggregateAgentUsage,
  isAgentRunForQARun,
  isContextForRevision,
  isChildActivityOf,
  isQARunForContext,
  isPlanForAgentRun,
  isQARunForSnapshot,
  isRetestLineageValid,
  isSnapshotForRevision,
} from '../src/index.js';

const T1 = '2026-09-09T19:00:00.000Z';
const T2 = '2026-09-10T19:00:00.000Z';
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const revision = ProjectRevisionSchema.parse({
  schemaVersion: 1,
  id: 'rev_01K7777777777777777777A8W9',
  projectId: 'proj_01K7777777777777777777A8W1',
  sourcePath: 'D:/Projects/Example',
  importedAt: T1,
  contentHash: SHA,
});
const snapshot = ProjectSnapshotSchema.parse({
  schemaVersion: 1,
  id: 'snap_01K7777777777777777777A8W2',
  projectId: revision.projectId,
  projectRevisionId: revision.id,
  createdAt: T1,
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
});
const context = ProjectContextSnapshotSchema.parse({
  schemaVersion: 1,
  id: 'ctx_01K7777777777777777777A8WA',
  projectId: revision.projectId,
  projectRevisionId: revision.id,
  criticalFlows: [],
  businessRules: [],
  constraints: [],
  knownLimitations: [],
  outOfScope: [],
  detectedStack: {},
  createdAt: T1,
});
const configuration = {
  agentStackIds: ['stack_muse_main'],
  verificationLevel: 'strict',
  instructions: { message: 'Investigate fully.', createdAt: T1 },
  policy: { id: 'qa-standard', version: 1 },
};
const sourceRun = QARunSchema.parse({
  schemaVersion: 1,
  id: 'run_01K7777777777777777777A8W3',
  projectId: revision.projectId,
  snapshotId: snapshot.id,
  projectContextSnapshotId: context.id,
  mode: 'full',
  status: 'completed',
  configuration,
  createdAt: T1,
});
const agentRun = AgentRunSchema.parse({
  schemaVersion: 1,
  id: 'arun_01K7777777777777777777A8W4',
  qaRunId: sourceRun.id,
  agentStackId: 'stack_muse_main',
  taskType: 'qa',
  status: 'completed',
});
const plan = AgentInvestigationPlanSchema.parse({
  schemaVersion: 1,
  id: 'plan_01K7777777777777777777A8WB',
  qaRunId: sourceRun.id,
  agentRunId: agentRun.id,
  agentStackId: agentRun.agentStackId,
  projectSnapshotId: snapshot.id,
  projectContextSnapshotId: context.id,
  projectUnderstanding: 'Example service.',
  plannedChecks: ['Run tests'],
  createdAt: T1,
});

describe('Phase 1.1 domain invariants', () => {
  it('checks the lifecycle and run relationship chain by opaque IDs', () => {
    expect(isSnapshotForRevision(snapshot, revision)).toBe(true);
    expect(isContextForRevision(context, revision)).toBe(true);
    expect(isQARunForSnapshot(sourceRun, snapshot)).toBe(true);
    expect(isQARunForContext(sourceRun, context)).toBe(true);
    expect(isAgentRunForQARun(agentRun, sourceRun)).toBe(true);
    expect(isPlanForAgentRun(plan, agentRun, sourceRun)).toBe(true);
    expect(
      isContextForRevision(
        ProjectContextSnapshotSchema.parse({
          ...context,
          projectRevisionId: 'rev_01K7777777777777777777A8WX',
        }),
        revision,
      ),
    ).toBe(false);
    expect(
      isPlanForAgentRun(
        AgentInvestigationPlanSchema.parse({
          ...plan,
          agentRunId: 'arun_01K7777777777777777777A8W5',
        }),
        agentRun,
        sourceRun,
      ),
    ).toBe(false);
    expect(
      isSnapshotForRevision(
        ProjectSnapshotSchema.parse({
          ...snapshot,
          projectRevisionId: 'rev_01K7777777777777777777A8WX',
        }),
        revision,
      ),
    ).toBe(false);
  });

  it('keeps activity hierarchy inside one QARun', () => {
    const parent = RunActivitySchema.parse({
      schemaVersion: 1,
      id: 'activity_01K7777777777777777777A8WA',
      qaRunId: sourceRun.id,
      source: 'sentry',
      kind: 'run',
      status: 'running',
      title: 'Run',
      startedAt: T1,
      artifactIds: [],
    });
    const child = RunActivitySchema.parse({
      ...parent,
      id: 'activity_01K7777777777777777777A8WB',
      parentActivityId: parent.id,
      source: 'agent',
      kind: 'planning',
    });
    expect(isChildActivityOf(child, parent)).toBe(true);
    expect(
      isChildActivityOf(
        RunActivitySchema.parse({ ...child, qaRunId: 'run_01K7777777777777777777A8WX' }),
        parent,
      ),
    ).toBe(false);
  });

  it('validates retest lineage against an earlier issue and run', () => {
    const issue = UnifiedIssueSchema.parse({
      schemaVersion: 1,
      id: 'issue_01K7777777777777777777A8WB',
      qaRunId: sourceRun.id,
      title: 'Issue',
      category: 'logic',
      severity: 'medium',
      status: 'confirmed',
      agreementState: 'single_source',
      findingIds: ['find_01K7777777777777777777A8W7'],
      sourceAgentStackIds: ['stack_muse_main'],
      evidenceIds: [],
      createdAt: T1,
    });
    const retest = QARunSchema.parse({
      ...sourceRun,
      id: 'run_01K7777777777777777777A8WD',
      mode: 'retest',
      status: 'created',
      createdAt: T2,
      retestTarget: { sourceQARunId: sourceRun.id, unifiedIssueId: issue.id },
    });
    expect(isRetestLineageValid(retest, sourceRun, issue)).toBe(true);
    expect(isRetestLineageValid({ ...retest, createdAt: T1 }, sourceRun, issue)).toBe(false);
  });

  it('aggregates partial worker outcomes without treating cancellation as worker failure', () => {
    expect(
      aggregateAgentRunOutcome([
        { status: 'completed', producedUsableOutput: true },
        { status: 'completed', producedUsableOutput: true },
      ]),
    ).toBe('completed');
    expect(
      aggregateAgentRunOutcome([
        { status: 'interrupted', producedUsableOutput: true },
        { status: 'failed', producedUsableOutput: false },
      ]),
    ).toBe('partial');
    expect(
      aggregateAgentRunOutcome([
        { status: 'failed', producedUsableOutput: false },
        { status: 'timed_out', producedUsableOutput: false },
      ]),
    ).toBe('failed');
    expect(() =>
      aggregateAgentRunOutcome([{ status: 'cancelled', producedUsableOutput: false }]),
    ).toThrow(TypeError);
  });

  it('derives token/runtime totals while preserving unknown metrics', () => {
    expect(
      aggregateAgentUsage([
        { inputTokens: 10, outputTokens: 3, turns: 1 },
        { inputTokens: 5, durationMs: 20 },
      ]),
    ).toEqual({ inputTokens: 15, outputTokens: 3, turns: 1, aggregateAgentExecutionMs: 20 });
    expect(aggregateAgentUsage([])).toEqual({});
  });
});
