/** Phase 7 cross-revision Retest orchestration (§14–§27, §90).
 *
 *  Canonical flow: Issue occurrence on revision A → developer updates the
 *  managed project (new ProjectRevision B) → `retestIssue` freezes
 *  snapshot B through the standard RunCoordinator path (never the mutable
 *  working directory, never snapshot A), merges, verifies with the frozen
 *  Verifier v3 primitives, then records a deterministic RetestAssessment.
 *
 *  The verdict compares BEHAVIOR via exact ID-free replay intent
 *  (`compareRetestSteps`): source steps that strongly confirmed failure on
 *  A against target steps freshly observed on B. Agent consensus alone
 *  never decides; silence never means fixed.
 */
import {
  createIssueEventId,
  createIssueOccurrenceId,
  createRetestAssessmentId,
  createRetestRunId,
  nowIsoTimestamp,
  type AgentStackId,
  type ProjectId,
  type ProjectRevisionId,
  type QARunId,
} from '@qa/shared';
import {
  IssueEventSchema,
  IssueOccurrenceSchema,
  RetestAssessmentSchema,
  RetestRunSchema,
  RETEST_VERSION,
  issueIngestKey,
  projectIssueState,
  type Finding,
  type Issue,
  type IssueOccurrence,
  type MergeResult,
  type QARun,
  type RetestAssessment,
  type RetestRun,
  type VerificationRun,
  type VerificationRunAttempt,
} from '@qa/schemas';
import {
  assertRetestRunTransition,
  classifyRetest,
  compareRetestSteps,
  retestStepKey,
} from '@qa/domain';
import { RuntimeInstanceLease, type SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import type { HarnessAdapterRegistry } from '@qa/harness-protocol';
import { RunCoordinator } from './index.js';
import { mergeRun } from './merge-service.js';
import { verifyMerge } from './verification-service.js';
import { RunEngineError } from './errors.js';

export interface RetestIssueOptions {
  readonly agentStackIds?: readonly AgentStackId[];
  /** Default: current ready ProjectRevision (§41). Frozen into a new snapshot. */
  readonly targetRevisionId?: ProjectRevisionId;
  readonly runTimeoutMs?: number;
  readonly onHarnessRequest?: (request: import('@qa/schemas').HarnessRunRequest) => void;
  readonly onHarnessEventPersisted?: (
    event: import('@qa/schemas').HarnessEvent,
    agentRun: import('@qa/schemas').AgentRun,
  ) => void;
  /** Test seam: override target verification. Production always uses verifyMerge. */
  readonly verify?: typeof verifyMerge;
}

export interface RetestIssueResult {
  readonly retestRun: RetestRun;
  readonly assessment: RetestAssessment;
  readonly targetRun: QARun;
  readonly targetMerge?: MergeResult;
  readonly targetVerification?: VerificationRun;
  readonly targetOccurrence?: IssueOccurrence;
}

export interface RetestServiceDeps {
  readonly dataRoot: string;
  readonly repository: SentryRepository;
  readonly lease: RuntimeInstanceLease;
  readonly registry: HarnessAdapterRegistry;
}

function latestOccurrence(occurrences: readonly IssueOccurrence[]): IssueOccurrence {
  const sorted = [...occurrences].sort((a, b) => (a.id < b.id ? -1 : 1));
  const latest = sorted[sorted.length - 1];
  if (latest === undefined) throw new RunEngineError('RUN_NOT_FOUND', 'Issue has no occurrences');
  return latest;
}

function retestMissionText(input: {
  readonly issue: Issue;
  readonly finding: Finding;
  readonly sourceRevisionId: string;
  readonly priorOutcome: string | undefined;
}): string {
  return (
    'RETEST MISSION. Re-examine this previously known issue on the current revision: ' +
    input.issue.title +
    ' (' +
    input.issue.severity +
    ' ' +
    input.issue.category +
    '). ' +
    'Originally observed: ' +
    input.finding.description +
    ' ' +
    'Locations: ' +
    input.finding.locations.map((location) => location.relativePath).join(', ') +
    '. ' +
    (input.finding.reproductionSteps.length === 0
      ? ''
      : 'Reproduction: ' + input.finding.reproductionSteps.join(' | ') + '. ') +
    'Prior verification on revision ' +
    input.sourceRevisionId +
    ': ' +
    (input.priorOutcome ?? 'unknown') +
    '. ' +
    'Focus: does this issue still exist? did the fix move the problem? is behavior partially ' +
    'corrected? did the change introduce a direct regression around this issue? ' +
    'Do not turn this into an unrelated repository-wide scan; directly related regressions ' +
    'may be reported.'
  );
}

export async function retestIssue(
  deps: RetestServiceDeps,
  issueId: string,
  options: RetestIssueOptions = {},
): Promise<RetestIssueResult> {
  deps.lease.assertHealthy();
  const { repository, dataRoot } = deps;
  const issue = repository.getIssue(issueId);
  if (issue === undefined)
    throw new RunEngineError('ISSUE_NOT_FOUND', 'Issue not found: ' + issueId);
  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: deps.lease });
  const record = projects.getProject(issue.projectId as ProjectId);
  if (record === undefined)
    throw new RunEngineError('PROJECT_NOT_FOUND', 'Project not found: ' + issue.projectId);
  const occurrences = repository.listIssueOccurrences(issue.id);
  for (const occurrence of occurrences) {
    if (occurrence.projectId !== issue.projectId) {
      throw new RunEngineError(
        'ISSUE_CONFLICT',
        'Issue occurrence crosses projects: ' + occurrence.id,
      );
    }
  }
  if (occurrences.length === 0)
    throw new RunEngineError('RUN_NOT_FOUND', 'Issue has no occurrences: ' + issue.id);
  const source = latestOccurrence(occurrences);
  const sourceMerge = repository.getMergeResult(source.mergeResultId);
  if (sourceMerge === undefined)
    throw new RunEngineError(
      'RUN_NOT_FOUND',
      'Source MergeResult not found: ' + source.mergeResultId,
    );
  const sourceSnapshot = repository.getSnapshot(source.projectSnapshotId as never);
  if (sourceSnapshot === undefined)
    throw new RunEngineError(
      'RUN_NOT_FOUND',
      'Source snapshot not found: ' + source.projectSnapshotId,
    );
  const sourceRevisionId = sourceSnapshot.projectRevisionId;
  const targetRevisionId = options.targetRevisionId ?? record.revision.id;
  if (!/^rev_[0-9A-HJKMNP-TV-Z]{26}$/.test(targetRevisionId)) {
    throw new RunEngineError('INVALID_TARGET', 'Malformed revision id: ' + targetRevisionId);
  }
  if (targetRevisionId === sourceRevisionId) {
    throw new RunEngineError(
      'INVALID_TARGET',
      'Retest target revision must differ from the source revision ' + sourceRevisionId,
    );
  }
  const targetRevision = repository.getRevision(targetRevisionId);
  if (targetRevision === undefined || targetRevision.projectId !== issue.projectId) {
    throw new RunEngineError(
      'ISSUE_CONFLICT',
      "Target revision is not part of this issue's project",
    );
  }
  // The working copy must actually be at the target revision: retest
  // freezes B through the standard snapshot path, never by assumption.
  const integrity = await projects.assertWorkingCopyIntegrity(record.project.id);
  if (integrity.id !== targetRevisionId) {
    throw new RunEngineError(
      'PROJECT_COPY_DRIFT',
      'Working copy is at ' + integrity.id + ', not the retest target ' + targetRevisionId,
    );
  }
  const sourceCluster = repository
    .listClusters(sourceMerge.id)
    .find((cluster) => cluster.id === source.findingClusterId);
  if (sourceCluster === undefined)
    throw new RunEngineError(
      'RUN_NOT_FOUND',
      'Source cluster not found: ' + source.findingClusterId,
    );
  const findingsById = new Map(
    repository.listFindings(source.qaRunId as QARunId).map((finding) => [finding.id, finding]),
  );
  const representative = findingsById.get(sourceCluster.representativeFindingId);
  if (representative === undefined)
    throw new RunEngineError('RUN_NOT_FOUND', 'Representative finding not found');
  // Source baseline: persisted steps of the completed verification attempt
  // for the source cluster (same snapshot-A semantics, never reinterpreted).
  const sourceSteps = loadSourceBaselineSteps(repository, source, sourceMerge.id);
  const createdAt = nowIsoTimestamp();
  // The retest row is staged BEFORE the target freeze at status created
  // (no target snapshot yet — honest, since no target work has started),
  // then advanced as the pipeline proceeds. A crash before the freeze
  // leaves a created row recovery can honestly interrupt.
  let retestRun = RetestRunSchema.parse({
    schemaVersion: 1,
    id: createRetestRunId(),
    retestVersion: RETEST_VERSION,
    projectId: issue.projectId,
    issueId: issue.id,
    sourceProjectRevisionId: sourceRevisionId,
    targetProjectRevisionId: targetRevisionId,
    sourceSnapshotId: source.projectSnapshotId,
    sourceQaRunId: source.qaRunId,
    sourceMergeResultId: sourceMerge.id,
    sourceFindingClusterId: sourceCluster.id,
    agentStackIds: options.agentStackIds ?? deps.registry.list().map((item) => item.stack.id),
    status: 'created',
    runtimeInstanceId: deps.lease.instanceId,
    createdAt,
  });
  repository.saveRetestRun(retestRun);
  const advance = (status: RetestRun['status']) => {
    assertRetestRunTransition(retestRun.status, status);
    retestRun = RetestRunSchema.parse({
      ...retestRun,
      status,
      ...(status === 'created' ? {} : { startedAt: retestRun.startedAt ?? nowIsoTimestamp() }),
      ...(['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status)
        ? { completedAt: nowIsoTimestamp() }
        : {}),
    });
    repository.saveRetestRun(retestRun);
  };
  advance('agents_running');
  const coordinator = new RunCoordinator(dataRoot, repository, deps.lease, deps.registry);
  const targetPaths = representative.locations.map((location) => location.relativePath);
  const targetRunDetails = await coordinator.run(record.project.id, {
    executionKind: 'production',
    mode: 'targeted',
    target: {
      includePaths: targetPaths,
      issueIds: [issue.id],
      userInstructions:
        'Historical issue under retest: ' +
        issue.title +
        '. ' +
        representative.description.slice(0, 1000),
    },
    agentStackIds: retestRun.agentStackIds as AgentStackId[],
    instructions: retestMissionText({
      issue,
      finding: representative,
      sourceRevisionId,
      priorOutcome: sourceSteps.priorOutcome,
    }),
    lineage: {
      parentRunId: source.qaRunId as QARunId,
      sourceRevisionId: sourceRevisionId as ProjectRevisionId,
      targetRevisionId: targetRevisionId as ProjectRevisionId,
    },
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.onHarnessRequest === undefined
      ? {}
      : { onHarnessRequest: options.onHarnessRequest as never }),
    ...(options.onHarnessEventPersisted === undefined
      ? {}
      : { onHarnessEventPersisted: options.onHarnessEventPersisted as never }),
  });
  const targetRun = targetRunDetails.run;
  retestRun = RetestRunSchema.parse({
    ...retestRun,
    targetSnapshotId: targetRun.snapshotId,
    targetQaRunId: targetRun.id,
  });
  repository.saveRetestRun(retestRun);
  advance('merging');
  let targetMerge: MergeResult | undefined;
  const limitations: string[] = [];
  try {
    ({ result: targetMerge } = mergeRun(repository, targetRun.id));
  } catch (cause) {
    limitations.push(
      'Target merge failed: ' +
        (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
    );
  }
  advance('assessing');
  let targetVerification: VerificationRun | undefined;
  let targetAttempts: VerificationRunAttempt[] = [];
  if (targetMerge !== undefined) {
    const verify = options.verify ?? verifyMerge;
    try {
      const verified = await verify(repository, dataRoot, targetMerge.id, {
        ...(deps.lease.instanceId === undefined
          ? {}
          : { runtimeInstanceId: deps.lease.instanceId }),
      });
      targetVerification = verified.run;
      targetAttempts = verified.attempts;
    } catch (cause) {
      limitations.push(
        'Target verification failed: ' +
          (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
      );
    }
  }
  const targetSteps = targetAttempts.flatMap((attempt) =>
    repository.listVerificationSteps(attempt.id).map((step) => ({
      type: step.type as string,
      expected: { ...step.expected },
      outcome: step.outcome as string | undefined,
      matchStrength: step.matchStrength as string | undefined,
    })),
  );
  const compared = compareRetestSteps({ sourceSteps: sourceSteps.steps, targetSteps });
  const observed = targetVerification !== undefined && targetVerification.status !== 'failed';
  const classification = classifyRetest({
    assertions: compared.input.assertions,
    targetNotObservable: observed ? compared.input.targetNotObservable : true,
  });
  const assessment = RetestAssessmentSchema.parse({
    schemaVersion: 1,
    id: createRetestAssessmentId(),
    retestVersion: RETEST_VERSION,
    retestRunId: retestRun.id,
    issueId: issue.id,
    projectId: issue.projectId,
    sourceRevisionId,
    targetRevisionId,
    sourceOccurrenceId: source.id,
    targetQaRunId: targetRun.id,
    targetMergeResultId: (targetMerge?.id ??
      sourceMerge.id) as RetestAssessment['targetMergeResultId'],
    newEvidenceIds: targetRunDetails.evidence.map((evidence) => evidence.id),
    result: classification.result,
    rationale: classification.rationale,
    limitations: [...compared.limitations, ...limitations].slice(0, 20),
    assessedAt: nowIsoTimestamp(),
  });
  repository.saveRetestAssessment(assessment);
  // Explicit retest links are authoritative (§33): anchor the target
  // observation to this issue via the best-overlap cluster, if any.
  let targetOccurrence: IssueOccurrence | undefined;
  if (targetMerge !== undefined && targetVerification !== undefined) {
    targetOccurrence = recordTargetOccurrence(repository, {
      issue,
      targetMerge,
      targetRun,
      targetVerificationRunId: targetVerification.id,
      targetRevisionId,
      baselineKeys: compared.baselineKeys,
      createdAt: nowIsoTimestamp(),
    });
  }
  const previousState = projectIssueState(repository.listIssueEvents(issue.id));
  if (targetOccurrence !== undefined) {
    repository.appendIssueEvent(
      IssueEventSchema.parse({
        schemaVersion: 1,
        id: createIssueEventId(),
        issueId: issue.id,
        projectId: issue.projectId,
        kind: 'occurrence_recorded',
        fromState: previousState,
        toState: previousState,
        occurrenceId: targetOccurrence.id,
        message: 'Retest observed the issue on revision ' + targetRevisionId,
        createdAt: nowIsoTimestamp(),
      }),
    );
  }
  repository.appendIssueEvent(
    IssueEventSchema.parse({
      schemaVersion: 1,
      id: createIssueEventId(),
      issueId: issue.id,
      projectId: issue.projectId,
      kind: 'retest_assessed',
      fromState: previousState,
      toState: assessment.result,
      ...(targetOccurrence === undefined ? {} : { occurrenceId: targetOccurrence.id }),
      retestAssessmentId: assessment.id,
      message: 'Retest ' + sourceRevisionId + ' → ' + targetRevisionId + ': ' + assessment.result,
      createdAt: nowIsoTimestamp(),
    }),
  );
  repository.saveIssue({ ...issue, updatedAt: nowIsoTimestamp() });
  const decisive = assessment.result === 'fixed' || assessment.result === 'still_reproducible';
  advance(targetRun.status === 'completed' && decisive ? 'completed' : 'partial');
  return {
    retestRun,
    assessment,
    targetRun,
    ...(targetMerge === undefined ? {} : { targetMerge }),
    ...(targetVerification === undefined ? {} : { targetVerification }),
    ...(targetOccurrence === undefined ? {} : { targetOccurrence }),
  };
}

function loadSourceBaselineSteps(
  repository: SentryRepository,
  source: IssueOccurrence,
  sourceMergeId: string,
): {
  steps: {
    type: string;
    expected: Record<string, string>;
    outcome?: string;
    matchStrength?: string;
  }[];
  priorOutcome?: string;
} {
  const attemptIds: { attemptId: string; outcome: string | undefined }[] = [];
  const collect = (verificationRunId: string) => {
    for (const attempt of repository.listVerificationAttempts(verificationRunId)) {
      if (attempt.findingClusterId === source.findingClusterId && attempt.status === 'completed') {
        attemptIds.push({ attemptId: attempt.id, outcome: attempt.outcome });
      }
    }
  };
  if (source.verificationRunId !== undefined) collect(source.verificationRunId);
  if (attemptIds.length === 0) {
    for (const run of repository.listVerificationRuns(sourceMergeId)) {
      collect(run.id);
      if (attemptIds.length > 0) break;
    }
  }
  if (attemptIds.length === 0) return { steps: [] };
  const first = attemptIds[0] as { attemptId: string; outcome: string | undefined };
  const steps = repository.listVerificationSteps(first.attemptId).map((step) => ({
    type: step.type,
    expected: { ...step.expected },
    ...(step.outcome === undefined ? {} : { outcome: step.outcome }),
    ...(step.matchStrength === undefined ? {} : { matchStrength: step.matchStrength }),
  }));
  return { steps, ...(first.outcome === undefined ? {} : { priorOutcome: first.outcome }) };
}

function recordTargetOccurrence(
  repository: SentryRepository,
  input: {
    readonly issue: Issue;
    readonly targetMerge: MergeResult;
    readonly targetRun: QARun;
    readonly targetVerificationRunId: string;
    readonly targetRevisionId: string;
    readonly baselineKeys: readonly string[];
    readonly createdAt: string;
  },
): IssueOccurrence | undefined {
  const keySet = new Set(input.baselineKeys);
  // Deterministic best-overlap selection over target clusters using
  // persisted verification steps keyed by exact replay intent.
  const scored: { clusterId: string; overlap: number }[] = [];
  for (const cluster of input.targetMerge.clusters) {
    const steps = repository
      .listVerificationAttempts(input.targetVerificationRunId)
      .filter((attempt) => attempt.findingClusterId === cluster.id)
      .flatMap((attempt) => repository.listVerificationSteps(attempt.id));
    const keys = new Set<string>();
    for (const step of steps) {
      const key = retestStepKey({ type: step.type, expected: step.expected });
      if (key !== undefined && keySet.has(key)) keys.add(key);
    }
    if (keys.size > 0) scored.push({ clusterId: cluster.id, overlap: keys.size });
  }
  scored.sort((a, b) => b.overlap - a.overlap || (a.clusterId < b.clusterId ? -1 : 1));
  const winner = scored[0];
  if (winner === undefined) return undefined;
  const occurrence = IssueOccurrenceSchema.parse({
    schemaVersion: 1,
    id: createIssueOccurrenceId(),
    issueId: input.issue.id,
    projectId: input.issue.projectId,
    projectRevisionId: input.targetRevisionId,
    projectSnapshotId: input.targetRun.snapshotId,
    qaRunId: input.targetRun.id,
    mergeResultId: input.targetMerge.id,
    findingClusterId: winner.clusterId,
    createdAt: input.createdAt,
  });
  repository.transaction(() => {
    repository.saveIssueOccurrence(occurrence);
    repository.saveIngestKey(
      issueIngestKey({ mergeResultId: input.targetMerge.id, findingClusterId: winner.clusterId }),
      input.issue.id,
      occurrence.id,
    );
  });
  return occurrence;
}

/** Stable cancellation for top-level retest executions (§45): marks the
 *  retest run cancelled and best-effort cancels a nonterminal target QA
 *  run. Completed observations are preserved. */
export function cancelRetestRun(
  deps: RetestServiceDeps,
  retestRunId: string,
): { retestRunId: string; status: 'cancelled' } {
  deps.lease.assertHealthy();
  const run = deps.repository.getRetestRun(retestRunId);
  if (run === undefined)
    throw new RunEngineError('RUN_NOT_FOUND', 'RetestRun not found: ' + retestRunId);
  if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
    throw new RunEngineError(
      'RUN_NOT_COMPLETE',
      'RetestRun ' + retestRunId + ' is already terminal (' + run.status + ')',
    );
  }
  if (run.runtimeInstanceId !== undefined && !deps.lease.isFresh(run.runtimeInstanceId as never)) {
    throw new RunEngineError(
      'RUN_EXECUTION_FAILED',
      'RetestRun ' + retestRunId + ' is owned by another runtime instance',
    );
  }
  if (run.targetQaRunId !== undefined) {
    try {
      new RunCoordinator(deps.dataRoot, deps.repository, deps.lease, deps.registry).cancelRun(
        run.targetQaRunId as QARunId,
      );
    } catch {
      // Best-effort: the target run may already be terminal.
    }
  }
  assertRetestRunTransition(run.status, 'cancelled');
  deps.repository.saveRetestRun(
    RetestRunSchema.parse({ ...run, status: 'cancelled', completedAt: nowIsoTimestamp() }),
  );
  return { retestRunId, status: 'cancelled' };
}

/** Crash recovery for retest executions: stale-owned nonterminal retest
 *  runs become interrupted with completed observations preserved. Called
 *  from RunCoordinator.recover() under the same lease freshness. */
export function recoverRetests(
  repository: SentryRepository,
  isFresh: (instanceId: string) => boolean,
): { runs: number } {
  let runs = 0;
  for (const run of repository.listNonterminalRetestRuns()) {
    const owner = run.runtimeInstanceId;
    if (owner !== undefined && isFresh(owner as never)) continue;
    if (owner === undefined) continue;
    assertRetestRunTransition(run.status, 'interrupted');
    repository.saveRetestRun(
      RetestRunSchema.parse({ ...run, status: 'interrupted', completedAt: nowIsoTimestamp() }),
    );
    runs += 1;
  }
  return { runs };
}
