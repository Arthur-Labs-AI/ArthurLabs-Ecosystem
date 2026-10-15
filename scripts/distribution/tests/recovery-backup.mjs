// Acceptance-only, read-only verification of an explicitly marked synthetic
// stopped data/profile bundle. Never restores files, decrypts keys or activates.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile, readdir, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MIGRATIONS } from '../../../packages/persistence/dist/migrations.js';
import { parseIdentity } from '../contract.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = () => {
  throw new Error('Recovery backup verification refused; preserve the original bundle.');
};
const migrationTable =
  'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;';
function schema(db) {
  return digest(
    JSON.stringify(
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all(),
    ),
  );
}
function supportedSchema() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migrationTable);
    for (const migration of MIGRATIONS) db.exec(migration.sql);
    return schema(db);
  } finally {
    db.close();
  }
}
async function files(root, prefix = '') {
  const out = Object.create(null);
  for (const item of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix + item,
      path = join(root, relative),
      stat = await lstat(path);
    if (stat.isSymbolicLink()) fail();
    if (stat.isDirectory()) Object.assign(out, await files(root, relative + '/'));
    else if (stat.isFile()) out[relative] = digest(await readFile(path));
    else fail();
  }
  return Object.fromEntries(Object.entries(out));
}
async function readRegularJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail();
  return JSON.parse(await readFile(path, 'utf8'));
}
function identityOf(value) {
  if (
    !value ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    value.version !== '0.1.0-beta.1' ||
    value.runtimeProtocol !== 1
  )
    fail();
  return {
    sourceCommit: value.sourceCommit,
    version: value.version,
    runtimeProtocol: value.runtimeProtocol,
  };
}
export async function inspectBundle(input) {
  const root = resolve(input);
  const comparison = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const allowedBases = [resolve(tmpdir())];
  if (process.platform === 'linux') allowedBases.push('/var/tmp');
  const base = allowedBases.find((value) =>
    comparison(root).startsWith(comparison(value + sep + 'sentry-recovery-')),
  );
  if (base === undefined) fail();
  const canonicalRoot = await realpath(root);
  // Hosted Windows temp bases can be junctions/drive aliases. Normalize only
  // that trusted base; redirects anywhere inside the fixture still refuse.
  const expectedRoot = resolve(await realpath(base), relative(base, root));
  if (comparison(canonicalRoot) !== comparison(expectedRoot)) fail();
  for (const component of ['', 'data', 'profile'])
    if (
      !(await lstat(join(root, component))).isDirectory() ||
      (await lstat(join(root, component))).isSymbolicLink()
    )
      fail();
  const marker = await readRegularJson(join(root, 'fixture.json'));
  if (
    marker.fixtureOnly !== true ||
    typeof marker.generation !== 'string' ||
    marker.generation.length === 0
  )
    fail();
  for (const component of ['data', 'profile']) {
    const generation = await readRegularJson(join(root, component, 'recovery-generation.json'));
    if (generation.fixtureOnly !== true || generation.generation !== marker.generation) fail();
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await lstat(join(root, 'profile', name));
      fail();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const name of ['sentry.db-wal', 'sentry.db-journal']) {
    try {
      if ((await lstat(join(root, 'data', name))).size !== 0) fail();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const material = {
    data: await files(join(root, 'data')),
    profile: await files(join(root, 'profile')),
  };
  // SQLite can create WAL coordination files even for a read-only WAL handle.
  // Inspect a private checkpointed copy so verification never changes the bundle.
  const scratch = await mkdtemp(join(tmpdir(), 'sentry-recovery-inspect-'));
  if (!resolve(scratch).startsWith(resolve(tmpdir()) + sep)) fail();
  await writeFile(join(scratch, 'sentry.db'), await readFile(join(root, 'data/sentry.db')), {
    mode: 0o600,
  });
  let db;
  try {
    db = new DatabaseSync(join(scratch, 'sentry.db'), { readOnly: true });
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length !== 0 ||
      schema(db) !== supportedSchema()
    )
      fail();
    const migrations = db
      .prepare('SELECT version,name FROM schema_migrations ORDER BY version')
      .all();
    if (
      JSON.stringify(migrations) !==
      JSON.stringify(MIGRATIONS.map(({ version, name }) => ({ version, name })))
    )
      fail();
    for (const row of db.prepare('SELECT payload FROM runtime_instances').all())
      if (JSON.parse(row.payload).releasedAt === undefined) fail();
    for (const table of ['qa_runs', 'retest_runs'])
      for (const row of db.prepare('SELECT status FROM ' + table).all())
        if (!['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(row.status))
          fail();
    const counts = {},
      canonical = {};
    const entity = (table, id) => {
      const row = db.prepare('SELECT payload FROM ' + table + ' WHERE id=?').get(id);
      if (!row) fail();
      return JSON.parse(row.payload);
    };
    for (const { payload } of db.prepare('SELECT payload FROM project_snapshots').all()) {
      const snapshot = JSON.parse(payload);
      if (entity('project_revisions', snapshot.projectRevisionId).projectId !== snapshot.projectId)
        fail();
      const artifact = entity('artifacts', snapshot.manifest.artifactId);
      if (material.data[artifact.relativeStoragePath] !== artifact.sha256) fail();
    }
    for (const { payload } of db.prepare('SELECT payload FROM issue_occurrences').all()) {
      const occurrence = JSON.parse(payload);
      if (
        entity('issues', occurrence.issueId).projectId !== occurrence.projectId ||
        entity('merge_results', occurrence.mergeResultId).qaRunId !== occurrence.qaRunId
      )
        fail();
      entity('finding_clusters', occurrence.findingClusterId);
    }
    for (const { payload } of db.prepare('SELECT payload FROM retest_runs').all()) {
      const retest = JSON.parse(payload),
        source = entity('qa_runs', retest.sourceQaRunId);
      if (
        entity('issues', retest.issueId).projectId !== retest.projectId ||
        source.projectId !== retest.projectId ||
        source.snapshotId !== retest.sourceSnapshotId ||
        entity('merge_results', retest.sourceMergeResultId).qaRunId !== source.id
      )
        fail();
      entity('finding_clusters', retest.sourceFindingClusterId);
      if (
        entity('project_snapshots', retest.sourceSnapshotId).projectRevisionId !==
        retest.sourceProjectRevisionId
      )
        fail();
      if (
        retest.targetQaRunId !== undefined &&
        (entity('qa_runs', retest.targetQaRunId).snapshotId !== retest.targetSnapshotId ||
          entity('project_snapshots', retest.targetSnapshotId).projectRevisionId !==
            retest.targetProjectRevisionId)
      )
        fail();
    }
    for (const { name } of db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()) {
      if (!/^[a-z_]+$/.test(name)) fail();
      const rows = db.prepare('SELECT * FROM ' + name).all();
      counts[name] = rows.length;
      if (!['runtime_instances', 'schema_migrations'].includes(name))
        canonical[name] = digest(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()));
    }
    const exports = [];
    for (const row of db.prepare('SELECT payload FROM run_exports').all()) {
      const manifest = JSON.parse(row.payload),
        artifactRow = db
          .prepare('SELECT payload FROM artifacts WHERE id=?')
          .get(manifest.artifactId);
      if (!artifactRow) fail();
      const artifact = JSON.parse(artifactRow.payload);
      if (
        !artifact.relativeStoragePath ||
        material.data[artifact.relativeStoragePath] !== artifact.sha256
      )
        fail();
      exports.push({ runId: manifest.qaRunId, format: manifest.format, sha256: artifact.sha256 });
    }
    exports.sort((a, b) => (a.runId + a.format).localeCompare(b.runId + b.format));
    return {
      generation: marker.generation,
      schemaHash: schema(db),
      migrations,
      counts,
      canonical,
      exports,
      files: material,
    };
  } finally {
    db?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function sealBundle(root, identity) {
  const receipt = { ...(await inspectBundle(root)), identity: identityOf(identity) };
  await writeFile(join(root, 'backup.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return receipt;
}
export async function verifyBundle(root, identity) {
  const actual = await inspectBundle(root);
  const receipt = await readRegularJson(join(root, 'backup.json'));
  if (JSON.stringify(receipt.identity) !== JSON.stringify(identityOf(identity))) fail();
  if (JSON.stringify({ ...actual, identity: identityOf(identity) }) !== JSON.stringify(receipt))
    fail();
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, root, identityFile] = process.argv.slice(2);
    if (!['seal', 'verify'].includes(mode) || !root || !identityFile) fail();
    const identity = parseIdentity(await readRegularJson(identityFile));
    const result = await (mode === 'seal' ? sealBundle : verifyBundle)(root, identity);
    console.log(
      JSON.stringify({
        verified: true,
        generation: result.generation,
        schemaHash: result.schemaHash,
        counts: result.counts,
        exports: result.exports,
      }),
    );
  } catch {
    console.error('Recovery backup verification refused; preserve the original bundle.');
    process.exitCode = 1;
  }
}
