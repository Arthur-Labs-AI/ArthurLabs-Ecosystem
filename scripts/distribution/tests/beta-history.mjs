// Explicit no-provider acceptance helper. Uses the published beta's persistence
// implementation to seed a new disposable database; never accepts an owner DB.
// node beta-history.mjs betaCheckout receiptOutput
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [checkout, receiptOutput] = process.argv.slice(2);
if (process.platform !== 'linux' || !checkout || !receiptOutput)
  throw new Error('Usage on Linux: beta-history.mjs publishedBetaCheckout receiptOutput');
const beta = resolve(checkout);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: beta, encoding: 'utf8' }).trim();
assert.equal(sha, '0e5c10cfa80f6385ebfc88a7306b38ce8a12ce38');
const { SentryDatabase, SentryRepository } = await import(
  pathToFileURL(join(beta, 'packages/persistence/dist/index.js')).href
);
const fixture = async (name) =>
  JSON.parse(await readFile(join(beta, 'packages/domain/tests/fixtures', name + '.json'), 'utf8'));
const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-beta-history-'));
const source = join(dataRoot, 'synthetic-source');
await mkdir(source);
await writeFile(join(source, 'index.js'), 'export const fixture = true;\n');
const project = { ...(await fixture('project')), sourcePath: source };
const revision = { ...(await fixture('project-revision')), sourcePath: source };
const snapshot = await fixture('snapshot');
const targetRevision = { ...(await fixture('project-revision-2')), sourcePath: source };
const targetSnapshot = await fixture('snapshot-2');
const run = { ...(await fixture('qa-run')), status: 'completed' };
const artifact = await fixture('artifact');
const agent = await fixture('agent-run-muse');
const finding = await fixture('finding');
const evidence = await fixture('evidence');
const db = new SentryDatabase({ dataRoot });
const repo = new SentryRepository(db);
try {
  repo.saveProject(project);
  repo.saveRevision(revision);
  repo.saveManagedCopy(await fixture('managed-project-copy'));
  const { qaRunId: ignoredRun, ...manifest } = artifact;
  void ignoredRun;
  repo.saveArtifact({ ...manifest, id: snapshot.manifest.artifactId, projectId: project.id });
  repo.saveSnapshot(snapshot);
  repo.saveRevision(targetRevision);
  repo.saveArtifact({ ...manifest, id: targetSnapshot.manifest.artifactId, projectId: project.id });
  repo.saveSnapshot(targetSnapshot);
  repo.saveContext(await fixture('project-context'));
  repo.saveRun(run);
  repo.saveAgentRun(agent);
  repo.saveArtifact(artifact);
  repo.saveEvidence(evidence);
  repo.saveFinding(finding);
  const issueId = 'issue_01K7777777777777777777D8WC';
  const retestId = 'retest_01K7777777777777777777D8WJ';
  const createdAt = project.createdAt;
  repo.saveIssue({
    schemaVersion: 1,
    id: issueId,
    projectId: project.id,
    title: 'Synthetic historical issue',
    category: 'logic',
    severity: 'high',
    createdAt,
    updatedAt: createdAt,
  });
  repo.saveRetestRun({
    schemaVersion: 1,
    id: retestId,
    retestVersion: 1,
    projectId: project.id,
    issueId,
    sourceProjectRevisionId: revision.id,
    targetProjectRevisionId: targetRevision.id,
    sourceSnapshotId: snapshot.id,
    targetSnapshotId: targetSnapshot.id,
    sourceQaRunId: run.id,
    sourceMergeResultId: 'merge_01K7777777777777777777D8WA',
    sourceFindingClusterId: 'cluster_01K7777777777777777777D8WB',
    agentStackIds: ['stack_muse_main'],
    status: 'completed',
    createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
  });
  assert.equal(repo.getRun(run.id).status, 'completed');
  assert.equal(repo.listFindings(run.id).length, 1);
  assert.equal(repo.listEvidence(run.id).length, 1);
  assert.equal(repo.getRetestRun(retestId).status, 'completed');
  await writeFile(
    receiptOutput,
    JSON.stringify(
      {
        betaCommit: sha,
        dataRoot,
        projectId: project.id,
        revisionId: revision.id,
        runId: run.id,
        findingId: finding.id,
        evidenceId: evidence.id,
        issueId,
        retestId,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  db.close();
}
console.log(JSON.stringify({ seededWithPublishedBeta: sha, dataRoot, receiptOutput }));
