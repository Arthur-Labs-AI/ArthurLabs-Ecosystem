import { describe, expect, it } from 'vitest';
import { assertRetestRunTransition, canTransitionRetestRun, classifyRetest } from '../src/index.js';
import {
  IssueEventSchema,
  IssueOccurrenceSchema,
  IssueSchema,
  RetestAssessmentSchema,
  RetestRunSchema,
  RetestSpecSchema,
  projectIssueState,
  retestInputDigest,
} from '@qa/schemas';

const ISSUE = {
  schemaVersion: 1,
  id: 'issue_01K7777777777777777777B8W1',
  projectId: 'proj_01K7777777777777777777A8W1',
  title: 'Divide bug',
  category: 'logic',
  severity: 'high',
  createdAt: '2026-09-09T19:00:00.000Z',
  updatedAt: '2026-09-09T19:00:00.000Z',
} as const;

const OCCURRENCE = {
  schemaVersion: 1,
  id: 'occ_01K7777777777777777777B8W2',
  issueId: 'issue_01K7777777777777777777B8W1',
  projectId: 'proj_01K7777777777777777777A8W1',
  projectRevisionId: 'rev_01K7777777777777777777A8W9',
  projectSnapshotId: 'snap_01K7777777777777777777A8W2',
  qaRunId: 'run_01K7777777777777777777A8W3',
  mergeResultId: 'merge_01K7777777777777777777B8WA',
  findingClusterId: 'cluster_01K7777777777777777777B8WB',
  createdAt: '2026-09-09T19:00:00.000Z',
} as const;

describe('Phase 7 retest classifier (§18-§22, §84-§87)', () => {
  it('fixed: same target test failed on A, passes on B (§84)', () => {
    expect(
      classifyRetest({
        targetNotObservable: false,
        assertions: [
          { assertionId: 'target-test-A', reproducesOnTarget: false, passesOnTarget: true },
        ],
      }).result,
    ).toBe('fixed');
  });
  it('still_reproducible: same target and failure identity on B (§85)', () => {
    expect(
      classifyRetest({
        targetNotObservable: false,
        assertions: [
          { assertionId: 'target-test-A', reproducesOnTarget: true, passesOnTarget: false },
        ],
      }).result,
    ).toBe('still_reproducible');
  });
  it('partially_fixed: A fixed, B still reproduces (§86)', () => {
    expect(
      classifyRetest({
        targetNotObservable: false,
        assertions: [
          { assertionId: 'A', reproducesOnTarget: false, passesOnTarget: true },
          { assertionId: 'B', reproducesOnTarget: true, passesOnTarget: false },
        ],
      }).result,
    ).toBe('partially_fixed');
  });
  it('inconclusive: target environment cannot run (§87)', () => {
    expect(
      classifyRetest({
        targetNotObservable: true,
        assertions: [{ assertionId: 'A', reproducesOnTarget: false, passesOnTarget: true }],
      }).result,
    ).toBe('inconclusive');
  });
  it('silence never means fixed (§19): no assertions → inconclusive', () => {
    expect(classifyRetest({ targetNotObservable: false, assertions: [] }).result).toBe(
      'inconclusive',
    );
  });
  it('missing decisive evidence on one assertion → inconclusive, never fixed', () => {
    expect(
      classifyRetest({
        targetNotObservable: false,
        assertions: [
          { assertionId: 'A', reproducesOnTarget: false, passesOnTarget: true },
          { assertionId: 'B', reproducesOnTarget: false, passesOnTarget: false },
        ],
      }).result,
    ).toBe('inconclusive');
  });
});

describe('Phase 7 RetestSpec v2 (closure §34-§39)', () => {
  const SPEC = {
    schemaVersion: 1,
    retestRunId: 'retest_01K7777777777777777777B8WD',
    issueId: 'issue_01K7777777777777777777B8W1',
    sourceOccurrenceId: 'occ_01K7777777777777777777B8W2',
    sourceSnapshotId: 'snap_01K7777777777777777777A8W2',
    targetSnapshotId: 'snap_01K7777777777777777777B8WC',
    sourceMergeResultId: 'merge_01K7777777777777777777B8WA',
    sourceFindingClusterId: 'cluster_01K7777777777777777777B8WB',
    sourceRevisionId: 'rev_01K7777777777777777777A8W9',
    targetRevisionId: 'rev_01K7777777777777777777B8WE',
    agentStackIds: ['stack_muse_main'],
    historicalPaths: ['src/auth/legacy-token.ts'],
    resolvedTargetPaths: ['src/auth'],
    resolutionStrategy: 'nearest_ancestor',
    recipeVersion: 3,
    retestVersion: 2,
    inputDigest: retestInputDigest({
      issueId: 'issue_01K7777777777777777777B8W1',
      sourceOccurrenceId: 'occ_01K7777777777777777777B8W2',
      sourceSnapshotId: 'snap_01K7777777777777777777A8W2',
      targetSnapshotId: 'snap_01K7777777777777777777B8WC',
      agentStackIds: ['stack_muse_main'],
      recipeVersion: 3,
      sourceRevisionId: 'rev_01K7777777777777777777A8W9',
      targetRevisionId: 'rev_01K7777777777777777777B8WE',
      sourceMergeResultId: 'merge_01K7777777777777777777B8WA',
      sourceFindingClusterId: 'cluster_01K7777777777777777777B8WB',
      resolvedTargetPaths: ['src/auth'],
      retestVersion: 2,
    }),
    createdAt: '2026-09-18T00:00:00.000Z',
  } as const;
  it('accepts a cross-revision spec with distinct snapshots', () => {
    const spec = RetestSpecSchema.parse(SPEC);
    expect(spec.targetSnapshotId).not.toBe(spec.sourceSnapshotId);
  });
  it('rejects identical source and target snapshots (§15)', () => {
    expect(
      RetestSpecSchema.safeParse({
        ...SPEC,
        targetSnapshotId: 'snap_01K7777777777777777777A8W2',
      }).success,
    ).toBe(false);
  });
  it('computes a deterministic retest input digest', () => {
    const base = {
      issueId: 'issue_01K7777777777777777777B8W1',
      sourceOccurrenceId: 'occ_01K7777777777777777777B8W2',
      sourceSnapshotId: 'snap_01K7777777777777777777A8W2',
      targetSnapshotId: 'snap_01K7777777777777777777B8WC',
      recipeVersion: 3,
    };
    const a = retestInputDigest({ ...base, agentStackIds: ['stack_muse_main', 'stack_glm_main'] });
    const b = retestInputDigest({ ...base, agentStackIds: ['stack_glm_main', 'stack_muse_main'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('Phase 7 RetestRun lifecycle', () => {
  const RUN = {
    schemaVersion: 1,
    id: 'retest_01K7777777777777777777B8WD',
    retestVersion: 2,
    projectId: 'proj_01K7777777777777777777A8W1',
    issueId: 'issue_01K7777777777777777777B8W1',
    sourceProjectRevisionId: 'rev_01K7777777777777777777A8W9',
    targetProjectRevisionId: 'rev_01K7777777777777777777B8WE',
    sourceSnapshotId: 'snap_01K7777777777777777777A8W2',
    targetSnapshotId: 'snap_01K7777777777777777777B8WC',
    sourceQaRunId: 'run_01K7777777777777777777A8W3',
    sourceMergeResultId: 'merge_01K7777777777777777777B8WA',
    sourceFindingClusterId: 'cluster_01K7777777777777777777B8WB',
    agentStackIds: ['stack_muse_main', 'stack_deepseek_main', 'stack_glm_main'],
    status: 'created',
    createdAt: '2026-09-09T19:00:00.000Z',
  } as const;
  it('parses and enforces cross-revision identity', () => {
    expect(RetestRunSchema.parse(RUN).status).toBe('created');
    expect(
      RetestRunSchema.safeParse({ ...RUN, targetSnapshotId: RUN.sourceSnapshotId }).success,
    ).toBe(false);
  });
  it('advances created → agents_running → merging → assessing → completed', () => {
    expect(canTransitionRetestRun('created', 'agents_running')).toBe(true);
    expect(canTransitionRetestRun('agents_running', 'merging')).toBe(true);
    expect(canTransitionRetestRun('merging', 'assessing')).toBe(true);
    expect(canTransitionRetestRun('assessing', 'completed')).toBe(true);
    expect(canTransitionRetestRun('created', 'completed')).toBe(false);
    expect(() => assertRetestRunTransition('created', 'completed')).toThrow();
  });
  it('supports cancellation and interruption from active states (§46)', () => {
    expect(canTransitionRetestRun('agents_running', 'cancelled')).toBe(true);
    expect(canTransitionRetestRun('merging', 'interrupted')).toBe(true);
    expect(canTransitionRetestRun('completed', 'cancelled')).toBe(false);
  });
  it('parses a deterministic assessment record', () => {
    const assessment = RetestAssessmentSchema.parse({
      schemaVersion: 1,
      id: 'reassess_01K7777777777777777777B8WF',
      retestVersion: 2,
      retestRunId: 'retest_01K7777777777777777777B8WD',
      issueId: 'issue_01K7777777777777777777B8W1',
      projectId: 'proj_01K7777777777777777777A8W1',
      sourceRevisionId: 'rev_01K7777777777777777777A8W9',
      targetRevisionId: 'rev_01K7777777777777777777B8WE',
      sourceOccurrenceId: 'occ_01K7777777777777777777B8W2',
      targetQaRunId: 'run_01K7777777777777777777B8WG',
      targetMergeResultId: 'merge_01K7777777777777777777B8WH',
      newEvidenceIds: [],
      result: 'fixed',
      rationale: 'Target test passes under compatible replay on revision B.',
      assessedAt: '2026-09-10T19:00:00.000Z',
    });
    expect(assessment.result).toBe('fixed');
  });
  it('accepts an honest assessment with absent target merge (closure §28)', () => {
    const assessment = RetestAssessmentSchema.parse({
      schemaVersion: 1,
      id: 'reassess_01K7777777777777777777B8WF',
      retestVersion: 2,
      retestRunId: 'retest_01K7777777777777777777B8WD',
      issueId: 'issue_01K7777777777777777777B8W1',
      projectId: 'proj_01K7777777777777777777A8W1',
      sourceRevisionId: 'rev_01K7777777777777777777A8W9',
      targetRevisionId: 'rev_01K7777777777777777777B8WE',
      sourceOccurrenceId: 'occ_01K7777777777777777777B8W2',
      sourceMergeResultId: 'merge_01K7777777777777777777B8WA',
      targetQaRunId: 'run_01K7777777777777777777B8WG',
      newEvidenceIds: [],
      result: 'inconclusive',
      rationale: 'Target merge failed.',
      limitations: ['Target merge failed: boom'],
      assessedAt: '2026-09-10T19:00:00.000Z',
    });
    expect(assessment.targetMergeResultId).toBeUndefined();
  });
});

describe('Phase 7 issue history (§35-§36, §88-§89)', () => {
  it('creates issues and occurrences with stable ids', () => {
    expect(IssueSchema.parse(ISSUE).id).toBe('issue_01K7777777777777777777B8W1');
    expect(IssueOccurrenceSchema.parse(OCCURRENCE).issueId).toBe(ISSUE.id);
  });
  it('projects A open → B still_reproducible → C fixed (§88)', () => {
    const at = (n: string, to: 'open' | 'still_reproducible' | 'fixed') =>
      IssueEventSchema.parse({
        schemaVersion: 1,
        id: n,
        issueId: ISSUE.id,
        projectId: ISSUE.projectId,
        kind: n.endsWith('1') ? 'created' : 'retest_assessed',
        ...(n.endsWith('1') ? {} : { retestAssessmentId: 'reassess_01K7777777777777777777B8WF' }),
        toState: to,
        message: 'state ' + to,
        createdAt: '2026-09-09T19:00:00.000Z',
      });
    const events = [
      at('iev_01K7777777777777777777B8W1', 'open'),
      at('iev_01K7777777777777777777B8W2', 'still_reproducible'),
      at('iev_01K7777777777777777777B8W3', 'fixed'),
    ];
    expect(projectIssueState(events)).toBe('fixed');
    expect(projectIssueState(events.slice(0, 2))).toBe('still_reproducible');
    expect(projectIssueState([])).toBe('open');
  });
  it('reopens fixed → still_reproducible on regression (§89)', () => {
    const mk = (
      n: string,
      to: 'fixed' | 'still_reproducible',
      kind: 'created' | 'retest_assessed',
    ) =>
      IssueEventSchema.parse({
        schemaVersion: 1,
        id: n,
        issueId: ISSUE.id,
        projectId: ISSUE.projectId,
        kind,
        ...(kind === 'created'
          ? {}
          : {
              fromState: 'fixed' as const,
              retestAssessmentId: 'reassess_01K7777777777777777777B8WF',
            }),
        toState: to,
        message: 'state ' + to,
        createdAt: '2026-09-09T19:00:00.000Z',
      });
    expect(
      projectIssueState([
        mk('iev_01K7777777777777777777B8W1', 'fixed', 'created'),
        mk('iev_01K7777777777777777777B8W2', 'still_reproducible', 'retest_assessed'),
      ]),
    ).toBe('still_reproducible');
  });
});
