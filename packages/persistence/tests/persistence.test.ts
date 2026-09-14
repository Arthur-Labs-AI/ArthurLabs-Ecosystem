import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRunSchema,
  HarnessEventSchema,
  ProjectRevisionSchema,
  ProjectSchema,
  ProjectSnapshotSchema,
  QARunSchema,
} from '@qa/schemas';
import {
  FilesystemArtifactStore,
  MIGRATIONS,
  RuntimePersistenceError,
  RuntimeInstanceLease,
  SentryDatabase,
  SentryRepository,
  assertNoPathOverlap,
  resolveSentryDataRoot,
} from '../src/index.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'sentry-persistence-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('Sentry persistence foundation', () => {
  it('resolves injected and OS-specific data roots centrally', () => {
    expect(resolveSentryDataRoot({ env: { SENTRY_DATA_ROOT: './fixture-root' } })).toMatch(
      /fixture-root$/,
    );
    expect(resolveSentryDataRoot({ platform: 'linux', homeDirectory: '/home/test', env: {} })).toBe(
      '/home/test/.local/share/sentry',
    );
    expect(
      resolveSentryDataRoot({ platform: 'darwin', homeDirectory: '/Users/test', env: {} }),
    ).toBe('/Users/test/Library/Application Support/Sentry');
  });

  it('migrates an empty database, enables invariants, and reopens deterministically', async () => {
    const dataRoot = await root();
    const first = new SentryDatabase({ dataRoot });
    expect(first.connection.prepare('PRAGMA foreign_keys').get()).toMatchObject({
      foreign_keys: 1,
    });
    expect(first.connection.prepare('PRAGMA journal_mode').get()).toMatchObject({
      journal_mode: 'wal',
    });
    expect(
      first.connection.prepare('SELECT COUNT(*) count FROM schema_migrations').get(),
    ).toMatchObject({ count: 3 });
    first.close();
    const reopened = new SentryDatabase({ dataRoot });
    expect(
      reopened.connection.prepare('SELECT COUNT(*) count FROM schema_migrations').get(),
    ).toMatchObject({ count: 3 });
    expect(reopened.connection.prepare('PRAGMA busy_timeout').get()).toMatchObject({
      timeout: 5000,
    });
    reopened.close();
  });

  it('upgrades an existing Phase 2 version-1 database without losing data', async () => {
    const dataRoot = await root();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSyncType;
    };
    const legacy = new DatabaseSync(join(dataRoot, 'sentry.db'));
    legacy.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;',
    );
    legacy.exec(MIGRATIONS[0]?.sql ?? '');
    legacy
      .prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (1,?,?)')
      .run('initial', '2026-09-10T00:00:00.000Z');
    const fixture = (name: string) =>
      readFile(join(__dirname, '..', '..', 'domain', 'tests', 'fixtures', name), 'utf8');
    const projectPayload = await fixture('project.json');
    const revisionPayload = await fixture('project-revision.json');
    const managedPayload = await fixture('managed-project-copy.json');
    const contextPayload = await fixture('project-context.json');
    const snapshotPayload = await fixture('snapshot.json');
    const runPayload = await fixture('qa-run.json');
    const agentPayload = await fixture('agent-run-muse.json');
    const project = ProjectSchema.parse(JSON.parse(projectPayload));
    const revision = ProjectRevisionSchema.parse(JSON.parse(revisionPayload));
    const snapshot = ProjectSnapshotSchema.parse(JSON.parse(snapshotPayload));
    const run = QARunSchema.parse(JSON.parse(runPayload));
    const agent = AgentRunSchema.parse(JSON.parse(agentPayload));
    legacy.prepare('INSERT INTO projects(id,payload) VALUES (?,?)').run(project.id, projectPayload);
    legacy
      .prepare('INSERT INTO managed_project_copies(project_id,state,payload) VALUES (?,?,?)')
      .run(project.id, 'ready', managedPayload);
    legacy
      .prepare('INSERT INTO project_revisions(id,project_id,payload) VALUES (?,?,?)')
      .run(revision.id, project.id, revisionPayload);
    legacy.prepare('INSERT INTO artifacts(id,project_id,qa_run_id,payload) VALUES (?,?,?,?)').run(
      snapshot.manifest.artifactId,
      project.id,
      null,
      JSON.stringify({
        schemaVersion: 1,
        id: snapshot.manifest.artifactId,
        projectId: project.id,
        type: 'json',
        relativeStoragePath: 'legacy/manifest.ndjson',
        sizeBytes: 0,
        sha256: snapshot.contentHash,
        createdAt: snapshot.createdAt,
      }),
    );
    legacy
      .prepare(
        'INSERT INTO project_context_snapshots(id,project_id,revision_id,material_index_path,payload) VALUES (?,?,?,?,?)',
      )
      .run(run.projectContextSnapshotId, project.id, revision.id, null, contextPayload);
    legacy
      .prepare(
        'INSERT INTO project_snapshots(id,project_id,revision_id,manifest_artifact_id,payload) VALUES (?,?,?,?,?)',
      )
      .run(snapshot.id, project.id, revision.id, snapshot.manifest.artifactId, snapshotPayload);
    legacy
      .prepare(
        'INSERT INTO qa_runs(id,project_id,snapshot_id,context_id,status,payload) VALUES (?,?,?,?,?,?)',
      )
      .run(run.id, project.id, snapshot.id, run.projectContextSnapshotId, run.status, runPayload);
    legacy
      .prepare('INSERT INTO agent_runs(id,qa_run_id,status,payload) VALUES (?,?,?,?)')
      .run(agent.id, run.id, agent.status, agentPayload);
    const event = HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: 'evt_01K7777777777777777777C010',
      agentRunId: agent.id,
      timestamp: '2026-09-10T00:00:00.000Z',
      type: 'run.started',
    });
    legacy
      .prepare(
        'INSERT INTO harness_events(agent_run_id,sequence,event_id,qa_run_id,payload) VALUES (?,?,?,?,?)',
      )
      .run(agent.id, 1, event.eventId, run.id, JSON.stringify(event));
    legacy.close();

    const upgraded = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(upgraded);
    expect(
      upgraded.connection.prepare('SELECT COUNT(*) count FROM schema_migrations').get(),
    ).toMatchObject({ count: 3 });
    expect(repository.getProject(project.id)).toEqual(project);
    expect(repository.getRun(run.id)).toEqual(run);
    expect(repository.getAgentRun(agent.id)).toEqual(agent);
    expect(repository.listAgentEvents(agent.id)).toEqual([{ sequence: 1, event }]);
    expect(
      upgraded.connection.prepare('SELECT runtime_instance_id FROM qa_runs WHERE id=?').get(run.id),
    ).toMatchObject({ runtime_instance_id: null });
    expect(
      upgraded.connection
        .prepare("SELECT name FROM sqlite_master WHERE name='runtime_instances'")
        .get(),
    ).toBeDefined();
    upgraded.close();
  });

  it('shares fresh and stale runtime lease state across database connections', async () => {
    const dataRoot = await root();
    const databaseA = new SentryDatabase({ dataRoot });
    const databaseB = new SentryDatabase({ dataRoot });
    const repositoryA = new SentryRepository(databaseA);
    const repositoryB = new SentryRepository(databaseB);
    let now = new Date('2026-09-11T00:00:00.000Z');
    const owner = new RuntimeInstanceLease(repositoryA, {
      instanceId: 'runtime_01K7777777777777777777C011',
      now: () => now,
      autoHeartbeat: false,
    });
    owner.start();
    const observer = new RuntimeInstanceLease(repositoryB, {
      instanceId: 'runtime_01K7777777777777777777C012',
      now: () => now,
      autoHeartbeat: false,
    });
    observer.start();
    expect(observer.isFresh(owner.instanceId)).toBe(true);
    now = new Date('2026-09-11T00:00:21.000Z');
    expect(observer.isFresh(owner.instanceId)).toBe(false);
    observer.release();
    owner.release();
    databaseB.close();
    databaseA.close();
  });

  it('classifies a duplicate HarnessEvent identity without exposing raw SQLite errors', async () => {
    const database = new SentryDatabase({ dataRoot: await root() });
    const repository = new SentryRepository(database);
    const runId = 'run_01K7777777777777777777C013';
    const agentRunId = 'arun_01K7777777777777777777C014';
    database.connection.exec('PRAGMA foreign_keys=OFF');
    database.connection
      .prepare(
        'INSERT INTO qa_runs(id,project_id,snapshot_id,context_id,status,payload) VALUES (?,?,?,?,?,?)',
      )
      .run(runId, 'proj_fixture', 'snap_fixture', 'ctx_fixture', 'agents_running', '{}');
    database.connection
      .prepare('INSERT INTO agent_runs(id,qa_run_id,status,payload) VALUES (?,?,?,?)')
      .run(agentRunId, runId, 'running', '{}');
    database.connection.exec('PRAGMA foreign_keys=ON');
    const event = HarnessEventSchema.parse({
      schemaVersion: 1,
      eventId: 'evt_01K7777777777777777777C015',
      agentRunId,
      timestamp: '2026-09-11T00:00:00.000Z',
      type: 'warning',
      message: 'deterministic duplicate fixture',
    });
    repository.appendHarnessEvent(runId, event);
    expect(() => repository.appendHarnessEvent(runId, event)).toThrowError(
      expect.objectContaining({ code: 'EVENT_CONFLICT' }),
    );
    database.close();
  });

  it('fails clearly when persisted JSON violates its entity contract', async () => {
    const database = new SentryDatabase({ dataRoot: await root() });
    database.connection
      .prepare('INSERT INTO projects(id,payload) VALUES (?,?)')
      .run('proj_bad', '{"invalid":true}');
    const repository = new SentryRepository(database);
    expect(() => repository.listProjects()).toThrowError(RuntimePersistenceError);
    expect(() => repository.listProjects()).toThrow(/Persisted Project/);
    database.close();
  });

  it('streams artifacts, hashes bytes, reopens them, and deletes only managed data', async () => {
    const dataRoot = await root();
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const store = new FilesystemArtifactStore(dataRoot, repository);
    const sourcePath = join(dataRoot, 'source.bin');
    await writeFile(sourcePath, Buffer.alloc(128 * 1024, 7));
    const artifact = await store.write({
      relativePath: 'artifacts/stream.bin',
      type: 'other',
      source: createReadStream(sourcePath),
    });
    expect(artifact.sizeBytes).toBe(128 * 1024);
    expect(artifact.sha256).toHaveLength(64);
    const chunks: Buffer[] = [];
    for await (const chunk of store.open(artifact)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).length).toBe(128 * 1024);
    await store.delete(artifact);
    expect(repository.getArtifact(artifact.id)).toBeUndefined();
    expect(await readFile(sourcePath)).toHaveLength(128 * 1024);
    database.close();
  });

  it('does not remove artifact bytes when SQLite rejects deletion of a referenced artifact', async () => {
    const dataRoot = await root();
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const store = new FilesystemArtifactStore(dataRoot, repository);
    const timestamp = '2026-09-11T00:00:00.000Z';
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'proj_01K7777777777777777777B001',
      name: 'Referenced artifact fixture',
      sourcePath: join(dataRoot, 'source'),
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {},
    });
    repository.saveProject(project);
    const revision = ProjectRevisionSchema.parse({
      schemaVersion: 1,
      id: 'rev_01K7777777777777777777B002',
      projectId: project.id,
      sourcePath: project.sourcePath,
      importedAt: timestamp,
      contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    repository.saveRevision(revision);
    const artifact = await store.write({
      relativePath: 'artifacts/referenced.ndjson',
      type: 'json',
      source: (async function* () {
        yield '{}\n';
      })(),
      projectId: project.id,
    });
    repository.saveSnapshot(
      ProjectSnapshotSchema.parse({
        schemaVersion: 1,
        id: 'snap_01K7777777777777777777B003',
        projectId: project.id,
        projectRevisionId: revision.id,
        createdAt: timestamp,
        sourceState: {},
        manifest: {
          entryCount: 0,
          fileCount: 0,
          directoryCount: 0,
          symlinkCount: 0,
          totalBytes: 0,
          artifactId: artifact.id,
        },
        contentHash: revision.contentHash,
      }),
    );

    await expect(store.delete(artifact)).rejects.toThrow();
    expect(repository.getArtifact(artifact.id)).toEqual(artifact);
    expect(await readFile(join(dataRoot, artifact.relativeStoragePath), 'utf8')).toBe('{}\n');
    database.close();
  });

  it('persists merge results atomically and reuses them by input digest', async () => {
    const dataRoot = await root();
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const {
      QARunSchema: Run,
      AgentRunSchema: Agent,
      FindingSchema: Finding,
      EvidenceSchema: Evidence,
      ProjectRevisionSchema: Revision,
      ArtifactSchema: Artifact,
      ProjectSnapshotSchema: Snapshot,
      ProjectContextSnapshotSchema: Context,
    } = await import('@qa/schemas');
    const revision = Revision.parse({
      schemaVersion: 1,
      id: 'rev_01K7777777777777777777A8W1',
      projectId: 'proj_01K7777777777777777777A8W1',
      sourcePath: '/tmp/fixture',
      importedAt: '2026-09-14T00:00:00.000Z',
      contentHash: 'b'.repeat(64),
    });
    const artifact = Artifact.parse({
      schemaVersion: 1,
      id: 'artifact_01K7777777777777777777A8W1' as never,
      projectId: revision.projectId,
      type: 'json',
      relativeStoragePath: 'manifest.ndjson',
      sizeBytes: 0,
      sha256: revision.contentHash,
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    const snapshot = Snapshot.parse({
      schemaVersion: 1,
      id: 'snap_01K7777777777777777777A8W1',
      projectId: revision.projectId,
      projectRevisionId: revision.id,
      createdAt: '2026-09-14T00:00:00.000Z',
      sourceState: {},
      manifest: {
        entryCount: 0,
        fileCount: 0,
        directoryCount: 0,
        symlinkCount: 0,
        totalBytes: 0,
        artifactId: artifact.id,
      },
      contentHash: revision.contentHash,
    });
    const context = Context.parse({
      schemaVersion: 1,
      id: 'ctx_01K7777777777777777777A8W1',
      projectId: revision.projectId,
      projectRevisionId: revision.id,
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    const run = Run.parse({
      schemaVersion: 1,
      id: 'run_01K7777777777777777777A8W1',
      projectId: 'proj_01K7777777777777777777A8W1',
      snapshotId: 'snap_01K7777777777777777777A8W1',
      projectContextSnapshotId: 'ctx_01K7777777777777777777A8W1',
      status: 'completed',
      mode: 'full',
      executionKind: 'production',
      configuration: {
        agentStackIds: ['stack_muse_main'],
        verificationLevel: 'strict',
        policy: { id: 'qa-standard', version: 1 },
      },
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    const agent = Agent.parse({
      schemaVersion: 1,
      id: 'arun_01K7777777777777777777A8W1',
      qaRunId: run.id,
      agentStackId: 'stack_muse_main',
      taskType: 'qa',
      status: 'completed',
      runtimeIdentity: {
        adapterId: 'muse-code',
        adapterVersion: '0.1.0',
        policyId: 'qa-standard',
        policyVersion: 1,
      },
    });
    const finding = Finding.parse({
      schemaVersion: 1,
      id: 'find_01K7777777777777777777A8W1',
      qaRunId: run.id,
      agentRunId: agent.id,
      sourceAgentStackId: 'stack_muse_main',
      title: 'Lonely defect',
      category: 'logic',
      severity: 'medium',
      confidence: 'strong',
      description: 'A single-source defect.',
      locations: [{ relativePath: 'src/a.ts' }],
      evidenceIds: ['ev_01K7777777777777777777A8W1'],
      reproductionSteps: [],
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    const evidence = Evidence.parse({
      schemaVersion: 1,
      id: 'ev_01K7777777777777777777A8W1',
      qaRunId: run.id,
      agentRunId: agent.id,
      type: 'code_reference',
      strength: 'strong_code_evidence',
      environmentState: 'baseline',
      description: 'source',
      codeReference: { relativePath: 'src/a.ts' },
      artifactIds: [],
      groundingOperationIds: [],
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    // FK order: project → revision → artifact → snapshot/context →
    // run → agent → finding/evidence.
    const { ProjectSchema } = await import('@qa/schemas');
    repository.saveProject(
      ProjectSchema.parse({
        schemaVersion: 1,
        id: run.projectId,
        name: 'fixture',
        sourcePath: '/tmp/fixture',
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z',
      }),
    );
    repository.saveRevision(revision);
    repository.saveArtifact(artifact);
    repository.saveSnapshot(snapshot);
    repository.saveContext(context);
    repository.saveRun(run);
    repository.saveAgentRun(agent);
    repository.saveFinding(finding);
    repository.saveEvidence(evidence);
    const { MergeResultSchema } = await import('@qa/schemas');
    const result = MergeResultSchema.parse({
      schemaVersion: 1,
      id: 'merge_01K7777777777777777777A8W1',
      qaRunId: run.id,
      projectSnapshotId: run.snapshotId,
      mergerVersion: 1,
      normalizerVersion: 1,
      inputDigest: 'sha256:' + 'a'.repeat(64),
      expectedAgentStackIds: ['stack_muse_main'],
      usableAgentRunIds: [agent.id],
      unavailableAgentStackIds: [],
      sourceFindingCount: 1,
      clusterCount: 1,
      singleSourceCount: 1,
      multiSourceCount: 0,
      allAvailableCount: 0,
      clusters: [
        {
          schemaVersion: 1,
          id: 'cluster_01K7777777777777777777A8W1',
          qaRunId: run.id,
          projectSnapshotId: run.snapshotId,
          mergerVersion: 1,
          normalizerVersion: 1,
          sourceFindingIds: [finding.id],
          sourceAgentRunIds: [agent.id],
          sourceAgentStackIds: ['stack_muse_main'],
          representativeFindingId: finding.id,
          agreementState: 'single_source',
          expectedAgentCount: 1,
          usableAgentCount: 1,
          supportingAgentCount: 1,
          unavailableAgentStackIds: [],
          severityValues: ['medium'],
          confidenceValues: ['strong'],
          categoryValues: ['logic'],
          evidenceIds: [evidence.id],
          fieldDisagreements: [],
          hasReproducedEvidence: false,
          hasOperationEvidence: false,
          hasSourceEvidence: true,
          hasOnlyModelReasoning: false,
          createdAt: '2026-09-14T00:00:00.000Z',
        },
      ],
      durationMs: 3,
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    repository.saveMergeResult(result, new Map([[result.clusters[0]?.id as string, [finding.id]]]));
    // Round-trip: result, digest lookup, clusters in deterministic order.
    expect(repository.getMergeResult(result.id)).toEqual(result);
    expect(repository.findMergeResultByDigest(run.id, result.inputDigest)?.id).toBe(result.id);
    const clusters = repository.listClusters(result.id);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sourceFindingIds).toEqual([finding.id]);
    // Idempotent re-save: no duplicate rows.
    repository.saveMergeResult(result, new Map([[result.clusters[0]?.id as string, [finding.id]]]));
    expect(repository.listMergeResults(run.id)).toHaveLength(1);
    expect(repository.listClusters(result.id)).toHaveLength(1);
    // Source rows survive merge persistence untouched.
    expect(repository.getRun(run.id)?.status).toBe('completed');
    expect(repository.listFindings(run.id)).toHaveLength(1);
    database.close();
  });

  it('rejects recursive source/data-root overlap', async () => {
    const value = await root();
    const source = join(value, 'source');
    await mkdir(source);
    await expect(assertNoPathOverlap(source, join(source, '.sentry'))).rejects.toThrow(
      /PROJECT_PATH_OVERLAP/,
    );
  });
});
