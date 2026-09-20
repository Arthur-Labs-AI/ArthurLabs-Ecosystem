/** Phase 7 closure cross-revision Retest orchestration.
 *
 *  Canonical flow: Issue occurrence on revision A → developer updates the
 *  managed project (new ProjectRevision B) → `retestIssue` creates a
 *  RetestRun, runs a child FULL/TARGETED QARun on B (never snapshot A),
 *  freezes B, persists the immutable RetestSpec v2 + digest, merges,
 *  verifies with frozen Verifier v3 primitives, then records a
 *  deterministic RetestAssessment.
 *
 *  Invariants (closure):
 *  - every RetestRun row terminalizes on every normal path (§18);
 *  - pre-freeze failures carry no target snapshot (§20) + failure record;
 *  - historical paths resolve deterministically (§23), absence never
 *    equals fixed (§24), full-absence uses an explicit focused fallback;
 *  - target IDs always refer to revision-B resources, never source (§27-29);
 *  - RetestRun is the workflow; QARun modes are full|targeted (§30-33).
 *
 *  The verdict compares BEHAVIOR via exact ID-free replay intent
 *  (`compareRetestSteps`): source steps that strongly confirmed failure on
 *  A against target steps freshly observed on B. Agent consensus alone
 *  never decides; silence never means fixed; deletion never means fixed.
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
  RetestSpecSchema,
  RETEST_VERSION,
  issueIngestKey,
  projectIssueState,
  retestInputDigest,
  type Finding,
  type Issue,
  type IssueOccurrence,
  type MergeResult,
  type QARun,
  type RetestAssessment,
  type RetestRun,
  type RetestSpec,
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
  /** Default: current ready ProjectRevision. Frozen into a new snapshot. */
  readonly targetRevisionId?: ProjectRevisionId;
  readonly runTimeoutMs?: number;
  readonly onHarnessRequest?: (request: import('@qa/schemas').HarnessRunRequest) => void;
  readonly onHarnessEventPersisted?: (
    event: import('@qa/schemas').HarnessEvent,
    agentRun: import('@qa/schemas').AgentRun,
  ) => void;
  /** Test seam: override target verification. Production always uses verifyMerge. */
  readonly verify?: typeof verifyMerge;
  /** Test seam: wrapped around the child freeze hook. Throwing here simulates
   *  a post-row target-setup failure (snapshot/validation crash). */
  readonly onChildSnapshotFrozen?: (
    frozen: import('./index.js').SnapshotFrozenContext,
  ) => Promise<void> | void;
}

export interface RetestIssueResult {
  readonly retestRun: RetestRun;
  readonly assessment: RetestAssessment | undefined;
  readonly spec: RetestSpec | undefined;
  readonly targetRun: QARun | undefined;
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

export interface ResolvedRetestTargets {
  readonly historicalPaths: readonly string[];
  readonly resolvedTargetPaths: readonly string[];
  readonly strategy: 'exact_paths' | 'nearest_ancestor' | 'full_snapshot_fallback';
  readonly limitations: readonly string[];
  readonly fullSnapshotFallback: boolean;
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
  readonly resolutionNote: string;
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
    input.resolutionNote +
    ' ' +
    'Focus: does this issue still exist? did the fix move the problem? is behavior partially ' +
    'corrected? did the change introduce a direct regression around this issue? ' +
    'Do not turn this into an unrelated repository-wide scan; directly related regressions ' +
    'may be reported.'
  );
}

/** Deterministic Retest target resolution (closure §23-§26): exact paths
 *  first, else nearest existing ancestor directory, deduplicated. When no
 *  ancestor exists, an explicit focused full-snapshot fallback is used
 *  (never a random directory, never a crash). Path disappearance only
 *  changes scope — never fix evidence (§24). */
export function resolveRetestTargets(input: {
  readonly historicalPaths: readonly string[];
  readonly snapshotFiles: ReadonlySet<string>;
}): ResolvedRetestTargets {
  const historical = [...new Set(input.historicalPaths)];
  if (historical.length === 0) {
    return {
      historicalPaths: [],
      resolvedTargetPaths: [],
      strategy: 'full_snapshot_fallback',
      limitations: [
        'RETEST_HISTORICAL_TARGETS_ABSENT: no historical paths; focused full-snapshot retest',
      ],
      fullSnapshotFallback: true,
    };
  }
  const directories = new Set<string>();
  for (const file of input.snapshotFiles) {
    const slash = file.lastIndexOf('/');
    if (slash > 0) directories.add(file.slice(0, slash));
  }
  const resolved = new Set<string>();
  let usedAncestor = false;
  for (const historicalPath of historical) {
    if (input.snapshotFiles.has(historicalPath)) {
      resolved.add(historicalPath);
      continue;
    }
    const prefix = historicalPath + '/';
    let covered = false;
    for (const file of input.snapshotFiles) {
      if (file.startsWith(prefix)) {
        covered = true;
        break;
      }
    }
    if (covered) {
      resolved.add(historicalPath);
      continue;
    }
    let ancestor = historicalPath.includes('/')
      ? historicalPath.slice(0, historicalPath.lastIndexOf('/'))
      : '';
    let found: string | undefined;
    while (ancestor.length > 0) {
      if (directories.has(ancestor)) {
        found = ancestor;
        break;
      }
      let coveredDir = false;
      const dirPrefix = ancestor + '/';
      for (const file of input.snapshotFiles) {
        if (file.startsWith(dirPrefix)) {
          coveredDir = true;
          break;
        }
      }
      if (coveredDir) {
        found = ancestor;
        break;
      }
      ancestor = ancestor.includes('/') ? ancestor.slice(0, ancestor.lastIndexOf('/')) : '';
    }
    if (found !== undefined) {
      resolved.add(found);
      usedAncestor = true;
    }
  }
  if (resolved.size > 0) {
    return {
      historicalPaths: historical,
      resolvedTargetPaths: [...resolved].sort(),
      strategy: usedAncestor ? 'nearest_ancestor' : 'exact_paths',
      limitations: usedAncestor
        ? [
            'Historical target path(s) absent on revision B; nearest existing ancestor scope used. Absence is not fix evidence.',
          ]
        : [],
      fullSnapshotFallback: false,
    };
  }
  return {
    historicalPaths: historical,
    resolvedTargetPaths: [],
    strategy: 'full_snapshot_fallback',
    limitations: [
      'RETEST_HISTORICAL_TARGETS_ABSENT: no historical path or ancestor exists on revision B; explicit focused full-snapshot retest. Absence is not fix evidence.',
    ],
    fullSnapshotFallback: true,
  };
}

function failRetestRun(
  repository: SentryRepository,
  run: RetestRun,
  failure: { readonly code: string; readonly message: string; readonly retryable: boolean },
): RetestRun {
  const terminal = RetestRunSchema.parse({
    ...run,
    status: 'failed' as const,
    failure,
    completedAt: nowIsoTimestamp(),
  });
  repository.saveRetestRun(terminal);
  return terminal;
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
  const sourceRevision = repository.getRevision(sourceRevisionId);
  if (
    sourceRevision !== undefined &&
    (sourceRevision.hashVersion ?? 1) !== (targetRevision.hashVersion ?? 1)
  ) {
    throw new RunEngineError(
      'RETEST_HASH_VERSION_MISMATCH',
      'Retest source revision ' +
        sourceRevisionId +
        ' (hash v' +
        String(sourceRevision.hashVersion ?? 1) +
        ') and target revision ' +
        targetRevisionId +
        ' (hash v' +
        String(targetRevision.hashVersion ?? 1) +
        ') were hashed with different import exclusion sets and must not be compared',
    );
  }
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
  const sourceSteps = loadSourceBaselineSteps(repository, source, sourceMerge.id);
  const createdAt = nowIsoTimestamp();
  const initialRetestRun = RetestRunSchema.parse({
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
  repository.saveRetestRun(initialRetestRun);
  // Lifecycle guard (§18): every normal path after this point terminalizes
  // the SAME RetestRun. Only a hard process crash may leave it
  // nonterminal, and lease-based recovery then interrupts it.
  try {
    return await executeRetestLifecycle(deps, {
      issue,
      source,
      sourceMerge,
      sourceCluster,
      representative,
      sourceSteps,
      retestRun: initialRetestRun,
      targetRevisionId,
      options,
    });
  } catch (cause) {
    const fresh = repository.getRetestRun(initialRetestRun.id);
    const current = fresh ?? initialRetestRun;
    if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(current.status)) {
      throw cause;
    }
    const failure =
      cause instanceof RunEngineError && cause.code === 'RUN_CANCELLED'
        ? {
            code: 'RUN_CANCELLED',
            message: 'Retest cancelled by operator.',
            retryable: false as const,
          }
        : {
            code:
              cause instanceof RunEngineError
                ? cause.code
                : cause instanceof Error
                  ? cause.name || 'RETEST_FAILED'
                  : 'RETEST_FAILED',
            message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000),
            retryable: false as const,
          };
    const failed = failRetestRun(repository, current, failure);
    if (cause instanceof RunEngineError && cause.code === 'RUN_CANCELLED') {
      const cancelled = RetestRunSchema.parse({
        ...failed,
        status: 'cancelled' as const,
      });
      repository.saveRetestRun(cancelled);
      // Micro-patch §15: the Retest request completes only now — child is
      // terminal and this RetestRun just terminalized as cancelled.
      const pendingCancel = repository.getRetestControlRequest(cancelled.id);
      if (pendingCancel !== undefined) {
        repository.saveRetestControlRequest({
          ...pendingCancel,
          ...(pendingCancel.acknowledgedAt === undefined
            ? { acknowledgedAt: nowIsoTimestamp() }
            : {}),
          completedAt: nowIsoTimestamp(),
        });
      }
      return {
        retestRun: cancelled,
        assessment: undefined,
        spec: repository.getRetestSpec(cancelled.id),
        targetRun: cancelled.targetQaRunId
          ? repository.getRun(cancelled.targetQaRunId as QARunId)
          : undefined,
      };
    }
    return {
      retestRun: failed,
      assessment: undefined,
      spec: repository.getRetestSpec(failed.id),
      targetRun: failed.targetQaRunId
        ? repository.getRun(failed.targetQaRunId as QARunId)
        : undefined,
    };
  }
}

async function executeRetestLifecycle(
  deps: RetestServiceDeps,
  input: {
    readonly issue: Issue;
    readonly source: IssueOccurrence;
    readonly sourceMerge: MergeResult;
    readonly sourceCluster: { readonly id: string };
    readonly representative: Finding;
    readonly sourceSteps: { readonly steps: RetestReplayStep[]; readonly priorOutcome?: string };
    retestRun: RetestRun;
    readonly targetRevisionId: string;
    readonly options: RetestIssueOptions;
  },
): Promise<RetestIssueResult> {
  const { repository, dataRoot } = deps;
  let retestRun = input.retestRun;
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
  /** Micro-patch §26: propagate a pending Retest cancellation request to
   *  the known child QARun (request-only — the child's owner settles it).
   *  Safe to call from the frozen hook: targetQaRunId is already durable. */
  const propagatePendingRetestCancel = () => {
    const request = repository.getRetestControlRequest(retestRun.id);
    if (request === undefined || request.completedAt !== undefined) return;
    if (retestRun.targetQaRunId === undefined) return;
    try {
      new RunCoordinator(dataRoot, repository, deps.lease, deps.registry).requestRunCancellation(
        retestRun.targetQaRunId as QARunId,
      );
    } catch {
      // Child may be terminal; the status check below handles settled state.
    }
  };

  /** Finish-pass §26: the owning Retest runtime observes its control
   *  request and propagates request-only to the child QARun (never
   *  foreign-acknowledging). It aborts only once the child's owner has
   *  settled the child as cancelled — the lifecycle guard then terminalizes
   *  this RetestRun as cancelled. */
  const observeRetestCancelRequest = () => {
    const request = repository.getRetestControlRequest(retestRun.id);
    if (request === undefined || request.completedAt !== undefined) return;
    if (retestRun.targetQaRunId !== undefined) {
      try {
        new RunCoordinator(dataRoot, repository, deps.lease, deps.registry).requestRunCancellation(
          retestRun.targetQaRunId as QARunId,
        );
      } catch {
        // Child may be terminal or foreign-owned; fall through to the
        // status check below.
      }
      const child = repository.getRun(retestRun.targetQaRunId as QARunId);
      if (child !== undefined && child.status === 'cancelled') {
        throw new RunEngineError('RUN_CANCELLED', 'Retest cancelled by operator');
      }
      return;
    }
    // No child yet (pre-freeze): propagate at the next observation point.
  };

  async function snapshotFileSet(snapshotId: string): Promise<ReadonlySet<string>> {
    const { SnapshotEngine } = await import('@qa/snapshot-engine');
    const engine = new SnapshotEngine(dataRoot, repository);
    return new Set((await engine.baselineFileHashes(snapshotId as never)).keys());
  }
  advance('agents_running');
  observeRetestCancelRequest();
  const coordinator = new RunCoordinator(dataRoot, repository, deps.lease, deps.registry);
  const historicalPaths = input.representative.locations.map((location) => location.relativePath);
  const record = new ProjectManager(dataRoot, repository, {
    runtimeLease: deps.lease,
  }).getProject(input.issue.projectId as ProjectId);
  if (record === undefined) throw new RunEngineError('PROJECT_NOT_FOUND', 'Project vanished');
  const hookUserInstructions =
    'Historical issue under retest: ' +
    input.issue.title +
    '. ' +
    input.representative.description.slice(0, 1000);
  // Target setup failures propagate to the lifecycle guard, which
  // terminalizes the SAME RetestRun as failed with no target snapshot and
  // no fake assessment. The coordinator releases its own project lock in
  // its finally path, so no lock leaks.
  const targetRunDetails: Awaited<ReturnType<RunCoordinator['run']>> = await coordinator.run(
    record.project.id,
    {
      executionKind: 'production',
      // Historical paths may vanish on B: pass them leniently; the frozen
      // hook resolves canonically against the Snapshot B manifest (exact →
      // nearest ancestor → explicit full fallback), never the mutable tree.
      mode: 'targeted',
      target: {
        includePaths: [...historicalPaths],
        issueIds: [input.issue.id],
        userInstructions: hookUserInstructions,
      },
      agentStackIds: retestRun.agentStackIds as AgentStackId[],
      instructions: retestMissionText({
        issue: input.issue,
        finding: input.representative,
        sourceRevisionId: input.source.projectRevisionId,
        priorOutcome: input.sourceSteps.priorOutcome,
        resolutionNote: 'Target scope resolves after Snapshot B freezes (see RetestSpec).',
      }),
      lineage: {
        parentRunId: input.source.qaRunId as QARunId,
        sourceRevisionId: input.source.projectRevisionId as ProjectRevisionId,
        targetRevisionId: input.targetRevisionId as ProjectRevisionId,
      },
      onSnapshotFrozen: async (frozen) => {
        if (input.options.onChildSnapshotFrozen !== undefined) {
          await input.options.onChildSnapshotFrozen(frozen);
        }
        if (frozen.snapshot.projectRevisionId !== input.targetRevisionId) {
          throw new RunEngineError(
            'PROJECT_COPY_DRIFT',
            'Retest target revision changed before freeze: expected ' +
              input.targetRevisionId +
              ', froze ' +
              frozen.snapshot.projectRevisionId,
          );
        }
        const hookResolved = resolveRetestTargets({
          historicalPaths,
          snapshotFiles: frozen.snapshotFiles,
        });
        const hookDigest = retestInputDigest({
          issueId: input.issue.id,
          sourceOccurrenceId: input.source.id,
          sourceSnapshotId: input.source.projectSnapshotId,
          targetSnapshotId: frozen.snapshot.id,
          agentStackIds: [...retestRun.agentStackIds],
          recipeVersion: 3,
          sourceRevisionId: input.source.projectRevisionId,
          targetRevisionId: input.targetRevisionId,
          sourceMergeResultId: input.sourceMerge.id,
          sourceFindingClusterId: input.sourceCluster.id,
          resolvedTargetPaths: [...hookResolved.resolvedTargetPaths],
          retestVersion: RETEST_VERSION,
        });
        const hookSpec = RetestSpecSchema.parse({
          schemaVersion: 1,
          retestRunId: retestRun.id,
          issueId: input.issue.id,
          sourceOccurrenceId: input.source.id,
          sourceSnapshotId: input.source.projectSnapshotId,
          targetSnapshotId: frozen.snapshot.id,
          sourceMergeResultId: input.sourceMerge.id,
          sourceFindingClusterId: input.sourceCluster.id,
          sourceRevisionId: input.source.projectRevisionId,
          targetRevisionId: input.targetRevisionId,
          agentStackIds: [...retestRun.agentStackIds],
          historicalPaths: [...hookResolved.historicalPaths],
          resolvedTargetPaths: [...hookResolved.resolvedTargetPaths],
          resolutionStrategy: hookResolved.strategy,
          recipeVersion: 3,
          retestVersion: RETEST_VERSION,
          inputDigest: hookDigest,
          limitations: [...hookResolved.limitations],
          createdAt: nowIsoTimestamp(),
        });
        repository.saveRetestSpec(hookSpec, input.issue.projectId as ProjectId);
        // Micro-patch §10: the child QARun row is durably persisted BEFORE
        // this hook fires, so targetQaRunId is FK-safe to attach here —
        // before any adapter starts. A pending Retest cancellation request
        // cascades to the child immediately (§26), so no provider adapter
        // begins after cancellation was requested (§27).
        retestRun = RetestRunSchema.parse({
          ...retestRun,
          targetSnapshotId: frozen.snapshot.id,
          targetQaRunId: frozen.runId,
        });
        repository.saveRetestRun(retestRun);
        propagatePendingRetestCancel();
        if (hookResolved.fullSnapshotFallback) {
          return { mode: 'full' as const };
        }
        return { overrideIncludePaths: [...hookResolved.resolvedTargetPaths] };
      },
      ...(input.options.runTimeoutMs === undefined
        ? {}
        : { runTimeoutMs: input.options.runTimeoutMs }),
      ...(input.options.onHarnessRequest === undefined
        ? {}
        : { onHarnessRequest: input.options.onHarnessRequest as never }),
      ...(input.options.onHarnessEventPersisted === undefined
        ? {}
        : { onHarnessEventPersisted: input.options.onHarnessEventPersisted as never }),
    },
  );
  const targetRun = targetRunDetails.run;
  const resolved = resolveRetestTargets({
    historicalPaths,
    snapshotFiles: await snapshotFileSet(targetRun.snapshotId),
  });
  if (targetRun.snapshotId !== retestRun.targetSnapshotId) {
    throw new RunEngineError(
      'RUN_EXECUTION_FAILED',
      'Retest child snapshot diverged from frozen RetestSpec snapshot',
    );
  }
  // Micro-patch §14: a child cancelled under a pending Retest request ends
  // the workflow here — no merge, no verification, no assessment. The
  // lifecycle guard converts the throw into terminal cancelled.
  if (targetRun.status === 'cancelled') {
    const pendingCancel = repository.getRetestControlRequest(retestRun.id);
    if (pendingCancel !== undefined && pendingCancel.completedAt === undefined) {
      throw new RunEngineError('RUN_CANCELLED', 'Retest cancelled by operator');
    }
  }
  observeRetestCancelRequest();
  // RetestSpec v2 was persisted by the frozen hook before agents;
  // read it back for the result (never re-persist: immutability).
  const spec = repository.getRetestSpec(retestRun.id);
  advance('merging');
  observeRetestCancelRequest();
  let targetMerge: MergeResult | undefined;
  const limitations: string[] = [...resolved.limitations];
  try {
    ({ result: targetMerge } = mergeRun(repository, targetRun.id));
  } catch (cause) {
    limitations.push(
      'Target merge failed: ' +
        (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
    );
  }
  advance('assessing');
  observeRetestCancelRequest();
  let targetVerification: VerificationRun | undefined;
  let targetAttempts: VerificationRunAttempt[] = [];
  if (targetMerge !== undefined) {
    const verify = input.options.verify ?? verifyMerge;
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
  const compared = compareRetestSteps({ sourceSteps: input.sourceSteps.steps, targetSteps });
  const observed = targetVerification !== undefined && targetVerification.status !== 'failed';
  const classification = classifyRetest({
    assertions: compared.input.assertions,
    targetNotObservable: observed ? compared.input.targetNotObservable : true,
  });
  // Closure §27-§29: target IDs stay absent when the target artifact is
  // missing. Source IDs are recorded only in source fields — never
  // substituted into target fields.
  const assessment = RetestAssessmentSchema.parse({
    schemaVersion: 1,
    id: createRetestAssessmentId(),
    retestVersion: RETEST_VERSION,
    retestRunId: retestRun.id,
    issueId: input.issue.id,
    projectId: input.issue.projectId,
    sourceRevisionId: input.source.projectRevisionId,
    targetRevisionId: input.targetRevisionId,
    sourceOccurrenceId: input.source.id,
    sourceMergeResultId: input.sourceMerge.id,
    targetQaRunId: targetRun.id,
    ...(targetMerge === undefined ? {} : { targetMergeResultId: targetMerge.id }),
    ...(targetVerification === undefined ? {} : { targetVerificationRunId: targetVerification.id }),
    newEvidenceIds: targetRunDetails.evidence.map((evidence) => evidence.id),
    result: classification.result,
    rationale: classification.rationale,
    limitations: [...compared.limitations, ...limitations].slice(0, 20),
    assessedAt: nowIsoTimestamp(),
  });
  repository.saveRetestAssessment(assessment);
  let targetOccurrence: IssueOccurrence | undefined;
  if (targetMerge !== undefined && targetVerification !== undefined) {
    targetOccurrence = recordTargetOccurrence(repository, {
      issue: input.issue,
      targetMerge,
      targetRun,
      targetVerificationRunId: targetVerification.id,
      targetRevisionId: input.targetRevisionId,
      baselineKeys: compared.baselineKeys,
      createdAt: nowIsoTimestamp(),
    });
  }
  const previousState = projectIssueState(repository.listIssueEvents(input.issue.id));
  if (targetOccurrence !== undefined) {
    repository.appendIssueEvent(
      IssueEventSchema.parse({
        schemaVersion: 1,
        id: createIssueEventId(),
        issueId: input.issue.id,
        projectId: input.issue.projectId,
        kind: 'occurrence_recorded',
        fromState: previousState,
        toState: previousState,
        occurrenceId: targetOccurrence.id,
        message: 'Retest observed the issue on revision ' + input.targetRevisionId,
        createdAt: nowIsoTimestamp(),
      }),
    );
  }
  repository.appendIssueEvent(
    IssueEventSchema.parse({
      schemaVersion: 1,
      id: createIssueEventId(),
      issueId: input.issue.id,
      projectId: input.issue.projectId,
      kind: 'retest_assessed',
      fromState: previousState,
      toState: assessment.result,
      ...(targetOccurrence === undefined ? {} : { occurrenceId: targetOccurrence.id }),
      retestAssessmentId: assessment.id,
      message:
        'Retest ' +
        input.source.projectRevisionId +
        ' → ' +
        input.targetRevisionId +
        ': ' +
        assessment.result,
      createdAt: nowIsoTimestamp(),
    }),
  );
  repository.saveIssue({ ...input.issue, updatedAt: nowIsoTimestamp() });
  const decisive = assessment.result === 'fixed' || assessment.result === 'still_reproducible';
  advance(targetRun.status === 'completed' && decisive ? 'completed' : 'partial');
  return {
    retestRun,
    assessment,
    spec,
    targetRun,
    ...(targetMerge === undefined ? {} : { targetMerge }),
    ...(targetVerification === undefined ? {} : { targetVerification }),
    ...(targetOccurrence === undefined ? {} : { targetOccurrence }),
  };
}

type RetestReplayStep = {
  readonly type: string;
  readonly expected: Record<string, string>;
  readonly outcome?: string;
  readonly matchStrength?: string;
};

function loadSourceBaselineSteps(
  repository: SentryRepository,
  source: IssueOccurrence,
  sourceMergeId: string,
): {
  steps: RetestReplayStep[];
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

/** Finish-pass §27: strict Retest owner identity — runtimeInstanceId
 *  equality. Freshness is liveness, never ownership. Legacy runs without
 *  an instanceId fall back to child-run local ownership. */
export function isLocalRetestOwner(deps: RetestServiceDeps, run: RetestRun): boolean {
  if (run.runtimeInstanceId !== undefined) {
    return run.runtimeInstanceId === deps.lease.instanceId;
  }
  if (run.targetQaRunId !== undefined) {
    const child = deps.repository.getRun(run.targetQaRunId as QARunId);
    if (child !== undefined) {
      return new RunCoordinator(
        deps.dataRoot,
        deps.repository,
        deps.lease,
        deps.registry,
      ).isLocalRunOwner(child);
    }
  }
  return false;
}

/** Cooperative retest cancellation: persist a durable request, cascade a
 *  request-only child QARun cancellation (never foreign-acknowledge),
 *  then return — never fake completion. */
export function requestRetestCancellation(
  deps: RetestServiceDeps,
  retestRunId: string,
): { retestRunId: string; status: 'cancellation_requested' | 'cancelled' | 'already_terminal' } {
  deps.lease.assertHealthy();
  const run = deps.repository.getRetestRun(retestRunId);
  if (run === undefined)
    throw new RunEngineError('RUN_NOT_FOUND', 'RetestRun not found: ' + retestRunId);
  if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
    return { retestRunId, status: 'already_terminal' };
  }
  const timestamp = nowIsoTimestamp();
  const existing = deps.repository.getRetestControlRequest(retestRunId);
  if (existing === undefined) {
    deps.repository.saveRetestControlRequest({
      id: 'rcancel_' + retestRunId.slice(7),
      retestRunId,
      projectId: run.projectId as ProjectId,
      requestType: 'cancel',
      requestingRuntimeId: deps.lease.instanceId,
      requestedAt: timestamp,
    });
  }
  if (run.targetQaRunId !== undefined) {
    try {
      new RunCoordinator(
        deps.dataRoot,
        deps.repository,
        deps.lease,
        deps.registry,
      ).requestRunCancellation(run.targetQaRunId as QARunId);
    } catch {
      // Best-effort: the target run may already be terminal or foreign-owned.
    }
  }
  const fresh = deps.repository.getRetestRun(retestRunId);
  if (
    fresh !== undefined &&
    ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(fresh.status)
  ) {
    return { retestRunId, status: 'already_terminal' };
  }
  return { retestRunId, status: 'cancellation_requested' };
}

/** Owner-side retest acknowledge: only the verified local owner may call
 *  this. Cascades request-only to the child (the child's owner settles it),
 *  then terminalizes the RetestRun as cancelled. Foreign callers are
 *  refused — a foreign CLI must stop at requestRetestCancellation. */
export function acknowledgeRetestCancellation(
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
  if (!isLocalRetestOwner(deps, run)) {
    throw new RunEngineError(
      'RUN_EXECUTION_FAILED',
      'RetestRun ' + retestRunId + ' is owned by another runtime instance',
    );
  }
  if (run.targetQaRunId !== undefined) {
    // Request-only cascade: the child's own owner settles it. Never
    // acknowledge a foreign child's execution from here.
    try {
      new RunCoordinator(
        deps.dataRoot,
        deps.repository,
        deps.lease,
        deps.registry,
      ).requestRunCancellation(run.targetQaRunId as QARunId);
    } catch {
      // Best-effort cascade; the retest still terminalizes honestly once
      // its own child settles.
    }
    const child = deps.repository.getRun(run.targetQaRunId as QARunId);
    if (
      child !== undefined &&
      !['completed', 'partial', 'failed', 'cancelled'].includes(child.status)
    ) {
      throw new RunEngineError(
        'RUN_EXECUTION_FAILED',
        'Child target run is still active; owner has not settled it yet',
      );
    }
  }
  const pending = deps.repository.getRetestControlRequest(retestRunId);
  const timestamp = nowIsoTimestamp();
  if (pending !== undefined && pending.acknowledgedAt === undefined) {
    deps.repository.saveRetestControlRequest({ ...pending, acknowledgedAt: timestamp });
  }
  assertRetestRunTransition(run.status, 'cancelled');
  deps.repository.saveRetestRun(
    RetestRunSchema.parse({ ...run, status: 'cancelled', completedAt: timestamp }),
  );
  const done = deps.repository.getRetestControlRequest(retestRunId);
  if (done !== undefined && done.completedAt === undefined) {
    deps.repository.saveRetestControlRequest({ ...done, completedAt: nowIsoTimestamp() });
  }
  return { retestRunId, status: 'cancelled' };
}

/** Stable cancellation for top-level retest executions: request + owner
 *  acknowledge in one step for single-process callers. Cross-process
 *  callers use requestRetestCancellation and let the owner acknowledge. */
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
  if (!isLocalRetestOwner(deps, run)) {
    throw new RunEngineError(
      'RUN_EXECUTION_FAILED',
      'RetestRun ' + retestRunId + ' is owned by another runtime instance',
    );
  }
  requestRetestCancellation(deps, retestRunId);
  return acknowledgeRetestCancellation(deps, retestRunId);
}

/** Crash recovery for retest executions: stale-owned nonterminal retest
 *  runs become interrupted with completed observations preserved. Stale
 *  pending cancel requests complete honestly as interrupted (never
 *  fake-cancelled). Called from RunCoordinator.recover(). */
export function recoverRetests(
  repository: SentryRepository,
  isFresh: (instanceId: string) => boolean,
): { runs: number } {
  let runs = 0;
  const timestamp = nowIsoTimestamp();
  for (const run of repository.listNonterminalRetestRuns()) {
    const owner = run.runtimeInstanceId;
    if (owner !== undefined && isFresh(owner as never)) continue;
    if (owner === undefined) continue;
    assertRetestRunTransition(run.status, 'interrupted');
    repository.saveRetestRun(
      RetestRunSchema.parse({
        ...run,
        status: 'interrupted',
        completedAt: timestamp,
        failure: {
          code: 'APP_INTERRUPTED',
          message: 'Sentry stopped before the retest completed.',
          retryable: true,
        },
      }),
    );
    const pending = repository.getRetestControlRequest(run.id);
    if (pending !== undefined && pending.completedAt === undefined) {
      repository.saveRetestControlRequest({ ...pending, completedAt: timestamp });
    }
    runs += 1;
  }
  return { runs };
}
