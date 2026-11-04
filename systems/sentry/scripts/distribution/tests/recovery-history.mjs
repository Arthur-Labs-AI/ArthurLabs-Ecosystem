// No-provider historical acceptance fixture; creates only a fresh /var/tmp root.
// node recovery-history.mjs <immutable-beta-checkout> <private-receipt-output>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [input, output] = process.argv.slice(2);
assert.equal(process.platform, 'linux');
assert.ok(input && output);
const beta = resolve(input),
  betaCommit = '0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38';
assert.equal(
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: beta, encoding: 'utf8' }).trim(),
  betaCommit,
);
assert.equal(
  execFileSync('git', ['status', '--porcelain'], { cwd: beta, encoding: 'utf8' }).trim(),
  '',
);
const root = await mkdtemp('/var/tmp/sentry-recovery-'),
  dataRoot = join(root, 'live/data');
const env = { ...process.env, SENTRY_DATA_ROOT: dataRoot, SENTRY_CLI_TRANSPORT: 'direct' };
for (const name of Object.keys(env))
  if (
    /^(OPENROUTER_API_KEY|OPENCODE_API_KEY|DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN|SENTRY_LIVE_)/.test(
      name,
    )
  )
    delete env[name];
const cli = (...args) => {
  let result;
  try {
    result = execFileSync(
      process.execPath,
      [join(beta, 'apps/cli/dist/index.js'), ...args, '--json'],
      { env, encoding: 'utf8', timeout: 180000 },
    );
  } catch (error) {
    assert.ok([5].includes(error.status));
    result = error.stdout;
  }
  const response = JSON.parse(result);
  assert.equal(response.ok, true);
  return response.data;
};
const source = join(root, 'source-a'),
  otherSource = join(root, 'source-b');
for (const path of [source, otherSource]) {
  await mkdir(path);
  await writeFile(join(path, 'README.md'), '# Synthetic recovery fixture\n');
  await writeFile(join(path, 'index.js'), 'export const version = 1;\n');
}
const first = cli('project', 'add', source),
  second = cli('project', 'add', otherSource);
const run = cli('run', 'simulate', first.projectId, '--scenario', 'success');
const merged = cli('run', 'merge', run.runId);
const { SentryDatabase, SentryRepository } = await import(
  pathToFileURL(join(beta, 'packages/persistence/dist/index.js')).href
);
const { RetestRunSchema } = await import(
  pathToFileURL(join(beta, 'packages/schemas/dist/index.js')).href
);
const { createRetestRunId } = await import(
  pathToFileURL(join(beta, 'packages/shared/dist/index.js')).href
);
let db = new SentryDatabase({ dataRoot }),
  repo = new SentryRepository(db);
const merge = repo.listMergeResults(run.runId)[0];
assert.ok(merge);
db.close();
const ingested = cli('issue', 'ingest', merge.id);
assert.ok(ingested.issues.length > 0);
await writeFile(join(source, 'index.js'), 'export const version = 2;\n');
cli('project', 'update', first.projectId);
const target = cli('run', 'simulate', first.projectId, '--scenario', 'success');
await writeFile(join(otherSource, 'index.js'), 'export const version = 2;\n');
cli('project', 'update', second.projectId);
db = new SentryDatabase({ dataRoot });
repo = new SentryRepository(db);
const sourceRun = repo.getRun(run.runId),
  targetRun = repo.getRun(target.runId);
const sourceSnapshot = repo.getSnapshot(sourceRun.snapshotId),
  targetSnapshot = repo.getSnapshot(targetRun.snapshotId);
const issueId = ingested.issues[0].issueId,
  cluster = repo.listClusters(merge.id)[0],
  retestId = createRetestRunId();
repo.saveRetestRun(
  RetestRunSchema.parse({
    schemaVersion: 1,
    id: retestId,
    retestVersion: 1,
    projectId: first.projectId,
    issueId,
    sourceProjectRevisionId: sourceSnapshot.projectRevisionId,
    targetProjectRevisionId: targetSnapshot.projectRevisionId,
    sourceSnapshotId: sourceSnapshot.id,
    targetSnapshotId: targetSnapshot.id,
    sourceQaRunId: run.runId,
    targetQaRunId: target.runId,
    sourceMergeResultId: merge.id,
    sourceFindingClusterId: cluster.id,
    agentStackIds: targetRun.configuration.agentStackIds,
    status: 'completed',
    createdAt: targetRun.createdAt,
    startedAt: targetRun.createdAt,
    completedAt: targetRun.completedAt ?? targetRun.createdAt,
  }),
);
const agentRunId = repo.listAgentRuns(run.runId)[0].id,
  findingId = repo.listFindings(run.runId)[0].id,
  evidenceId = repo.listEvidence(run.runId)[0].id;
const checkpoint = db.connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
assert.equal(checkpoint.busy, 0);
db.close();
for (const runId of [run.runId, target.runId])
  for (const format of ['json', 'log']) cli('run', 'export', runId, '--format', format);
db = new SentryDatabase({ dataRoot });
assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
const generation = { generation: randomUUID(), fixtureOnly: true };
await writeFile(join(dataRoot, 'recovery-generation.json'), JSON.stringify(generation));
const receipt = {
  betaCommit,
  root,
  dataRoot,
  generation,
  projectId: first.projectId,
  secondProjectId: second.projectId,
  revisionId: sourceSnapshot.projectRevisionId,
  runId: run.runId,
  targetRunId: target.runId,
  agentRunId,
  findingId,
  evidenceId,
  issueId,
  retestId,
  sourceSnapshotId: sourceSnapshot.id,
  targetSnapshotId: targetSnapshot.id,
  mergeId: merge.id,
  clusterId: cluster.id,
};
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({
    seeded: true,
    betaCommit,
    paidProviders: false,
    actualExports: ['json', 'log'],
    generation: generation.generation,
  }),
);
