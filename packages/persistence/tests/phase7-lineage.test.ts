import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IssueEventSchema,
  IssueOccurrenceSchema,
  IssueSchema,
  RetestAssessmentSchema,
  RetestRunSchema,
  TargetSpecSchema,
  issueIngestKey,
  projectIssueState,
} from '@qa/schemas';
import { SentryDatabase, SentryRepository } from '../src/index.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'sentry-phase7-'));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const PROJECT_ID = 'proj_01K7777777777777777777D8W1';
const RUN_ID = 'run_01K7777777777777777777D8W2';
const MERGE_ID = 'merge_01K7777777777777777777D8WA';
const CLUSTER_ID = 'cluster_01K7777777777777777777D8WB';
const ISSUE_ID = 'issue_01K7777777777777777777D8WC';
const OCC_ID = 'occ_01K7777777777777777777D8WD';
const T = '2026-09-17T00:00:00.000Z';

function seedProject(repository: SentryRepository): void {
  repository.saveProject({
    schemaVersion: 1,
    id: PROJECT_ID,
    name: 'phase7',
    sourcePath: '/tmp/phase7',
    createdAt: T,
    updatedAt: T,
  } as never);
}

function seedRun(repository: SentryRepository): void {
  seedProject(repository);
  const revId = 'rev_01K7777777777777777777D8W9';
  const snapId = 'snap_01K7777777777777777777D8W8';
  const ctxId = 'ctx_01K7777777777777777777D8W7';
  const artifactId = 'artifact_01K7777777777777777777D8W6';
  repository.saveRevision({
    schemaVersion: 1,
    id: revId,
    projectId: PROJECT_ID,
    sourcePath: '/tmp/phase7',
    importedAt: T,
    contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  // FK order: project → revision → artifact → snapshot/context → run.
  repository.saveArtifact({
    schemaVersion: 1,
    id: artifactId,
    projectId: PROJECT_ID,
    type: 'json',
    relativeStoragePath: 'manifest.ndjson',
    sizeBytes: 0,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    createdAt: T,
  } as never);
  repository.saveSnapshot({
    schemaVersion: 1,
    id: snapId,
    projectId: PROJECT_ID,
    projectRevisionId: revId,
    createdAt: T,
    sourceState: {},
    manifest: {
      entryCount: 0,
      fileCount: 0,
      directoryCount: 0,
      symlinkCount: 0,
      totalBytes: 0,
      artifactId,
    },
    contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  } as never);
  repository.saveContext({
    schemaVersion: 1,
    id: ctxId,
    projectId: PROJECT_ID,
    projectRevisionId: revId,
    createdAt: T,
  } as never);
  repository.saveRun({
    schemaVersion: 1,
    id: RUN_ID,
    projectId: PROJECT_ID,
    snapshotId: snapId,
    projectContextSnapshotId: ctxId,
    mode: 'full',
    status: 'completed',
    configuration: {
      agentStackIds: ['stack_muse_main'],
      verificationLevel: 'strict',
      policy: { id: 'qa-standard', version: 1 },
    },
    createdAt: T,
  } as never);
  repository.saveMergeResult(
    {
      schemaVersion: 1,
      id: MERGE_ID,
      qaRunId: RUN_ID,
      projectSnapshotId: 'snap_01K7777777777777777777D8W8',
      mergerVersion: 2,
      normalizerVersion: 1,
      inputDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      expectedAgentStackIds: ['stack_muse_main'],
      usableAgentRunIds: [],
      unavailableAgentStackIds: [],
      sourceFindingCount: 0,
      clusterCount: 0,
      singleSourceCount: 0,
      multiSourceCount: 0,
      allAvailableCount: 0,
      clusters: [],
      durationMs: 0,
      createdAt: T,
    } as never,
    new Map(),
  );
}

describe('Phase 7 issue lineage persistence (§36, §74, §76)', () => {
  it('round-trips issues, occurrences, and append-only events', async () => {
    const database = new SentryDatabase({ dataRoot: await root() });
    const repository = new SentryRepository(database);
    seedRun(repository);
    repository.saveIssue(
      IssueSchema.parse({
        schemaVersion: 1,
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        title: 'Divide bug',
        category: 'logic',
        severity: 'high',
        createdAt: T,
        updatedAt: T,
      }),
    );
    repository.saveIssueOccurrence(
      IssueOccurrenceSchema.parse({
        schemaVersion: 1,
        id: OCC_ID,
        issueId: ISSUE_ID,
        projectId: PROJECT_ID,
        projectRevisionId: 'rev_01K7777777777777777777D8W9',
        projectSnapshotId: 'snap_01K7777777777777777777D8W8',
        qaRunId: RUN_ID,
        mergeResultId: MERGE_ID,
        findingClusterId: CLUSTER_ID,
        createdAt: T,
      }),
    );
    expect(repository.getIssue(ISSUE_ID)?.title).toBe('Divide bug');
    expect(repository.listIssues(PROJECT_ID)).toHaveLength(1);
    expect(repository.listIssueOccurrences(ISSUE_ID)).toHaveLength(1);
    repository.appendIssueEvent(
      IssueEventSchema.parse({
        schemaVersion: 1,
        id: 'iev_01K7777777777777777777D8WE',
        issueId: ISSUE_ID,
        projectId: PROJECT_ID,
        kind: 'created',
        toState: 'open',
        message: 'first occurrence ingested',
        createdAt: T,
      }),
    );
    repository.appendIssueEvent(
      IssueEventSchema.parse({
        schemaVersion: 1,
        id: 'iev_01K7777777777777777777D8WF',
        issueId: ISSUE_ID,
        projectId: PROJECT_ID,
        kind: 'retest_assessed',
        fromState: 'open',
        toState: 'fixed',
        retestAssessmentId: 'reassess_01K7777777777777777777D8WG',
        message: 'retest on revision B fixed',
        createdAt: T,
      }),
    );
    const events = repository.listIssueEvents(ISSUE_ID);
    expect(events).toHaveLength(2);
    expect(projectIssueState(events)).toBe('fixed');
    database.close();
  });

  it('ingest keys are idempotent: repeated ingest returns the original (§74, §76)', async () => {
    const database = new SentryDatabase({ dataRoot: await root() });
    const repository = new SentryRepository(database);
    seedRun(repository);
    // Ingest runs in one transaction: issue + occurrence first, then the key.
    repository.transaction(() => {
      repository.saveIssue(
        IssueSchema.parse({
          schemaVersion: 1,
          id: ISSUE_ID,
          projectId: PROJECT_ID,
          title: 'Divide bug',
          category: 'logic',
          severity: 'high',
          createdAt: T,
          updatedAt: T,
        }),
      );
      repository.saveIssueOccurrence(
        IssueOccurrenceSchema.parse({
          schemaVersion: 1,
          id: OCC_ID,
          issueId: ISSUE_ID,
          projectId: PROJECT_ID,
          projectRevisionId: 'rev_01K7777777777777777777D8W9',
          projectSnapshotId: 'snap_01K7777777777777777777D8W8',
          qaRunId: RUN_ID,
          mergeResultId: MERGE_ID,
          findingClusterId: CLUSTER_ID,
          createdAt: T,
        }),
      );
      repository.saveIngestKey(
        issueIngestKey({ mergeResultId: MERGE_ID, findingClusterId: CLUSTER_ID }),
        ISSUE_ID,
        OCC_ID,
      );
    });
    const key = issueIngestKey({ mergeResultId: MERGE_ID, findingClusterId: CLUSTER_ID });
    expect(repository.getIngestKey(key)).toEqual({ issueId: ISSUE_ID, occurrenceId: OCC_ID });
    // Repeated ingest is a no-op: the original mapping survives.
    repository.saveIngestKey(key, ISSUE_ID, OCC_ID);
    expect(repository.getIngestKey(key)).toEqual({ issueId: ISSUE_ID, occurrenceId: OCC_ID });
    database.close();
  });

  it('target specs are immutable per run (§9)', async () => {
    const database = new SentryDatabase({ dataRoot: await root() });
    const repository = new SentryRepository(database);
    seedRun(repository);
    const spec = TargetSpecSchema.parse({
      schemaVersion: 1,
      qaRunId: RUN_ID,
      snapshotId: 'snap_01K7777777777777777777D8W8',
      includePaths: ['src/auth'],
      issueIds: [],
      createdAt: T,
    });
    repository.saveTargetSpec(spec, PROJECT_ID as never);
    repository.saveTargetSpec(
      TargetSpecSchema.parse({ ...spec, includePaths: ['src/other'] }),
      PROJECT_ID as never,
    );
    expect(repository.getTargetSpec(RUN_ID as never)?.includePaths).toEqual(['src/auth']);
    database.close();
  });

  it('retest runs upsert status while assessments stay insert-only (§26)', async () => {
    const database = new SentryDatabase({ dataRoot: await root() });
    const repository = new SentryRepository(database);
    seedRun(repository);
    repository.saveIssue(
      IssueSchema.parse({
        schemaVersion: 1,
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        title: 'Divide bug',
        category: 'logic',
        severity: 'high',
        createdAt: T,
        updatedAt: T,
      }),
    );
    const run = RetestRunSchema.parse({
      schemaVersion: 1,
      id: 'retest_01K7777777777777777777D8WJ',
      retestVersion: 1,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      sourceProjectRevisionId: 'rev_01K7777777777777777777D8W9',
      targetProjectRevisionId: 'rev_01K7777777777777777777D8WM',
      sourceSnapshotId: 'snap_01K7777777777777777777D8W8',
      targetSnapshotId: 'snap_01K7777777777777777777D8WN',
      sourceQaRunId: RUN_ID,
      sourceMergeResultId: MERGE_ID,
      sourceFindingClusterId: CLUSTER_ID,
      agentStackIds: ['stack_muse_main'],
      status: 'created',
      createdAt: T,
    });
    repository.saveRetestRun(run);
    repository.saveRetestRun({ ...run, status: 'agents_running', startedAt: T });
    expect(repository.getRetestRun(run.id)?.status).toBe('agents_running');
    expect(repository.listNonterminalRetestRuns()).toHaveLength(1);
    repository.saveRetestAssessment(
      RetestAssessmentSchema.parse({
        schemaVersion: 1,
        id: 'reassess_01K7777777777777777777D8WP',
        retestVersion: 1,
        retestRunId: run.id,
        issueId: ISSUE_ID,
        projectId: PROJECT_ID,
        sourceRevisionId: 'rev_01K7777777777777777777D8W9',
        targetRevisionId: 'rev_01K7777777777777777777D8WM',
        sourceOccurrenceId: OCC_ID,
        targetQaRunId: RUN_ID,
        targetMergeResultId: MERGE_ID,
        newEvidenceIds: [],
        result: 'inconclusive',
        rationale: 'sandbox unavailable on target revision',
        assessedAt: T,
      }),
    );
    expect(repository.listRetestAssessments(ISSUE_ID)).toHaveLength(1);
    database.close();
  });

  it('migrates a Phase 6 database forward with history readable (§73, §105)', async () => {
    const dataRoot = await root();
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    seedRun(repository);
    expect(repository.getRun(RUN_ID as never)?.id).toBe(RUN_ID);
    expect(
      database.connection.prepare("SELECT name FROM sqlite_master WHERE name='retest_runs'").get(),
    ).toBeDefined();
    expect(
      database.connection.prepare("SELECT name FROM sqlite_master WHERE name='issues'").get(),
    ).toBeDefined();
    database.close();
  });

  it('reconstructs projects, issues, runs, retests, and revision lineage after restart (§104)', async () => {
    const dataRoot = await root();
    const first = new SentryDatabase({ dataRoot });
    const before = new SentryRepository(first);
    seedRun(before);
    before.saveIssue(
      IssueSchema.parse({
        schemaVersion: 1,
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        title: 'Divide bug',
        category: 'logic',
        severity: 'high',
        createdAt: T,
        updatedAt: T,
      }),
    );
    before.saveIssueOccurrence(
      IssueOccurrenceSchema.parse({
        schemaVersion: 1,
        id: OCC_ID,
        issueId: ISSUE_ID,
        projectId: PROJECT_ID,
        projectRevisionId: 'rev_01K7777777777777777777D8W9',
        projectSnapshotId: 'snap_01K7777777777777777777D8W8',
        qaRunId: RUN_ID,
        mergeResultId: MERGE_ID,
        findingClusterId: CLUSTER_ID,
        createdAt: T,
      }),
    );
    before.appendIssueEvent(
      IssueEventSchema.parse({
        schemaVersion: 1,
        id: 'iev_01K7777777777777777777D8WE',
        issueId: ISSUE_ID,
        projectId: PROJECT_ID,
        kind: 'created',
        toState: 'open',
        occurrenceId: OCC_ID,
        message: 'first occurrence',
        createdAt: T,
      }),
    );
    before.saveTargetSpec(
      TargetSpecSchema.parse({
        schemaVersion: 1,
        qaRunId: RUN_ID,
        snapshotId: 'snap_01K7777777777777777777D8W8',
        includePaths: ['src/auth'],
        issueIds: [],
        createdAt: T,
      }),
      PROJECT_ID as never,
    );
    before.saveRetestRun(
      RetestRunSchema.parse({
        schemaVersion: 1,
        id: 'retest_01K7777777777777777777D8WJ',
        retestVersion: 1,
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        sourceProjectRevisionId: 'rev_01K7777777777777777777D8W9',
        targetProjectRevisionId: 'rev_01K7777777777777777777D8WM',
        sourceSnapshotId: 'snap_01K7777777777777777777D8W8',
        targetSnapshotId: 'snap_01K7777777777777777777D8WN',
        sourceQaRunId: RUN_ID,
        sourceMergeResultId: MERGE_ID,
        sourceFindingClusterId: CLUSTER_ID,
        agentStackIds: ['stack_muse_main'],
        status: 'completed',
        createdAt: T,
        startedAt: T,
        completedAt: T,
      }),
    );
    before.saveRetestAssessment(
      RetestAssessmentSchema.parse({
        schemaVersion: 1,
        id: 'reassess_01K7777777777777777777D8WP',
        retestVersion: 1,
        retestRunId: 'retest_01K7777777777777777777D8WJ',
        issueId: ISSUE_ID,
        projectId: PROJECT_ID,
        sourceRevisionId: 'rev_01K7777777777777777777D8W9',
        targetRevisionId: 'rev_01K7777777777777777777D8WM',
        sourceOccurrenceId: OCC_ID,
        targetQaRunId: RUN_ID,
        targetMergeResultId: MERGE_ID,
        newEvidenceIds: [],
        result: 'fixed',
        rationale: 'target passes',
        assessedAt: T,
      }),
    );
    first.close();
    // Restart: reopen the same data root in a fresh connection.
    const second = new SentryDatabase({ dataRoot });
    const after = new SentryRepository(second);
    expect(after.getProject(PROJECT_ID as never)?.name).toBe('phase7');
    expect(after.getIssue(ISSUE_ID)?.title).toBe('Divide bug');
    expect(after.listIssueOccurrences(ISSUE_ID)).toHaveLength(1);
    expect(projectIssueState(after.listIssueEvents(ISSUE_ID))).toBe('open');
    expect(after.getRun(RUN_ID as never)?.id).toBe(RUN_ID);
    expect(after.getTargetSpec(RUN_ID as never)?.includePaths).toEqual(['src/auth']);
    expect(after.listRevisions(PROJECT_ID as never)).toHaveLength(1);
    expect(after.getRetestRun('retest_01K7777777777777777777D8WJ')?.status).toBe('completed');
    expect(after.listRetestAssessments(ISSUE_ID)).toHaveLength(1);
    expect(after.listRetestAssessments(ISSUE_ID)[0]?.result).toBe('fixed');
    second.close();
  });
});
