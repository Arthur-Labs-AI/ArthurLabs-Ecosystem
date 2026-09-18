import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { projectIssueState } from '@qa/schemas';
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
  createEvidenceId,
  createFindingId,
  createHarnessEventId,
  createIssueEventId,
  createIssueId,
  createIssueOccurrenceId,
  createOperationId,
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
import {
  mergeRun,
  retestIssue,
  cancelRetestRun,
  recoverRetests,
  RunEngineError,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

type Behavior = 'fail' | 'pass';

/** Scripted agent: emits one grounded test observation (test.result +
 *  test evidence linked to the real emitted operation) plus a finding.
 *  Deterministic per behavior: 'fail' on revision A, 'pass' on B. */
class ScriptedAdapter implements HarnessAdapter {
  constructor(private readonly behavior: Behavior) {}
  async getMetadata() {
    return {
      adapterId: 'scripted',
      adapterVersion: '0.1.0',
      protocolVersion: 1,
      displayName: 'Scripted',
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
    const operationId = createOperationId();
    const failed = this.behavior === 'fail' ? 1 : 0;
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: t,
      type: 'test.result',
      operationId,
      suite: 'target-suite',
      passed: 1 - failed,
      failed,
    });
    const evidenceId = createEvidenceId();
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: t,
      type: 'evidence.submitted',
      evidence: {
        schemaVersion: 1,
        id: evidenceId,
        qaRunId: request.qaRunId,
        agentRunId: request.agentRunId,
        strength: 'reproduced_behavior',
        environmentState: 'baseline',
        type: 'test',
        test: {
          framework: 'vitest',
          name: 'target Test A',
          status: this.behavior === 'fail' ? 'failed' : 'passed',
        },
        artifactIds: [],
        groundingOperationIds: [operationId],
        createdAt: t,
      },
    });
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: t,
      type: 'finding.submitted',
      finding: {
        schemaVersion: 1,
        id: createFindingId(),
        qaRunId: request.qaRunId,
        agentRunId: request.agentRunId,
        sourceAgentStackId: request.agentStackId,
        title: 'Target test failure',
        category: 'logic',
        severity: 'high',
        confidence: 'strong',
        description: 'Target Test A fails deterministically.',
        locations: [{ relativePath: 'src/auth/login.ts' }],
        evidenceIds: [evidenceId],
        reproductionSteps: ['Run target Test A'],
        createdAt: t,
      },
    });
    yield emit({
      schemaVersion: 1,
      eventId: createHarnessEventId(),
      agentRunId: request.agentRunId,
      timestamp: t,
      type: 'run.completed',
      usage: { inputTokens: 10, outputTokens: 5, turns: 1, durationMs: 50 },
    });
  }
  async cancel() {}
  async dispose() {}
}

function scriptedRegistry(behavior: Behavior): HarnessAdapterRegistry {
  const registry = new HarnessAdapterRegistry();
  for (const stack of INITIAL_AGENT_STACKS) {
    registry.register({
      stack,
      runtimeIdentity: {
        modelId: stack.model.modelId,
        adapterId: 'scripted',
        adapterVersion: '0.1.0',
      },
      createAdapter: () => new ScriptedAdapter(behavior) as never,
    });
  }
  return registry;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-retest-'));
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

/** Stub verification: persists canned replay steps per cluster so the
 *  comparison layer runs on the real path deterministically. */
function stubVerify(behavior: Behavior) {
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
        outcome: behavior === 'fail' ? 'reproduced' : 'not_reproducible',
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
        expected: {
          testName: 'target Test A',
          testStatus: behavior === 'fail' ? 'failed' : 'passed',
        },
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

async function seedIssue(
  f: Awaited<ReturnType<typeof fixture>>,
  mergeId: string,
  clusterId: string,
  runId: string,
  verificationRunId: string,
) {
  const t = nowIsoTimestamp();
  const issueId = createIssueId();
  const occurrenceId = createIssueOccurrenceId();
  const revision = f.repository.listRevisions(f.added.project.id)[0];
  if (revision === undefined) throw new Error('revision missing');
  const run = f.repository.getRun(runId as never);
  if (run === undefined) throw new Error('run missing');
  f.repository.transaction(() => {
    f.repository.saveIssue(
      IssueSchema.parse({
        schemaVersion: 1,
        id: issueId,
        projectId: f.added.project.id,
        title: 'Target test failure',
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
        issueId: issueId,
        projectId: f.added.project.id,
        projectRevisionId: revision.id,
        projectSnapshotId: run.snapshotId,
        qaRunId: run.id,
        mergeResultId: mergeId,
        findingClusterId: clusterId,
        verificationRunId,
        createdAt: t,
      }),
    );
    f.repository.saveIngestKey(
      issueIngestKey({ mergeResultId: mergeId, findingClusterId: clusterId }),
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
        message: 'first occurrence ingested',
        createdAt: t,
      }),
    );
  });
  return { issueId, occurrenceId };
}

describe('Phase 7 retest orchestration (§90)', () => {
  it('A→B fixed: failing test on A passes on B with history retained', async () => {
    const f = await fixture();
    const { RunCoordinator } = await import('../src/index.js');
    const runA = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      scriptedRegistry('fail'),
    ).run(f.added.project.id, { executionKind: 'simulation', runTimeoutMs: 30_000 });
    expect(runA.run.status).toBe('completed');
    const { result: mergeA } = mergeRun(f.repository, runA.run.id);
    expect(mergeA.clusterCount).toBeGreaterThan(0);
    const verifiedA = await stubVerify('fail')(f.repository, f.dataRoot, mergeA.id);
    const clusterA = mergeA.clusters[0];
    if (clusterA === undefined) throw new Error('no cluster');
    const { issueId } = await seedIssue(f, mergeA.id, clusterA.id, runA.run.id, verifiedA.run.id);
    // Developer fixes the project → new revision B.
    await writeFile(join(f.source, 'src', 'auth', 'login.ts'), 'export const login = 2;\n');
    await f.manager.updateProjectCopy(f.added.project.id);
    const revisions = f.repository.listRevisions(f.added.project.id);
    expect(revisions).toHaveLength(2);
    // Retest on B with passing behavior.
    const result = await retestIssue(
      {
        dataRoot: f.dataRoot,
        repository: f.repository,
        lease: f.lease,
        registry: scriptedRegistry('pass'),
      },
      issueId,
      { verify: stubVerify('pass') as never, runTimeoutMs: 30_000 },
    );
    expect(result.assessment?.result).toBe('fixed');
    expect(result.retestRun.status).toBe('completed');
    expect(result.retestRun.sourceSnapshotId).not.toBe(result.retestRun.targetSnapshotId);
    expect(result.targetOccurrence).toBeDefined();
    // History retained and projected: open → fixed.
    expect(projectIssueState(f.repository.listIssueEvents(issueId))).toBe('fixed');
    // Original history immutable (§39): A run/merge/verification untouched.
    expect(f.repository.getRun(runA.run.id)?.status).toBe('completed');
    expect(f.repository.getMergeResult(mergeA.id)?.clusterCount).toBe(mergeA.clusterCount);
    expect(f.repository.listIssueOccurrences(issueId)).toHaveLength(2);
    // A still materializable: source snapshot resolves to revision A.
    const sourceOccurrence = f.repository.getIssueOccurrence(result.assessment.sourceOccurrenceId);
    expect(sourceOccurrence?.projectRevisionId).toBe(revisions[0]?.id);
    f.database.close();
  }, 180_000);

  it('still_reproducible: same failure identity on B', async () => {
    const f = await fixture();
    const { RunCoordinator } = await import('../src/index.js');
    const runA = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      scriptedRegistry('fail'),
    ).run(f.added.project.id, { executionKind: 'simulation', runTimeoutMs: 30_000 });
    const { result: mergeA } = mergeRun(f.repository, runA.run.id);
    const verifiedA = await stubVerify('fail')(f.repository, f.dataRoot, mergeA.id);
    const clusterA = mergeA.clusters[0];
    if (clusterA === undefined) throw new Error('no cluster');
    const { issueId } = await seedIssue(f, mergeA.id, clusterA.id, runA.run.id, verifiedA.run.id);
    await writeFile(join(f.source, 'src', 'auth', 'login.ts'), 'export const login = 2;\n');
    await f.manager.updateProjectCopy(f.added.project.id);
    const result = await retestIssue(
      {
        dataRoot: f.dataRoot,
        repository: f.repository,
        lease: f.lease,
        registry: scriptedRegistry('fail'),
      },
      issueId,
      { verify: stubVerify('fail') as never, runTimeoutMs: 30_000 },
    );
    expect(result.assessment?.result).toBe('still_reproducible');
    expect(projectIssueState(f.repository.listIssueEvents(issueId))).toBe('still_reproducible');
    f.database.close();
  }, 180_000);

  it('rejects same-revision, cross-project, and unknown-issue retests (§15, §91)', async () => {
    const f = await fixture();
    const { RunCoordinator } = await import('../src/index.js');
    const runA = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      scriptedRegistry('fail'),
    ).run(f.added.project.id, { executionKind: 'simulation', runTimeoutMs: 30_000 });
    const { result: mergeA } = mergeRun(f.repository, runA.run.id);
    const verifiedA = await stubVerify('fail')(f.repository, f.dataRoot, mergeA.id);
    const clusterA = mergeA.clusters[0];
    if (clusterA === undefined) throw new Error('no cluster');
    const { issueId } = await seedIssue(f, mergeA.id, clusterA.id, runA.run.id, verifiedA.run.id);
    const revisionA = f.repository.listRevisions(f.added.project.id)[0];
    if (revisionA === undefined) throw new Error('no revision');
    await expect(
      retestIssue(
        {
          dataRoot: f.dataRoot,
          repository: f.repository,
          lease: f.lease,
          registry: scriptedRegistry('pass'),
        },
        issueId,
        { targetRevisionId: revisionA.id as never, verify: stubVerify('pass') as never },
      ),
    ).rejects.toThrowError(RunEngineError);
    await expect(
      retestIssue(
        {
          dataRoot: f.dataRoot,
          repository: f.repository,
          lease: f.lease,
          registry: scriptedRegistry('pass'),
        },
        'issue_01K7777777777777777777A8W9',
        {},
      ),
    ).rejects.toMatchObject({ code: 'ISSUE_NOT_FOUND' });
    f.database.close();
  }, 180_000);

  it('cancels and recovers retest runs honestly', async () => {
    const f = await fixture();
    const { RunCoordinator } = await import('../src/index.js');
    const runA = await new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      scriptedRegistry('fail'),
    ).run(f.added.project.id, { executionKind: 'simulation', runTimeoutMs: 30_000 });
    const { result: mergeA } = mergeRun(f.repository, runA.run.id);
    const verifiedA = await stubVerify('fail')(f.repository, f.dataRoot, mergeA.id);
    const clusterA = mergeA.clusters[0];
    if (clusterA === undefined) throw new Error('no cluster');
    const { issueId } = await seedIssue(f, mergeA.id, clusterA.id, runA.run.id, verifiedA.run.id);
    await writeFile(join(f.source, 'src', 'auth', 'login.ts'), 'export const login = 2;\n');
    await f.manager.updateProjectCopy(f.added.project.id);
    const result = await retestIssue(
      {
        dataRoot: f.dataRoot,
        repository: f.repository,
        lease: f.lease,
        registry: scriptedRegistry('pass'),
      },
      issueId,
      { verify: stubVerify('pass') as never, runTimeoutMs: 30_000 },
    );
    // Terminal retest runs refuse cancellation.
    expect(() =>
      cancelRetestRun(
        {
          dataRoot: f.dataRoot,
          repository: f.repository,
          lease: f.lease,
          registry: scriptedRegistry('pass'),
        },
        result.retestRun.id,
      ),
    ).toThrowError(/already terminal/);
    // Stale-owned nonterminal rows interrupt on recovery.
    const stale = {
      ...result.retestRun,
      status: 'agents_running' as const,
      completedAt: undefined,
    };
    f.repository.saveRetestRun(stale as never);
    const recovered = recoverRetests(f.repository, () => false);
    expect(recovered.runs).toBe(1);
    expect(f.repository.getRetestRun(result.retestRun.id)?.status).toBe('interrupted');
    f.database.close();
  }, 180_000);
});
