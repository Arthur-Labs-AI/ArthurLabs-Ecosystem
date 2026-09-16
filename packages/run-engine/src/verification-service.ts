import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  buildRecipe,
  classifyAttempt,
  diagnosticFingerprint,
  executeReplay,
  executeSourceIntegrity,
  redactSecrets,
  SystemdSandboxBackend,
  UnavailableSandboxBackend,
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
  resolveInside,
  type SentryRepository,
} from '@qa/persistence';
import { SnapshotEngine } from '@qa/snapshot-engine';
import { ProjectManager } from '@qa/project-manager';
import {
  createVerificationAttemptId,
  createVerificationObservationId,
  createVerificationRunId,
  nowIsoTimestamp,
  type IsoTimestamp,
  type ProjectId,
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

/** Crash recovery (§64-65): mark verification runs/attempts owned by
 *  a stale runtime as interrupted. Completed observations are
 *  preserved; abandoned verifier workspaces are removed where safely
 *  attributable (path contains the attempt id under verifier-workspaces).
 *  Uses the existing RuntimeInstanceLease freshness — no parallel lease
 *  system. Called from RunCoordinator.recover(). */
export async function recoverVerifications(
  repository: SentryRepository,
  isFresh: (instanceId: string) => boolean,
): Promise<{ runs: number; attempts: number }> {
  const now = nowIsoTimestamp();
  let runs = 0;
  let attempts = 0;
  for (const run of repository.listNonterminalVerificationRuns()) {
    const owner = run.runtimeInstanceId;
    if (owner !== undefined && isFresh(owner)) continue;
    // Unowned runs (no lease binding, e.g. tests) are left alone:
    // only stale-owned rows are recoverable crash evidence.
    if (owner === undefined) continue;
    for (const attempt of repository.listVerificationAttempts(run.id)) {
      if (attempt.status === 'completed') continue;
      if (attempt.status === 'failed' || attempt.status === 'cancelled') continue;
      const interruptedSteps = attempt.steps.map((step) =>
        step.status === 'running'
          ? { ...step, status: 'interrupted' as const, completedAt: now }
          : step,
      );
      for (const step of interruptedSteps) {
        if (step.status === 'interrupted') repository.saveVerificationStep(attempt.id, step);
      }
      repository.saveVerificationAttempt({
        ...attempt,
        status: 'interrupted',
        steps: interruptedSteps,
        limitations: [...attempt.limitations, 'Sentry stopped before the attempt completed.'],
        completedAt: now,
      });
      attempts += 1;
      const workspace = attempt.workspaceProvenance?.workspacePath;
      if (
        workspace !== undefined &&
        workspace.includes('verifier-workspaces') &&
        workspace.includes(attempt.id)
      ) {
        await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const remaining = repository.listVerificationAttempts(run.id);
    const completed = remaining.filter((a) => a.status === 'completed').length;
    repository.saveVerificationRun({
      ...run,
      status: completed > 0 ? 'partial' : 'interrupted',
      completedAt: now,
    });
    runs += 1;
  }
  return { runs, attempts };
}

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
  /** Lease binding for crash recovery: the owning runtime instance.
   *  A sweeper marks stale-owned running rows interrupted (§64-65). */
  readonly runtimeInstanceId?: string;
  /** Test-only seam: override per-attempt runner construction.
   *  Production always builds sandbox-backed runners. */
  readonly createRunner?: (attemptRoot: string) => VerificationCommandRunner;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

function environmentFingerprint(sandbox: {
  backend: string;
  available: boolean;
  reason?: string;
}): VerificationRun['environmentFingerprint'] {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    packageManagerVersions: {},
    runtimes: [
      'sandboxBackend=' + sandbox.backend,
      'sandboxAvailable=' + String(sandbox.available),
      'runtimeReplaySupported=' + String(sandbox.available),
      ...(sandbox.reason === undefined ? [] : ['sandboxReason=' + sandbox.reason.slice(0, 200)]),
    ],
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

/** Materialize a fresh verifier workspace from the RETAINED IMMUTABLE
 *  revision bytes (§41) and prove it matches the historical snapshot:
 *  every manifest baseline hash must reproduce. The managed working
 *  copy is never consulted, so project updates (A → B) don't break
 *  verification of A (§42). Missing/corrupt material refuses with a
 *  drift limitation (honest inconclusive, §43-44), never a wrong-state
 *  verification. */
async function materializeVerifierWorkspace(input: {
  readonly repository: SentryRepository;
  readonly snapshots: SnapshotEngine;
  readonly revisionMaterial: (projectId: string, revisionId: string) => Promise<string | undefined>;
  readonly dataRoot: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly attemptId: string;
}): Promise<{ workspaceRoot: string; baselineMatch: boolean; driftWarning?: string }> {
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
  const materialRoot = await input.revisionMaterial(input.projectId, snapshot.projectRevisionId);
  if (materialRoot === undefined) {
    return {
      workspaceRoot,
      baselineMatch: false,
      driftWarning:
        'No retained material for revision ' +
        snapshot.projectRevisionId +
        ' (predates retention); refusing to verify from moved-on state.',
    };
  }
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await copyTree(materialRoot, workspaceRoot, {
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

/** Load canonical original stdout/stderr artifacts for replayable
 *  evidence and derive versioned signatures (§22). Bounded reads;
 *  redacted before normalization; failures yield no entry (never
 *  fabricated, never fatal). */
async function resolveOriginalSignatures(
  repository: SentryRepository,
  dataRoot: string,
  findings: readonly Finding[],
  evidenceById: ReadonlyMap<string, Evidence>,
): Promise<Map<string, string>> {
  const store = new FilesystemArtifactStore(dataRoot, repository);
  const signatures = new Map<string, string>();
  const evidenceIds = new Set(findings.flatMap((finding) => finding.evidenceIds));
  for (const evidenceId of evidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (evidence === undefined) continue;
    const artifactIds =
      evidence.type === 'command'
        ? [evidence.command.stdoutArtifactId, evidence.command.stderrArtifactId]
        : evidence.type === 'runtime'
          ? [evidence.runtime.logArtifactId]
          : evidence.type === 'test'
            ? [evidence.test.artifactId]
            : [];
    let combined = '';
    for (const artifactId of artifactIds) {
      if (artifactId === undefined) continue;
      const artifact = repository.getArtifact(artifactId);
      if (artifact === undefined) continue;
      try {
        const stream = store.open(artifact);
        let bytes = 0;
        for await (const chunk of stream) {
          if (bytes >= 65536) break;
          combined += (chunk as Buffer).toString('utf8').slice(0, 65536 - bytes);
          bytes += (chunk as Buffer).length;
        }
        stream.destroy();
      } catch {
        // Unreadable original artifact: no signature, no failure.
      }
    }
    if (combined.length > 0) {
      signatures.set(evidenceId, diagnosticFingerprint(redactSecrets(combined), ''));
    }
  }
  return signatures;
}

async function destroyWorkspace(workspaceRoot: string): Promise<string | undefined> {
  // Remove the whole attempt directory (project copy AND its parent),
  // not just the project subtree — no empty litter remains. The path
  // is constructed internally under verifier-workspaces, never from
  // model or user input, so dirname() cannot escape Sentry storage.
  const { dirname } = await import('node:path');
  try {
    await rm(dirname(workspaceRoot), {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 50,
    });
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
  const projects = new ProjectManager(dataRoot, repository);
  const operations = resolveOperations(repository, merge.qaRunId);
  const findingsById = new Map<string, Finding>(
    repository.listFindings(merge.qaRunId).map((finding) => [finding.id, finding]),
  );
  const evidenceById = new Map<string, Evidence>(
    repository.listEvidence(merge.qaRunId).map((evidence) => [evidence.id, evidence]),
  );
  // Backend selection first: preflight determines the environment
  // fingerprint stamped on the run. Real sandbox when preflight
  // passes, otherwise honest unavailable (§13, §71) — replay steps
  // become unsupported, source integrity still runs. NEVER host fallback.
  const probe = new SystemdSandboxBackend();
  const availability = await probe.preflight(dataRoot);
  const backend = availability.available
    ? probe
    : new UnavailableSandboxBackend(availability.reason ?? 'sandbox backend unavailable');
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
    ...(options.runtimeInstanceId === undefined
      ? {}
      : { runtimeInstanceId: options.runtimeInstanceId }),
    requestedClusterIds: clusters.map(
      (cluster) => cluster.id,
    ) as VerificationRun['requestedClusterIds'],
    environmentFingerprint: environmentFingerprint({
      backend: probe.id,
      available: availability.available,
      ...(availability.reason === undefined ? {} : { reason: availability.reason }),
    }),
    warnings: [],
    attemptIds: [],
    createdAt: now,
    startedAt: now,
  };
  repository.saveVerificationRun(run);
  if (!availability.available) {
    run.warnings.push({
      code: 'VERIFIER_SANDBOX_UNAVAILABLE',
      message:
        'Replay sandbox unavailable (' +
        backend.id +
        '): ' +
        (availability.reason ?? 'unknown reason'),
    });
  }
  const createRunner =
    options.createRunner ??
    ((attemptRoot: string) => new VerificationCommandRunner(backend, attemptRoot));
  const attempts: VerificationRunAttempt[] = [];
  let completedCount = 0;
  let failedCount = 0;
  for (const cluster of clusters) {
    // One cluster = exactly one attempt ID (§17-20): the ID is created
    // here, the running row persisted before any fallible work, and any
    // crash terminalizes THIS id (never a second one). Siblings stay
    // valid; the run becomes partial, never aborted mid-list.
    const attemptId = createVerificationAttemptId();
    const runningAttempt: VerificationRunAttempt = {
      schemaVersion: 1,
      id: attemptId,
      verificationRunId: run.id,
      findingClusterId: cluster.id,
      status: 'running',
      recipeVersion: VERIFICATION_RECIPE_VERSION,
      recipeDigest: ('sha256:' + '0'.repeat(64)) as VerificationRunAttempt['recipeDigest'],
      steps: [],
      sourceFindingIds: cluster.sourceFindingIds as VerificationRunAttempt['sourceFindingIds'],
      sourceEvidenceIds: [],
      limitations: [],
      startedAt: now,
    };
    repository.saveVerificationAttempt(runningAttempt);
    let attempt: VerificationRunAttempt;
    try {
      attempt = await verifyCluster({
        repository,
        dataRoot,
        snapshots,
        revisionMaterial: (projectId: string, revisionId: string) =>
          projects.revisionMaterialRoot(projectId as never, revisionId),
        createRunner,
        run,
        attemptId,
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
      // Same ID terminalizes as failed (§19-20): materialization,
      // recipe, runner, artifact, classifier, or commit failure.
      attempt = {
        ...runningAttempt,
        status: 'failed',
        steps: repository.listVerificationSteps(attemptId),
        failure: {
          code: 'VERIFIER_ATTEMPT_CRASH',
          message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
        },
        limitations: [...runningAttempt.limitations, 'Attempt crashed before completion.'],
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
  readonly revisionMaterial: (projectId: string, revisionId: string) => Promise<string | undefined>;
  readonly createRunner: (attemptRoot: string) => VerificationCommandRunner;
  readonly run: VerificationRun;
  readonly attemptId: VerificationRunAttempt['id'];
  readonly clusterId: string;
  readonly findings: readonly Finding[];
  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly operations: ReadonlyMap<string, CanonicalOperation>;
  readonly commandTimeoutMs: number;
  readonly now: IsoTimestamp;
}): Promise<VerificationRunAttempt> {
  // The attempt ID is owned by the caller (§18): this layer never
  // creates one. The running row already exists.
  const attemptId = input.attemptId;
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
    revisionMaterial: input.revisionMaterial,
    dataRoot: input.dataRoot,
    projectId: qaRun.projectId,
    snapshotId: input.run.projectSnapshotId,
    attemptId,
  });
  // Original-output signatures (§22): load canonical stdout/stderr
  // artifacts per evidence, redact + normalize with the versioned
  // algorithm. Absent artifacts simply yield no comparison downstream.
  const originalSignatures = await resolveOriginalSignatures(
    input.repository,
    input.dataRoot,
    input.findings,
    input.evidenceById,
  );
  const { steps, digest, warnings } = buildRecipe({
    snapshotId: input.run.projectSnapshotId,
    clusterId: input.clusterId,
    findings: input.findings,
    evidenceById: input.evidenceById,
    operationsById: input.operations,
    originalSignatures,
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
  // Ownership scope (§27-29): one runner per attempt (disposable HOME
  // + tracked process groups). finally guarantees runner dispose and
  // workspace removal across success, classifier failure, artifact
  // failure, repository failure, runner failure, timeout, and
  // unexpected exceptions.
  // The backend owns disposable HOME creation (inside createEnvironment);
  // attemptRoot derives from the workspace path (both constructed
  // internally, never from model/user input).
  const runner = input.createRunner(dirname(materialized.workspaceRoot));
  try {
    return await executeAttemptSteps({
      repository: input.repository,
      dataRoot: input.dataRoot,
      runner,
      run: input.run,
      runQaRun: qaRun,
      operations: input.operations,
      commandTimeoutMs: input.commandTimeoutMs,
      attemptId,
      clusterId: input.clusterId,
      findings: input.findings,
      baseAttempt,
      materialized,
      warnings,
    });
  } finally {
    const disposeState = await runner.dispose();
    if (disposeState !== 'clean') {
      input.run.warnings.push({
        code: 'VERIFIER_PROCESS_CLEANUP_FAILED',
        message: 'Verifier process tree cleanup reported leftovers for attempt ' + attemptId,
      });
    }
    const cleanupWarning = await destroyWorkspace(materialized.workspaceRoot);
    if (cleanupWarning !== undefined) {
      input.run.warnings.push({ code: 'VERIFIER_CLEANUP_FAILED', message: cleanupWarning });
    }
  }
}

async function executeAttemptSteps(input: {
  readonly repository: SentryRepository;
  readonly dataRoot: string;
  readonly runner: VerificationCommandRunner;
  readonly run: VerificationRun;
  readonly runQaRun: { readonly projectId: ProjectId };
  readonly operations: ReadonlyMap<string, CanonicalOperation>;
  readonly commandTimeoutMs: number;
  readonly attemptId: VerificationRunAttempt['id'];
  readonly clusterId: string;
  readonly findings: readonly Finding[];
  readonly baseAttempt: VerificationRunAttempt;
  readonly materialized: {
    readonly workspaceRoot: string;
    readonly baselineMatch: boolean;
    readonly driftWarning?: string;
  };
  readonly warnings: { code: string; message: string }[];
}): Promise<VerificationRunAttempt> {
  const attemptId = input.attemptId;
  const qaRun = { projectId: input.runQaRun.projectId };
  const materialized = input.materialized;
  const warnings = input.warnings;
  const baseAttempt = input.baseAttempt;
  // Snapshot drift refuses wrong-state verification (§95): the recipe
  // is recorded, every replayable step stays unevaluated, outcome is
  // inconclusive with the drift limitation. The outer finally still
  // disposes the runner and removes the workspace.
  if (!materialized.baselineMatch) {
    for (const warning of warnings) input.run.warnings.push(warning);
    const classified = classifyAttempt(baseAttempt.steps);
    return await finalizeAttempt(
      {
        repository: input.repository,
        dataRoot: input.dataRoot,
        run: input.run,
      },
      baseAttempt,
      materialized.workspaceRoot,
      classified,
    );
  }
  const fs = {
    stat: async (path: string) => {
      const stats = await stat(path);
      return { isFile: stats.isFile(), isDirectory: stats.isDirectory() };
    },
    readLines: async (
      path: string,
      startLine: number | undefined,
      endLine: number | undefined,
      expectedHash: string | undefined,
    ) => {
      // Whole-file byte hash with the exact evidence semantics
      // (sha256 over raw bytes, §33): excerpts never substitute.
      const bytes = await readFileBytes(path);
      const lines = bytes.toString('utf8').split('\n');
      if (startLine !== undefined && (startLine < 1 || startLine > lines.length + 1)) {
        return { present: false };
      }
      if (endLine !== undefined && endLine < (startLine ?? 1)) return { present: false };
      if (expectedHash === undefined) return { present: true };
      const actual = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      return { present: true, hashMatch: actual.toLowerCase() === expectedHash.toLowerCase() };
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
      ...(executedStep.matchStrength === undefined
        ? {}
        : { matchStrength: executedStep.matchStrength }),
      observationIds:
        executedStep.exitCode === undefined &&
        executedStep.diagnosticFingerprint === undefined &&
        executedStep.sourceCheck === undefined
          ? []
          : [createVerificationObservationId()],
      completedAt: nowIsoTimestamp(),
    };
    if (executedStep.warningCode !== undefined) {
      input.run.warnings.push({
        code: executedStep.warningCode,
        message: executedStep.detail.slice(0, 500),
      });
    }
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
        ...(executedStep.sourceCheck === undefined
          ? {}
          : { sourceCheck: executedStep.sourceCheck }),
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
