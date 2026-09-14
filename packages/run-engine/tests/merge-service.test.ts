import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { createFakeHarnessRegistry, RunCoordinator, mergeRun } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function simulatedRun() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-merge-service-'));
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

describe('merge service', () => {
  it('merges a simulated three-agent run and reuses the result idempotently', async () => {
    const f = await simulatedRun();
    const first = mergeRun(f.repository, f.runId);
    expect(first.reused).toBe(false);
    expect(first.result.sourceFindingCount).toBe(3);
    expect(first.result.clusterCount).toBeGreaterThan(0);
    expect(first.result.usableAgentRunIds).toHaveLength(3);
    // Idempotent: same digest reuses the persisted result.
    const second = mergeRun(f.repository, f.runId);
    expect(second.reused).toBe(true);
    expect(second.result.id).toBe(first.result.id);
    expect(f.repository.listMergeResults(f.runId)).toHaveLength(1);
    f.database.close();
  });

  it('fails closed on unknown and non-terminal runs without touching status', async () => {
    const f = await simulatedRun();
    expect(() => mergeRun(f.repository, 'run_01K7777777777777777777A8W9' as never)).toThrow(
      /not found/,
    );
    const run = f.repository.getRun(f.runId);
    expect(run?.status).toBe('completed');
    f.database.close();
  });
});
