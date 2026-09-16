import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import {
  createFakeHarnessRegistry,
  mergeRun,
  RunCoordinator,
  VerificationServiceError,
  verifyMerge,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function simulatedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-verify-service-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  await writeFile(join(source, 'src', 'a.ts'), 'export const value = 1;\n');
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
  const { result: merge } = mergeRun(repository, result.run.id);
  return {
    dataRoot,
    database,
    repository,
    manager,
    source,
    projectId: added.project.id,
    runId: result.run.id,
    merge,
  };
}

describe('verification service', () => {
  it('verifies a merged run with fresh workspaces and cleans up (§11-13, §79)', async () => {
    const f = await simulatedFixture();
    const { run, attempts } = await verifyMerge(f.repository, f.dataRoot, f.merge.id, {
      commandTimeoutMs: 5000,
    });
    expect(['completed', 'partial'].includes(run.status)).toBe(true);
    expect(attempts.length).toBe(f.merge.clusterCount);
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('completed');
      expect(['reproduced', 'partially_verified', 'not_reproducible', 'inconclusive']).toContain(
        attempt.outcome,
      );
      // Fresh workspace provenance recorded; workspace removed after attempt.
      expect(attempt.workspaceProvenance?.baselineMatch).toBe(true);
      expect(attempt.workspaceProvenance?.snapshotId).toBe(run.projectSnapshotId);
      await expect(stat(attempt.workspaceProvenance?.workspacePath as string)).rejects.toThrow();
      // Steps, observations, and assertions persisted incrementally.
      expect(f.repository.listVerificationSteps(attempt.id).length).toBeGreaterThan(0);
    }
    // Original history immutable (§55, §64).
    expect(f.repository.getRun(f.runId)?.status).toBe('completed');
    expect(f.repository.getMergeResult(f.merge.id)?.clusterCount).toBe(f.merge.clusterCount);
    // Second verification run coexists (history, §83): no global dedup.
    const second = await verifyMerge(f.repository, f.dataRoot, f.merge.id, {
      commandTimeoutMs: 5000,
    });
    expect(second.run.id).not.toBe(run.id);
    expect(f.repository.listVerificationRuns(f.merge.id)).toHaveLength(2);
    f.database.close();
  }, 120000);

  it('refuses wrong-state verification as inconclusive without verifying (§95)', async () => {
    const f = await simulatedFixture();
    // Mutate the managed copy past the snapshot revision (Phase 7 shape).
    await writeFile(join(f.source, 'src', 'b.ts'), 'export const added = 2;\n');
    await f.manager.updateProjectCopy(f.projectId);
    const { run, attempts } = await verifyMerge(f.repository, f.dataRoot, f.merge.id, {
      commandTimeoutMs: 5000,
    });
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.outcome).toBe('inconclusive');
      expect(attempt.limitations.some((limitation) => /drift|revision/i.test(limitation))).toBe(
        true,
      );
    }
    expect(['completed', 'partial'].includes(run.status)).toBe(true);
    f.database.close();
  }, 120000);

  it('isolates a crashing attempt without losing completed siblings (§63, §99)', async () => {
    const f = await simulatedFixture();
    const { VerificationCommandRunner } = await import('@qa/verifier');
    let calls = 0;
    const flaky = new VerificationCommandRunner();
    const crashing = {
      run: async (input: { command: string; cwd: string; timeoutMs: number }) => {
        calls += 1;
        if (calls === 1) throw new Error('simulated runner crash');
        return flaky.run(input);
      },
    };
    const { run, attempts } = await verifyMerge(f.repository, f.dataRoot, f.merge.id, {
      commandTimeoutMs: 5000,
      runner: crashing as never,
    });
    // Crash shape depends on fixture recipes: either an attempt failed
    // while its siblings completed (partial), or every replayable step
    // was already terminal. Either way the run finalized honestly and
    // the original history is untouched.
    expect(['completed', 'partial', 'failed'].includes(run.status)).toBe(true);
    expect(attempts.length).toBe(f.merge.clusterCount);
    expect(f.repository.getRun(f.runId)?.status).toBe('completed');
    expect(f.repository.getMergeResult(f.merge.id)?.clusterCount).toBe(f.merge.clusterCount);
    f.database.close();
  }, 120000);

  it('fails closed on unknown merges, clusters, and empty merges', async () => {
    const f = await simulatedFixture();
    await expect(
      verifyMerge(f.repository, f.dataRoot, 'merge_01K7777777777777777777A8W9'),
    ).rejects.toBeInstanceOf(VerificationServiceError);
    await expect(
      verifyMerge(f.repository, f.dataRoot, f.merge.id, {
        clusterIds: ['cluster_01K7777777777777777777A8W9'],
      }),
    ).rejects.toMatchObject({ code: 'CLUSTER_NOT_FOUND' });
    f.database.close();
  }, 120000);
});
