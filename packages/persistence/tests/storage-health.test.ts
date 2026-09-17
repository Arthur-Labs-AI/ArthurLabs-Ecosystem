import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperationId } from '@qa/shared';
import {
  SentryDatabase,
  SentryRepository,
  cleanupOrphans,
  inspectStorageHealth,
  ORPHAN_MIN_AGE_MS,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const OLD = Date.now() - ORPHAN_MIN_AGE_MS - 60_000;

async function oldDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'litter.bin'), 'x'.repeat(64));
  const stamp = new Date(OLD);
  await utimes(path, stamp, stamp);
  await utimes(join(path, 'litter.bin'), stamp, stamp);
}

describe('Phase 7 storage hygiene (§51–§54)', () => {
  it('reports sizes and finds orphans without deleting (dry-run)', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-storage-'));
    roots.push(dataRoot);
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const staging = await mkdtemp(join(tmpdir(), 'sentry-staging-'));
    roots.push(staging);
    await oldDir(
      join(
        dataRoot,
        'projects',
        'proj_x',
        'runs',
        'run_x',
        'agents',
        'arun_01K7777777777777777777A8W4',
        'workspace',
      ),
    );
    await oldDir(
      join(
        dataRoot,
        'projects',
        'proj_x',
        'verifier-workspaces',
        'vattempt_01K7777777777777777777A8W5',
      ),
    );
    await oldDir(join(staging, 'sentry-verify-vattempt_01K7777777777777777777A8W6'));
    // Non-orphan names are never classified: generic temp and bad prefixes ignored.
    await oldDir(join(staging, 'random-tmp-dir'));
    await oldDir(
      join(dataRoot, 'projects', 'proj_x', 'runs', 'run_x', 'agents', 'not-an-agent', 'workspace'),
    );
    const health = await inspectStorageHealth(dataRoot, repository, staging, {
      nowMs: Date.now(),
      minAgeMs: 1000,
    });
    expect(health.databaseBytes).toBeGreaterThan(0);
    expect(health.projects).toBe(0);
    const classes = health.orphans.map((orphan) => orphan.pathClass).sort();
    expect(classes).toEqual(['agent_workspace', 'verifier_staging', 'verifier_workspace']);
    for (const orphan of health.orphans) {
      expect(orphan.ageMs).toBeGreaterThan(0);
      expect(orphan.reason.length).toBeGreaterThan(0);
    }
    // Dry-run deleted nothing.
    await expect(
      stat(join(staging, 'sentry-verify-vattempt_01K7777777777777777777A8W6')),
    ).resolves.toBeDefined();
    database.close();
  });

  it('removes only contract-matching paths with audit records', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-cleanup-'));
    roots.push(dataRoot);
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const staging = await mkdtemp(join(tmpdir(), 'sentry-staging2-'));
    roots.push(staging);
    await oldDir(join(staging, 'sentry-verify-vattempt_01K7777777777777777777A8W6'));
    const health = await inspectStorageHealth(dataRoot, repository, staging, {
      nowMs: Date.now(),
      minAgeMs: 1000,
    });
    expect(health.orphans).toHaveLength(1);
    const operationId = createOperationId();
    const audits = await cleanupOrphans(dataRoot, staging, health.orphans, { operationId });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ operationId, removed: true, pathClass: 'verifier_staging' });
    await expect(
      stat(join(staging, 'sentry-verify-vattempt_01K7777777777777777777A8W6')),
    ).rejects.toThrow();
    // Refuses non-contract paths instead of widening.
    const refused = await cleanupOrphans(
      dataRoot,
      staging,
      [
        {
          pathClass: 'verifier_staging',
          path: join(staging, 'random-tmp-dir'),
          ageMs: 99999,
          reason: 'test',
        },
      ],
      { operationId },
    );
    expect(refused[0]).toMatchObject({ removed: false });
    database.close();
  });

  it('keeps fresh workspaces and actively owned rows', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-fresh-'));
    roots.push(dataRoot);
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const staging = await mkdtemp(join(tmpdir(), 'sentry-staging3-'));
    roots.push(staging);
    const fresh = join(
      dataRoot,
      'projects',
      'proj_x',
      'runs',
      'run_x',
      'agents',
      'arun_01K7777777777777777777A8W4',
      'workspace',
    );
    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, 'new.bin'), 'fresh');
    const health = await inspectStorageHealth(dataRoot, repository, staging, {
      nowMs: Date.now(),
      minAgeMs: ORPHAN_MIN_AGE_MS,
    });
    expect(health.orphans).toEqual([]);
    database.close();
  });
});
