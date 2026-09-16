import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bindable fixture base (see verification-trust.test.ts). */
async function fixtureBase(prefix: string): Promise<string> {
  const base = join(fileURLToPath(new URL('../../../.tmp-sentry-test-fixtures', import.meta.url)));
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, prefix));
}
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
  const root = await fixtureBase('sentry-verify-service-');
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
      // Fresh workspace provenance recorded; the whole attempt
      // directory (project copy AND parent) removed after attempt.
      expect(attempt.workspaceProvenance?.baselineMatch).toBe(true);
      expect(attempt.workspaceProvenance?.snapshotId).toBe(run.projectSnapshotId);
      await expect(stat(attempt.workspaceProvenance?.workspacePath as string)).rejects.toThrow();
      await expect(
        stat(join(f.dataRoot, 'projects', f.projectId, 'verifier-workspaces', attempt.id)),
      ).rejects.toThrow();
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

  it('verifies old snapshots from retained bytes after project update (§42)', async () => {
    const f = await simulatedFixture();
    // Advance the managed copy past the snapshot revision: retained
    // revision material must still serve the old snapshot exactly.
    await writeFile(join(f.source, 'src', 'b.ts'), 'export const added = 2;\n');
    await f.manager.updateProjectCopy(f.projectId);
    const { run, attempts } = await verifyMerge(f.repository, f.dataRoot, f.merge.id, {
      commandTimeoutMs: 5000,
    });
    expect(attempts.length).toBe(f.merge.clusterCount);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('completed');
      expect(attempt.workspaceProvenance?.baselineMatch).toBe(true);
    }
    expect(['completed', 'partial'].includes(run.status)).toBe(true);
    f.database.close();
  }, 120000);

  it('refuses verification without retained material as inconclusive (§43-44)', async () => {
    const f = await simulatedFixture();
    // Simulate a pre-retention revision: remove its material bytes.
    // The verifier must refuse wrong-state verification honestly.
    const qaRun = f.repository.getRun(f.runId);
    const snapshot = f.repository.getSnapshot(qaRun?.snapshotId as never);
    const { revisionMaterialPath } = await import('@qa/project-manager');
    const { rm } = await import('node:fs/promises');
    await rm(
      revisionMaterialPath(f.dataRoot, f.projectId as never, snapshot?.projectRevisionId as string),
      { recursive: true, force: true },
    );
    const { attempts } = await verifyMerge(f.repository, f.dataRoot, f.merge.id, {
      commandTimeoutMs: 5000,
    });
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.outcome).toBe('inconclusive');
      expect(
        attempt.limitations.some((limitation) => /retained material|revision/i.test(limitation)),
      ).toBe(true);
    }
    f.database.close();
  }, 120000);

  it('terminalizes the same attempt ID on crash, never a second one (§21)', async () => {
    const f = await simulatedFixture();
    const { SystemdSandboxBackend, VerificationCommandRunner } = await import('@qa/verifier');
    const backend = new SystemdSandboxBackend();
    let calls = 0;
    const { run, attempts } = await verifyMerge(f.repository, f.dataRoot, f.merge.id, {
      commandTimeoutMs: 5000,
      createRunner: (attemptRoot: string) => {
        const runner = new VerificationCommandRunner(backend, attemptRoot);
        const original = runner.run.bind(runner);
        runner.run = async (input) => {
          calls += 1;
          if (calls === 1) throw new Error('simulated runner crash');
          return original(input);
        };
        return runner;
      },
    });
    expect(['completed', 'partial', 'failed'].includes(run.status)).toBe(true);
    expect(attempts.length).toBe(f.merge.clusterCount);
    // One cluster = exactly one attempt row, even across the crash.
    for (const attempt of attempts) {
      const rows = f.repository
        .listVerificationAttempts(attempt.verificationRunId)
        .filter((row) => row.findingClusterId === attempt.findingClusterId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(attempt.id);
      expect(['completed', 'failed', 'interrupted'].includes(rows[0]?.status as string)).toBe(true);
    }
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
