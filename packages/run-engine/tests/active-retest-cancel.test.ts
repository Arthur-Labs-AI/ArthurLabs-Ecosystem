/** Micro-patch regression (§16-§25): an ACTIVE Retest propagates foreign
 *  cancellation to its running child QARun with no manual intervention. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  IssueEventSchema,
  IssueOccurrenceSchema,
  IssueSchema,
  VerificationRunAttemptSchema,
  VerificationRunSchema,
  issueIngestKey,
  type VerificationRun,
  type VerificationRunAttempt,
} from '@qa/schemas';
import {
  createHarnessEventId,
  createIssueEventId,
  createIssueId,
  createIssueOccurrenceId,
  createVerificationAttemptId,
  createVerificationRunId,
  createVerificationStepId,
  nowIsoTimestamp,
} from '@qa/shared';
import {
  HarnessAdapterRegistry,
  type HarnessAdapter,
  type HarnessRunRequest,
} from '@qa/harness-protocol';
import { HarnessEventSchema } from '@qa/schemas';
import { mergeRun, retestIssue, requestRetestCancellation } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

/** Blocking adapter: starts, blocks until cancel(), then terminates cancelled. */
class BlockingAdapter implements HarnessAdapter {
  started = false;
  cancelCalls = 0;
  private cancelled = false;
  async getMetadata() {
    return {
      adapterId: 'blocking',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'Blocking',
      capabilities: {},
    };
  }
  async healthCheck() {
    return { status: 'healthy' as const, checks: [], checkedAt: nowIsoTimestamp() };
  }
  async *run(request: HarnessRunRequest) {
    const t = nowIsoTimestamp();
    const emit = (event: unknown) => HarnessEventSchema.parse(event);
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: t,
      type: 'run.started',
    });
    this.started = true;
    while (!this.cancelled) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: nowIsoTimestamp(),
      type: 'run.cancelled',
      reason: 'cancel delivered',
    });
  }
  async cancel() {
    this.cancelCalls += 1;
    this.cancelled = true;
  }
  async dispose() {}
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-active-retest-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src', 'auth'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  await writeFile(join(source, 'src', 'auth', 'login.ts'), 'export const login = 1;\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  return { root, source, dataRoot, database, repository, lease, manager, added };
}

async function waitFor(condition: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function stubVerifyFail() {
  return async (
    repository: SentryRepository,
    _dataRoot: string,
    mergeResultId: string,
  ): Promise<{ run: VerificationRun; attempts: VerificationRunAttempt[] }> => {
    const merge = repository.getMergeResult(mergeResultId);
    if (merge === undefined) throw new Error('merge missing');
    const t = nowIsoTimestamp();
    const run = VerificationRunSchema.parse({
      schemaVersion: 1,
      id: createVerificationRunId(),
      mergeResultId: merge.id,
      qaRunId: merge.qaRunId,
      projectSnapshotId: merge.projectSnapshotId,
      verifierVersion: 3,
      recipeVersion: 3,
      signatureVersion: 3,
      status: 'completed',
      requestedClusterIds: merge.clusters.map((cluster) => cluster.id),
      attemptIds: [],
      createdAt: t,
      startedAt: t,
      completedAt: t,
    });
    repository.saveVerificationRun(run);
    const attempts: VerificationRunAttempt[] = [];
    for (const cluster of merge.clusters) {
      const attempt = VerificationRunAttemptSchema.parse({
        schemaVersion: 1,
        id: createVerificationAttemptId(),
        verificationRunId: run.id,
        findingClusterId: cluster.id,
        status: 'completed',
        recipeVersion: 3,
        recipeDigest: 'sha256:' + 'a'.repeat(64),
        outcome: 'reproduced',
        steps: [],
        sourceFindingIds: cluster.sourceFindingIds,
        sourceEvidenceIds: [],
        startedAt: t,
        completedAt: t,
      });
      repository.saveVerificationAttempt(attempt);
      const step = {
        id: createVerificationStepId(),
        type: 'test_replay',
        recipeFingerprint: 'sha256:' + 'b'.repeat(64),
        sourceEvidenceIds: [],
        sourceOperationIds: [],
        expected: { testName: 'target Test A', testStatus: 'failed' },
        status: 'completed',
        matchStrength: 'strong_match',
        outcome: 'matched',
        observationIds: [],
        startedAt: t,
        completedAt: t,
      };
      repository.saveVerificationStep(attempt.id, step as never);
      attempts.push({ ...attempt, steps: [step] } as never);
    }
    repository.saveVerificationRun({ ...run, attemptIds: attempts.map((attempt) => attempt.id) });
    return { run: { ...run, attemptIds: attempts.map((attempt) => attempt.id) }, attempts };
  };
}

describe('micro-patch §16-§25: active Retest propagates foreign cancel to the running child', () => {
  it('foreign request cancels owned adapters, child, and Retest with audit intact', async () => {
    const f = await fixture();
    // Source run A with a scripted failing finding (single fast adapter).
    const { RunCoordinator } = await import('../src/index.js');
    const { createFakeHarnessRegistry } = await import('../src/index.js');
    const runA = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      createFakeHarnessRegistry('success'),
    ).run(f.added.project.id, { executionKind: 'simulation', runTimeoutMs: 30_000 });
    const { result: mergeA } = mergeRun(f.repository, runA.run.id);
    expect(mergeA.clusters.length).toBeGreaterThan(0);
    const verifiedA = await stubVerifyFail()(f.repository, f.dataRoot, mergeA.id);
    const clusterA = mergeA.clusters[0];
    if (clusterA === undefined) throw new Error('no cluster');
    const t = nowIsoTimestamp();
    const issueId = createIssueId();
    const occurrenceId = createIssueOccurrenceId();
    const revision = f.repository.listRevisions(f.added.project.id)[0];
    if (revision === undefined) throw new Error('revision missing');
    f.repository.transaction(() => {
      f.repository.saveIssue(
        IssueSchema.parse({
          schemaVersion: 1,
          id: issueId,
          projectId: f.added.project.id,
          title: 'Active cancel fixture',
          category: 'logic',
          severity: 'high',
          createdAt: t,
          updatedAt: t,
        }),
      );
      f.repository.saveIssueOccurrence(
        IssueOccurrenceSchema.parse({
          schemaVersion: 1,
          id: occurrenceId,
          issueId,
          projectId: f.added.project.id,
          projectRevisionId: revision.id,
          projectSnapshotId: runA.run.snapshotId,
          qaRunId: runA.run.id,
          mergeResultId: mergeA.id,
          findingClusterId: clusterA.id,
          verificationRunId: verifiedA.run.id,
          createdAt: t,
        }),
      );
      f.repository.saveIngestKey(
        issueIngestKey({ mergeResultId: mergeA.id, findingClusterId: clusterA.id }),
        issueId,
        occurrenceId,
      );
      f.repository.appendIssueEvent(
        IssueEventSchema.parse({
          schemaVersion: 1,
          id: createIssueEventId(),
          issueId,
          projectId: f.added.project.id,
          kind: 'created',
          toState: 'open',
          occurrenceId,
          message: 'first occurrence',
          createdAt: t,
        }),
      );
    });
    // Revision B exists but keeps the historical path (blocking child needs no findings).
    await writeFile(join(f.source, 'src', 'auth', 'login.ts'), 'export const login = 2;\n');
    await f.manager.updateProjectCopy(f.added.project.id);
    // Blocking child registry (one stack is enough to prove propagation).
    const blockers = [new BlockingAdapter()];
    const childRegistry = new HarnessAdapterRegistry();
    childRegistry.register({
      stack: INITIAL_AGENT_STACKS[0] as never,
      runtimeIdentity: { modelId: (INITIAL_AGENT_STACKS[0] as never).model.modelId },
      createAdapter: () => blockers[0] as never,
    });
    const workspacePaths: string[] = [];
    const retestPromise = retestIssue(
      { dataRoot: f.dataRoot, repository: f.repository, lease: f.lease, registry: childRegistry },
      issueId,
      {
        agentStackIds: [INITIAL_AGENT_STACKS[0]?.id as never],
        runTimeoutMs: 120_000,
        onHarnessRequest: (request) => workspacePaths.push(request.workspace.runtimePath),
      },
    );
    // Wait until spec + child linkage + adapter start are all durable.
    let retestId: string | undefined;
    await waitFor(() => {
      const runs = f.repository.listRetestRuns(issueId);
      const latest = runs[runs.length - 1];
      if (latest === undefined) return false;
      retestId = latest.id;
      return (
        f.repository.getRetestSpec(latest.id) !== undefined &&
        latest.targetQaRunId !== undefined &&
        (blockers[0]?.started ?? false)
      );
    });
    if (retestId === undefined) throw new Error('retest never started');
    const childRunId = f.repository.getRetestRun(retestId)?.targetQaRunId;
    expect(childRunId).toBeDefined();
    // Foreign context: second repository + lease on the same database.
    const {
      SentryDatabase: DB2,
      SentryRepository: Repo2,
      RuntimeInstanceLease: Lease2,
    } = await import('@qa/persistence');
    const database2 = new DB2({ dataRoot: f.dataRoot });
    const repository2 = new Repo2(database2);
    const lease2 = new Lease2(repository2, { autoHeartbeat: false });
    lease2.start();
    const foreign = {
      dataRoot: f.dataRoot,
      repository: repository2,
      lease: lease2,
      registry: new HarnessAdapterRegistry(),
    };
    // §17: foreign request reports cancellation_requested; Retest not terminal yet.
    const requested = requestRetestCancellation(foreign, retestId);
    expect(requested.status).toBe('cancellation_requested');
    expect(f.repository.getRetestRun(retestId)?.status).toBe('agents_running');
    // §18: child request exists immediately — the exact regression.
    const childRequest = f.repository.getRunControlRequest(childRunId as never);
    expect(childRequest).toBeDefined();
    expect(childRequest?.requestedAt).toBeDefined();
    // ONLY WAIT from here — no manual ack, no manual cancel.
    await waitFor(() => (blockers[0]?.cancelCalls ?? 0) > 0);
    const result = await retestPromise;
    // §20-21: child cancelled; Retest cancelled; no assessment.
    expect(result.targetRun?.status).toBe('cancelled');
    expect(result.retestRun.status).toBe('cancelled');
    expect(result.assessment).toBeUndefined();
    expect(f.repository.listRetestAssessmentsForRun(retestId)).toHaveLength(0);
    // §22: control requests completed honestly.
    const retestRequest = f.repository.getRetestControlRequest(retestId);
    expect(retestRequest?.requestedAt).toBeDefined();
    expect(retestRequest?.completedAt).toBeDefined();
    const childDone = f.repository.getRunControlRequest(childRunId as never);
    expect(childDone?.requestedAt).toBeDefined();
    expect(childDone?.acknowledgedAt).toBeDefined();
    expect(childDone?.completedAt).toBeDefined();
    // §23: workspaces gone, lock released.
    expect(workspacePaths.length).toBeGreaterThan(0);
    for (const runtimePath of workspacePaths) {
      expect(existsSync(resolve(f.dataRoot, runtimePath))).toBe(false);
    }
    expect(f.repository.getManagedCopy(f.added.project.id)?.state).toBe('ready');
    // §24-25: no merge/verify from the cancelled run; spec + B linkage intact.
    expect(result.targetMerge).toBeUndefined();
    expect(result.targetVerification).toBeUndefined();
    const spec = f.repository.getRetestSpec(retestId);
    expect(spec?.targetSnapshotId).toBe(result.retestRun.targetSnapshotId);
    expect(result.retestRun.targetQaRunId).toBe(childRunId);
    expect(result.retestRun.targetSnapshotId).toBeDefined();
    database2.close();
    f.database.close();
  }, 240_000);
});
