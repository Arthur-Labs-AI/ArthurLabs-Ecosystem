import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRevisionSchema, ProjectSchema, ProjectSnapshotSchema } from '@qa/schemas';
import {
  FilesystemArtifactStore,
  RuntimePersistenceError,
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
    ).toMatchObject({ count: 1 });
    first.close();
    const reopened = new SentryDatabase({ dataRoot });
    expect(
      reopened.connection.prepare('SELECT COUNT(*) count FROM schema_migrations').get(),
    ).toMatchObject({ count: 1 });
    reopened.close();
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

  it('rejects recursive source/data-root overlap', async () => {
    const value = await root();
    const source = join(value, 'source');
    await mkdir(source);
    await expect(assertNoPathOverlap(source, join(source, '.sentry'))).rejects.toThrow(
      /PROJECT_PATH_OVERLAP/,
    );
  });
});
