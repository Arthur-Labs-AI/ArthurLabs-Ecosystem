import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository } from '../src/index.js';
import { MIGRATIONS } from '../src/migrations.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const PROJECT_ID = 'proj_01K7777777777777777777D8W1';
const RUN_ID = 'run_01K7777777777777777777D8W2';
const T = '2026-09-18T00:00:00.000Z';

function seedRun(repository: SentryRepository): void {
  repository.saveProject({
    schemaVersion: 1,
    id: PROJECT_ID,
    name: 'mig6',
    sourcePath: '/tmp/mig6',
    createdAt: T,
    updatedAt: T,
  } as never);
  const revId = 'rev_01K7777777777777777777D8W9';
  const snapId = 'snap_01K7777777777777777777D8W8';
  const ctxId = 'ctx_01K7777777777777777777D8W7';
  const artifactId = 'artifact_01K7777777777777777777D8W6';
  repository.saveRevision({
    schemaVersion: 1,
    id: revId,
    projectId: PROJECT_ID,
    sourcePath: '/tmp/mig6',
    importedAt: T,
    contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
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
    status: 'agents_running',
    configuration: {
      agentStackIds: ['stack_muse_main'],
      verificationLevel: 'strict',
      policy: { id: 'qa-standard', version: 1 },
    },
    createdAt: T,
  } as never);
}

describe('migration v6: cancellation requests + immutable retest specs', () => {
  it('applies v6 tables on a fresh database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-mig6-'));
    roots.push(root);
    const dataRoot = join(root, 'data');
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    expect(MIGRATIONS.map((migration) => migration.version)).toContain(6);
    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    expect(names.has('run_control_requests')).toBe(true);
    expect(names.has('retest_control_requests')).toBe(true);
    expect(names.has('retest_specs')).toBe(true);
    // Control requests round-trip with idempotent upsert against a real run.
    seedRun(repository);
    repository.saveRunControlRequest({
      id: 'cancel_run_probe',
      qaRunId: RUN_ID,
      projectId: PROJECT_ID,
      requestType: 'cancel',
      requestingRuntimeId: 'runtime_01K7777777777777777777A8W9',
      requestedAt: T,
    });
    expect(repository.getRunControlRequest(RUN_ID)?.requestType).toBe('cancel');
    expect(repository.listPendingRunControlRequests()).toHaveLength(1);
    repository.saveRunControlRequest({
      id: 'cancel_run_probe',
      qaRunId: RUN_ID,
      projectId: PROJECT_ID,
      requestType: 'cancel',
      requestingRuntimeId: 'runtime_01K7777777777777777777A8W9',
      requestedAt: T,
      acknowledgedAt: T,
    });
    expect(repository.getRunControlRequest(RUN_ID)?.acknowledgedAt).toBe(T);
    database.close();
  });

  it('migrates a v5 database to v6 with old history readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-mig6-'));
    roots.push(root);
    const dataRoot = join(root, 'data');
    const { mkdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    mkdirSync(dataRoot, { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)(
      'node:sqlite',
    ) as typeof import('node:sqlite');
    const raw = new DatabaseSync(resolve(dataRoot, 'sentry.db'));
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;',
    );
    for (const migration of MIGRATIONS.filter((m) => m.version <= 5)) {
      raw.exec('BEGIN IMMEDIATE');
      raw.exec(migration.sql);
      raw
        .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      raw.exec('COMMIT');
    }
    raw.close();
    const database = new SentryDatabase({ dataRoot });
    const applied = database.connection
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    expect(applied.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6]);
    const tables = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((table) => table.name));
    expect(names.has('run_control_requests')).toBe(true);
    expect(names.has('retest_specs')).toBe(true);
    const repository = new SentryRepository(database);
    seedRun(repository);
    expect(repository.getRun(RUN_ID as never)?.id).toBe(RUN_ID);
    database.close();
  });

  it('retest_specs rejects mutation (immutability trigger)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-mig6-'));
    roots.push(root);
    const dataRoot = join(root, 'data');
    const database = new SentryDatabase({ dataRoot });
    const triggers = database.connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='retest_specs_immutable'",
      )
      .all() as Array<{ name: string }>;
    expect(triggers).toHaveLength(1);
    database.close();
  });
});
