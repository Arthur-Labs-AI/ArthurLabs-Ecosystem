import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SentryDatabase } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const PROJECT = 'proj_01K7777777777777777777A8W1';
const SNAPSHOT = 'snap_01K7777777777777777777A8W2';
const CONTEXT = 'ctx_01K7777777777777777777A8WA';
const RUN_FULL = 'run_01K7777777777777777777A8W3';
const RUN_RETEST = 'run_01K7777777777777777777A8W4';
const RUN_STUCK = 'run_01K7777777777777777777A8W5';

function runPayload(id: string, mode: string, status: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    projectId: PROJECT,
    snapshotId: SNAPSHOT,
    projectContextSnapshotId: CONTEXT,
    mode,
    status,
    configuration: {
      agentStackIds: ['stack_muse_main'],
      verificationLevel: 'strict',
      policy: { id: 'qa-standard', version: 1 },
    },
    lineage: { parentRunId: RUN_FULL },
    createdAt: '2026-09-09T19:00:00.000Z',
  });
}

describe('migration v7: remove merge, verification, issue and retest', () => {
  it('drops the removed tables and rewrites run, target-spec and activity rows', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-migration-v7-'));
    roots.push(dataRoot);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSyncType;
    };
    const legacy = new DatabaseSync(join(dataRoot, 'sentry.db'));
    // Parent rows are irrelevant to what is being migrated; the migration
    // itself runs with foreign keys enforced when the database is reopened.
    legacy.exec(
      'PRAGMA foreign_keys=OFF; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;',
    );
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
      legacy.exec(migration.sql);
      legacy
        .prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
        .run(migration.version, migration.name, '2026-09-10T00:00:00.000Z');
    }
    const insertRun = legacy.prepare(
      'INSERT INTO qa_runs(id,project_id,snapshot_id,context_id,status,payload) VALUES (?,?,?,?,?,?)',
    );
    for (const [id, mode, status] of [
      [RUN_FULL, 'full', 'completed'],
      [RUN_RETEST, 'retest', 'completed'],
      [RUN_STUCK, 'targeted', 'verifying'],
    ] as const) {
      insertRun.run(id, PROJECT, SNAPSHOT, CONTEXT, status, runPayload(id, mode, status));
    }
    legacy
      .prepare('INSERT INTO target_specs(qa_run_id,project_id,payload) VALUES (?,?,?)')
      .run(
        RUN_STUCK,
        PROJECT,
        JSON.stringify({ qaRunId: RUN_STUCK, includePaths: ['src'], issueIds: [] }),
      );
    const insertActivity = legacy.prepare(
      'INSERT INTO run_activities(id,qa_run_id,agent_run_id,payload) VALUES (?,?,?,?)',
    );
    insertActivity.run(
      'activity_01K7777777777777777777A8W6',
      RUN_FULL,
      null,
      JSON.stringify({ kind: 'merger', source: 'merger' }),
    );
    insertActivity.run(
      'activity_01K7777777777777777777A8W7',
      RUN_FULL,
      null,
      JSON.stringify({ kind: 'report', source: 'report' }),
    );
    legacy.close();

    const upgraded = new SentryDatabase({ dataRoot });
    try {
      const tables = (
        upgraded.connection
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const removed of [
        'merge_results',
        'finding_clusters',
        'finding_cluster_members',
        'cluster_evidence',
        'cluster_disagreements',
        'verification_runs',
        'verification_attempts',
        'verification_steps',
        'verification_observations',
        'verification_assertions',
        'issues',
        'issue_occurrences',
        'issue_events',
        'issue_ingest_keys',
        'retest_runs',
        'retest_assessments',
        'retest_control_requests',
        'retest_specs',
      ]) {
        expect(tables).not.toContain(removed);
      }
      expect(tables).toContain('target_specs');
      expect(tables).toContain('run_control_requests');

      const runs = upgraded.connection
        .prepare('SELECT id,status,payload FROM qa_runs ORDER BY id')
        .all() as Array<{ id: string; status: string; payload: string }>;
      expect(runs.map((row) => row.id)).toEqual([RUN_FULL, RUN_STUCK]);
      const stuck = runs.find((row) => row.id === RUN_STUCK)!;
      expect(stuck.status).toBe('partial');
      for (const row of runs) {
        const payload = JSON.parse(row.payload) as Record<string, unknown> & {
          configuration: Record<string, unknown>;
        };
        expect(payload['lineage']).toBeUndefined();
        expect(payload.configuration['verificationLevel']).toBeUndefined();
        expect(payload.configuration['agentStackIds']).toEqual(['stack_muse_main']);
      }
      expect(JSON.parse(stuck.payload)).toMatchObject({ status: 'partial' });

      const target = upgraded.connection
        .prepare('SELECT payload FROM target_specs WHERE qa_run_id=?')
        .get(RUN_STUCK) as { payload: string };
      expect(JSON.parse(target.payload)).toEqual({ qaRunId: RUN_STUCK, includePaths: ['src'] });

      const activities = upgraded.connection
        .prepare('SELECT id FROM run_activities')
        .all() as Array<{ id: string }>;
      expect(activities.map((row) => row.id)).toEqual(['activity_01K7777777777777777777A8W7']);

      expect(
        upgraded.connection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get(),
      ).toMatchObject({ version: 7 });
    } finally {
      upgraded.close();
    }
  });
});
