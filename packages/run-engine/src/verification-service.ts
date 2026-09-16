import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  buildRecipe,
  classifyAttempt,
  executeReplay,
  executeSourceIntegrity,
  redactSecrets,
  VerificationCommandRunner,
  VERIFICATION_RECIPE_VERSION,
  VERIFICATION_SIGNATURE_VERSION,
  VERIFIER_VERSION,
  type CanonicalOperation,
  type ExecutedStep,
} from '@qa/verifier';
import {
  copyTree,
  FilesystemArtifactStore,
  projectDataPaths,
  resolveInside,
  type SentryRepository,
} from '@qa/persistence';
import { SnapshotEngine } from '@qa/snapshot-engine';
import {
  createVerificationAttemptId,
  createVerificationObservationId,
  createVerificationRunId,
  createVerificationStepId,
  nowIsoTimestamp,
  type IsoTimestamp,
  type QARunId,
} from '@qa/shared';
import type {
  Evidence,
  Finding,
  VerificationAssertion,
  VerificationObservation,
  VerificationRecipeStep,
  VerificationRun,
  VerificationRunAttempt,
} from '@qa/schemas';

export class VerificationServiceError extends Error {
  constructor(
    readonly code:
      | 'MERGE_RESULT_NOT_FOUND'
      | 'CLUSTER_NOT_FOUND'
      | 'SNAPSHOT_NOT_FOUND'
      | 'SNAPSHOT_DRIFT'
      | 'NO_VERIFIABLE_CLUSTERS',
    message: string,
  ) {
    super(message);
    this.name = 'VerificationServiceError';
  }
}

export interface VerifyRunOptions {
  readonly clusterIds?: readonly string[];
  readonly commandTimeoutMs?: number;
  readonly now?: IsoTimestamp;
  /** Test-only seam: override the command runner. Production always
   *  uses the contained VerificationCommandRunner. */
  readonly runner?: VerificationCommandRunner;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

function environmentFingerprint(): VerificationRun['environmentFingerprint'] {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    packageManagerVersions: {},
    runtimes: [],
  };
}

/** Resolve canonical operations from persisted run events (§29, §96):
 *  `command.executed` and `test.result` rows keyed by operationId.
 *  Evidence text is never a replay source; only these records are. */
function resolveOperations(
  repository: SentryRepository,
  runId: QARunId,
): Map<string, CanonicalOperation> {
  const operations = new Map<string, CanonicalOperation>();
  for (const stored of repository.iterateRunEvents(runId)) {
    const event = stored.event;
    if (event.type === 'command.executed' && event.operationId !== undefined) {
      operations.set(event.operationId, {
        operationId: event.operationId,
        command: event.command,
        exitCode: event.exitCode,
      });
    } else if (event.type === 'test.result' && event.operationId !== undefined) {
      const known = operations.get(event.operationId);
      const status =
        event.failed !== undefined && event.failed > 0
          ? ('failed' as const)
          : event.skipped !== undefined && event.skipped > 0
            ? ('skipped' as const)
            : ('passed' as const);
      operations.set(event.operationId, {
        operationId: event.operationId,
        ...(known?.command === undefined ? {} : { command: known.command }),
        ...(known?.exitCode === undefined ? {} : { exitCode: known.exitCode }),
        testStatus: status,
        ...(event.suite === undefined ? {} : { testName: event.suite }),
        ...(event.suite === undefined ? {} : { suite: event.suite }),
      });
    }
  }
  return operations;
}

/** Materialize a fresh verifier workspace from the managed working copy
 *  and prove it matches the historical snapshot (§9, §95): the managed
 *  copy must still sit at the snapshot's revision AND every manifest
 *  baseline hash must reproduce. Anything else refuses with
 *  SNAPSHOT_DRIFT (honest inconclusive downstream), never a wrong-state
 *  verification. */
async function materializeVerifierWorkspace(input: {
  readonly repository: SentryRepository;
  readonly snapshots: SnapshotEngine;
  readonly dataRoot: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly attemptId: string;
}): Promise<{ workspaceRoot: string; baselineMatch: boolean; driftWarning?: string }> {
  const paths = projectDataPaths(input.dataRoot, input.projectId as never);
  const managedCopy = input.repository.getManagedCopy(input.projectId as never);
  const snapshot = input.repository.getSnapshot(input.snapshotId as never);
  if (snapshot === undefined) {
    throw new VerificationServiceError(
      'SNAPSHOT_NOT_FOUND',
      'Snapshot not found: ' + input.snapshotId,
    );
  }
  const workspaceRoot = resolve(
    input.dataRoot,
    'projects',
    input.projectId,
    'verifier-workspaces',
    input.attemptId,
    'project',
  );
  if (managedCopy?.currentRevisionId !== snapshot.projectRevisionId) {
    return {
      workspaceRoot,
      baselineMatch: false,
      driftWarning:
        'Managed copy revision ' +
        (managedCopy?.currentRevisionId ?? '(none)') +
        ' differs from snapshot revision ' +
        snapshot.projectRevisionId +
        '; refusing wrong-state verification.',
    };
  }
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await copyTree(paths.workingCopy, workspaceRoot, {
    preferReflink: true,
    symlinkPolicy: 'inert-unsafe',
    blockedLinkMetadataRoot: resolve(workspaceRoot, '..', '.sentry-blocked-links'),
  });
  const baseline = await input.snapshots.baselineFileHashes(input.snapshotId as never);
  for (const [relativePath, expectedHash] of baseline) {
    const absolute = resolveInside(workspaceRoot, relativePath);
    let actual: string;
    try {
      const stats = await stat(absolute);
      if (!stats.isFile()) {
        return {
          workspaceRoot,
          baselineMatch: false,
          driftWarning: 'Baseline path is not a regular file: ' + relativePath,
        };
      }
      actual =
        'sha256:' +
        createHash('sha256')
          .update(await readFileBytes(absolute))
          .digest('hex');
    } catch {
      return {
        workspaceRoot,
        baselineMatch: false,
        driftWarning: 'Baseline file absent after materialization: ' + relativePath,
      };
    }
    if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
      return {
        workspaceRoot,
        baselineMatch: false,
        driftWarning: 'Baseline hash mismatch after materialization: ' + relativePath,
      };
    }
  }
  return { workspaceRoot, baselineMatch: true };
}

async function readFileBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

async function destroyWorkspace(workspaceRoot: string): Promise<string | undefined> {
  try {
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    return undefined;
  } catch (cause) {
    return (
      'Verifier workspace cleanup failed: ' +
      (cause instanceof Error ? cause.message : String(cause)).slice(0, 300)
    );
  }
}

/**
 * Explicit post-merge verification (never inside the coordinator).
 * Sequential attempts (§76), incremental durability (§61), isolated
 * per-attempt failure (§63). Never touches QARun/MergeResult/Findings
 * (§55, §64). No model calls (§75: 0 model tokens).
 */
export async function verifyMerge(
  repository: SentryRepository,
  dataRoot: string,
  mergeResultId: string,
  options: VerifyRunOptions = {},
): Promise<{ run: VerificationRun; attempts: VerificationRunAttempt[] }> {
  const now = options.now ?? nowIsoTimestamp();
  const merge = repository.getMergeResult(mergeResultId);
  if (merge === undefined) {
    throw new VerificationServiceError(
      'MERGE_RESULT_NOT_FOUND',
      'MergeResult not found: ' + mergeResultId,
    );
  }
  const requested = options.clusterIds === undefined ? undefined : new Set(options.clusterIds);
  const clusters = repository
    .listClusters(mergeResultId)
    .filter((cluster) => requested === undefined || requested.has(cluster.id));
  if (requested !== undefined) {
    const known = new Set(clusters.map((cluster) => cluster.id));
    for (const id of requested) {
      if (!known.has(id))
        throw new VerificationServiceError(
          'CLUSTER_NOT_FOUND',
          'Cluster not in MergeResult: ' + id,
        );
    }
  }
  if (clusters.length === 0) {
    throw new VerificationServiceError(
      'NO_VERIFIABLE_CLUSTERS',
      'MergeResult has no clusters to verify.',
    );
  }
  const qaRun = repository.getRun(merge.qaRunId);
  if (qaRun === undefined) {
    throw new VerificationServiceError(
      'MERGE_RESULT_NOT_FOUND',
      'QARun not found: ' + merge.qaRunId,
    );
  }
  const snapshots = new SnapshotEngine(dataRoot, repository);
  const operations = resolveOperations(repository, merge.qaRunId);
  const findingsById = new Map<string, Finding>(
    repository.listFindings(merge.qaRunId).map((finding) => [finding.id, finding]),
  );
  const evidenceById = new Map<string, Evidence>(
    repository.listEvidence(merge.qaRunId).map((evidence) => [evidence.id, evidence]),
  );
  const run: VerificationRun = {
    schemaVersion: 1,
    id: createVerificationRunId(),
    mergeResultId: merge.id,
    qaRunId: merge.qaRunId,
    projectSnapshotId: merge.projectSnapshotId,
    ...(merge.projectContextSnapshotId === undefined
      ? {}
      : { projectContextSnapshotId: merge.projectContextSnapshotId }),
    verifierVersion: VERIFIER_VERSION,
    recipeVersion: VERIFICATION_RECIPE_VERSION,
    signatureVersion: VERIFICATION_SIGNATURE_VERSION,
    status: 'running',
    requestedClusterIds: clusters.map(
      (cluster) => cluster.id,
    ) as VerificationRun['requestedClusterIds'],
    environmentFingerprint: environmentFingerprint(),
    warnings: [],
    attemptIds: [],
    createdAt: now,
    startedAt: now,
  };
  repository.saveVerificationRun(run);
  const runner = options.runner ?? new VerificationCommandRunner();
  const attempts: VerificationRunAttempt[] = [];
  let completedCount = 0;
  let failedCount = 0;
  for (const cluster of clusters) {
    // Failure isolation (§63, §99): a crashing attempt becomes a failed
    // attempt with the crash recorded — completed siblings stay valid
    // and the run becomes partial, never aborted mid-list.
    let attempt: VerificationRunAttempt;
    try {
      attempt = await verifyCluster({
        repository,
        dataRoot,
        snapshots,
        runner,
        run,
        clusterId: cluster.id,
        findings: cluster.sourceFindingIds
          .map((id) => findingsById.get(id))
          .filter((finding): finding is Finding => finding !== undefined),
        evidenceById,
        operations,
        commandTimeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        now,
      });
    } catch (cause) {
      attempt = {
        schemaVersion: 1,
        id: createVerificationAttemptId(),
        verificationRunId: run.id,
        findingClusterId: cluster.id,
        status: 'failed',
        recipeVersion: VERIFICATION_RECIPE_VERSION,
        recipeDigest: ('sha256:' + '0'.repeat(64)) as VerificationRunAttempt['recipeDigest'],
        steps: [],
        sourceFindingIds: cluster.sourceFindingIds as VerificationRunAttempt['sourceFindingIds'],
        sourceEvidenceIds: [],
        failure: {
          code: 'VERIFIER_ATTEMPT_CRASH',
          message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
        },
        limitations: ['Attempt crashed before recipe evaluation completed.'],
        startedAt: now,
        completedAt: nowIsoTimestamp(),
      };
      repository.saveVerificationAttempt(attempt);
    }
    attempts.push(attempt);
    run.attemptIds.push(attempt.id);
    if (attempt.status === 'completed') completedCount += 1;
    else failedCount += 1;
    repository.saveVerificationRun({
      ...run,
      status: 'running',
      attemptIds: [...run.attemptIds],
      warnings: [...run.warnings],
    });
  }
  const finished: VerificationRun = {
    ...run,
    status: failedCount === 0 ? 'completed' : completedCount === 0 ? 'failed' : 'partial',
    completedAt: nowIsoTimestamp(),
  };
  repository.saveVerificationRun(finished);
  return { run: finished, attempts };
}

async function verifyCluster(input: {
  readonly repository: SentryRepository;
  readonly dataRoot: string;
  readonly snapshots: SnapshotEngine;
  readonly runner: VerificationCommandRunner;
  readonly run: VerificationRun;
  readonly clusterId: string;
  readonly findings: readonly Finding[];
  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly operations: ReadonlyMap<string, CanonicalOperation>;
  readonly commandTimeoutMs: number;
  readonly now: IsoTimestamp;
}): Promise<VerificationRunAttempt> {
  const attemptId = createVerificationAttemptId();
  const qaRun = input.repository.getRun(input.run.qaRunId);
  if (qaRun === undefined) {
    throw new VerificationServiceError(
      'MERGE_RESULT_NOT_FOUND',
      'QARun vanished mid-verification.',
    );
  }
  const materialized = await materializeVerifierWorkspace({
    repository: input.repository,
    snapshots: input.snapshots,
    dataRoot: input.dataRoot,
    projectId: qaRun.projectId,
    snapshotId: input.run.projectSnapshotId,
    attemptId,
  });
  const { steps, digest, warnings } = buildRecipe({
    snapshotId: input.run.projectSnapshotId,
    clusterId: input.clusterId,
    findings: input.findings,
    evidenceById: input.evidenceById,
    operationsById: input.operations,
  });
  const baseAttempt: VerificationRunAttempt = {
    schemaVersion: 1,
    id: attemptId,
    verificationRunId: input.run.id,
    findingClusterId: input.clusterId,
    status: 'running',
    recipeVersion: VERIFICATION_RECIPE_VERSION,
    recipeDigest: digest as VerificationRunAttempt['recipeDigest'],
    steps: steps.map((step) => ({ ...step, status: 'queued' as const })),
    sourceFindingIds: input.findings.map(
      (finding) => finding.id,
    ) as VerificationRunAttempt['sourceFindingIds'],
    sourceEvidenceIds: [
      ...new Set(input.findings.flatMap((finding) => finding.evidenceIds)),
    ].sort() as VerificationRunAttempt['sourceEvidenceIds'],
    workspaceProvenance: {
      snapshotId: input.run.projectSnapshotId,
      workspacePath: materialized.workspaceRoot,
      materializedAt: nowIsoTimestamp(),
      baselineMatch: materialized.baselineMatch,
    },
    limitations: materialized.baselineMatch
      ? []
      : [materialized.driftWarning ?? 'Snapshot drift detected.'],
    startedAt: input.now,
  };
  input.repository.saveVerificationAttempt(baseAttempt);
  for (const step of baseAttempt.steps) input.repository.saveVerificationStep(attemptId, step);
  // Snapshot drift refuses wrong-state verification (§95): the recipe
  // is recorded, every replayable step stays unevaluated, outcome is
  // inconclusive with the drift limitation. Workspace still cleaned.
  if (!materialized.baselineMatch) {
    for (const warning of warnings) input.run.warnings.push(warning);
    const classified = classifyAttempt(baseAttempt.steps);
    return await finalizeAttempt(input, baseAttempt, materialized.workspaceRoot, classified);
  }
  const fs = {
    stat: async (path: string) => {
      const stats = await stat(path);
      return { isFile: stats.isFile(), isDirectory: stats.isDirectory() };
    },
    readLines: async (path: string, startLine?: number, endLine?: number) => {
      const content = await readFile(path, 'utf8');
      const lines = content.split('\n');
      if (startLine !== undefined && (startLine < 1 || startLine > lines.length + 1)) {
        return { present: false };
      }
      if (endLine !== undefined && endLine < (startLine ?? 1)) return { present: false };
      return { present: true };
    },
  };
  const executed: ExecutedStep[] = [];
  const assertionSources: VerificationRecipeStep[] = [];
  for (const step of baseAttempt.steps) {
    const running: VerificationRecipeStep = {
      ...step,
      status: 'running',
      startedAt: nowIsoTimestamp(),
    };
    input.repository.saveVerificationStep(attemptId, running);
    let executedStep: ExecutedStep;
    if (step.type === 'source_integrity') {
      executedStep = await executeSourceIntegrity(step, {
        workspaceRoot: materialized.workspaceRoot,
        fs,
        runner: input.runner,
        operationsById: input.operations,
        commandTimeoutMs: input.commandTimeoutMs,
        redact: redactSecrets,
      });
    } else if (step.type === 'command_replay' || step.type === 'test_replay') {
      executedStep = await executeReplay(step, {
        workspaceRoot: materialized.workspaceRoot,
        fs,
        runner: input.runner,
        operationsById: input.operations,
        commandTimeoutMs: input.commandTimeoutMs,
        redact: redactSecrets,
      });
    } else {
      executedStep = {
        outcome: 'unsupported',
        artifactPayloads: [],
        detail:
          step.type === 'environment_check'
            ? 'Environment recorded at run level; no per-step check in v1.'
            : 'No v1 replay semantics for this claim; see limitations.',
      };
    }
    const finished: VerificationRecipeStep = {
      ...running,
      status: 'completed',
      outcome: executedStep.outcome,
      observationIds:
        executedStep.exitCode === undefined && executedStep.diagnosticFingerprint === undefined
          ? []
          : [createVerificationObservationId()],
      completedAt: nowIsoTimestamp(),
    };
    input.repository.saveVerificationStep(attemptId, finished);
    assertionSources.push(finished);
    if (finished.observationIds.length > 0) {
      const observation: VerificationObservation = {
        schemaVersion: 1,
        id: finished.observationIds[0] as VerificationObservation['id'],
        artifactIds: [],
        verificationAttemptId: attemptId,
        stepId: finished.id,
        type: finished.type,
        ...(executedStep.exitCode === undefined ? {} : { exitCode: executedStep.exitCode }),
        ...(executedStep.diagnosticFingerprint === undefined
          ? {}
          : { diagnosticFingerprint: executedStep.diagnosticFingerprint }),
        startedAt: running.startedAt as IsoTimestamp,
        completedAt: finished.completedAt as IsoTimestamp,
        outcome: finished.outcome as VerificationObservation['outcome'],
      };
      // Large stdout/stderr goes to the artifact store, never SQLite JSON (§74).
      const store = new FilesystemArtifactStore(input.dataRoot, input.repository);
      const qaRunId = input.run.qaRunId;
      const payloads = executedStep.artifactPayloads[0];
      if (payloads !== undefined && (payloads.stdout.length > 0 || payloads.stderr.length > 0)) {
        const artifact = await store.write({
          relativePath:
            'projects/' + qaRun.projectId + '/verifier/' + attemptId + '/' + finished.id + '.log',
          type: 'log',
          source: (async function* (): AsyncGenerator<string> {
            yield payloads.stdout;
            yield '\n--- stderr ---\n';
            yield payloads.stderr;
          })(),
          projectId: qaRun.projectId,
          qaRunId,
          mimeType: 'text/plain',
        });
        observation.artifactIds.push(artifact.id);
      }
      input.repository.saveVerificationObservation(attemptId, observation);
    }
    executed.push(executedStep);
  }
  for (const warning of warnings) input.run.warnings.push(warning);
  const classified = classifyAttempt(assertionSources);
  return await finalizeAttempt(input, baseAttempt, materialized.workspaceRoot, classified);
}

async function finalizeAttempt(
  input: {
    readonly repository: SentryRepository;
    readonly dataRoot: string;
    readonly run: VerificationRun;
  },
  base: VerificationRunAttempt,
  workspaceRoot: string,
  classified: {
    outcome: VerificationRunAttempt['outcome'];
    assertions: {
      subject: VerificationAssertion['subject'];
      state: VerificationAssertion['state'];
      detail: string;
      sourceEvidenceIds: string[];
      observationIds: string[];
    }[];
  },
): Promise<VerificationRunAttempt> {
  const completedSteps = input.repository.listVerificationSteps(base.id);
  const finished: VerificationRunAttempt = {
    ...base,
    status: 'completed',
    outcome: classified.outcome as VerificationRunAttempt['outcome'],
    steps: completedSteps,
    completedAt: nowIsoTimestamp(),
  };
  // Atomic attempt finalization: completed payload lands once (§60).
  input.repository.transaction(() => {
    input.repository.saveVerificationAttempt(finished);
    for (const assertion of classified.assertions) {
      input.repository.saveVerificationAssertion(base.id, {
        schemaVersion: 1,
        verificationAttemptId: base.id,
        subject: assertion.subject,
        state: assertion.state,
        detail: assertion.detail,
        sourceEvidenceIds:
          assertion.sourceEvidenceIds as VerificationAssertion['sourceEvidenceIds'],
        observationIds: assertion.observationIds as VerificationAssertion['observationIds'],
      });
    }
  });
  const cleanupWarning = await destroyWorkspace(workspaceRoot);
  if (cleanupWarning !== undefined) {
    input.run.warnings.push({ code: 'VERIFIER_CLEANUP_FAILED', message: cleanupWarning });
  }
  return finished;
}
