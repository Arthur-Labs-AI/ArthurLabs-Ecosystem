import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { resolveInside } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { createFakeHarnessRegistry, mergeRun, RunCoordinator, RunExporter } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function simulatedRun() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-merge-export-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  const coordinator = new RunCoordinator(
    dataRoot,
    repository,
    lease,
    createFakeHarnessRegistry('success'),
  );
  const result = await coordinator.run(added.project.id, { executionKind: 'simulation' });
  return { dataRoot, database, repository, runId: result.run.id };
}

async function readExport(
  dataRoot: string,
  repository: SentryRepository,
  artifactId: string,
): Promise<string> {
  const artifact = repository.getArtifact(artifactId);
  if (artifact === undefined) throw new Error('Export artifact missing');
  return readFile(resolveInside(dataRoot, artifact.relativeStoragePath), 'utf8');
}

describe('merge-aware exports', () => {
  it('regenerates a stale cached export after merge, and only then', async () => {
    const f = await simulatedRun();
    const exporter = new RunExporter(f.dataRoot, f.repository);
    // Pre-merge export: cached, no merge sections.
    const first = await exporter.export(f.runId, 'json');
    const firstJson = JSON.parse(await readExport(f.dataRoot, f.repository, first.artifactId)) as {
      mergeResults: unknown[];
      findingClusters: unknown[];
    };
    expect(firstJson.mergeResults).toHaveLength(0);
    expect(firstJson.findingClusters).toHaveLength(0);
    // Export again with no merge: must return the identical cached manifest.
    const cached = await exporter.export(f.runId, 'json');
    expect(cached.artifactId).toBe(first.artifactId);
    // Merge, then export: stale cache is superseded and sections appear.
    const { result } = mergeRun(f.repository, f.runId);
    expect(result.clusterCount).toBeGreaterThan(0);
    const second = await exporter.export(f.runId, 'json');
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(f.repository.getArtifact(first.artifactId)).toBeUndefined();
    const secondJson = JSON.parse(
      await readExport(f.dataRoot, f.repository, second.artifactId),
    ) as { mergeResults: unknown[]; findingClusters: unknown[] };
    expect(secondJson.mergeResults).toHaveLength(1);
    expect(secondJson.findingClusters).toHaveLength(result.clusterCount);
    // Export once more with no new merge: fresh cache is reused.
    const stable = await exporter.export(f.runId, 'json');
    expect(stable.artifactId).toBe(second.artifactId);
    // Log export renders cluster lines too.
    const log = await exporter.export(f.runId, 'log');
    const logText = await readExport(f.dataRoot, f.repository, log.artifactId);
    expect(logText).toContain('Merge result ' + result.id);
    f.database.close();
  });
});
