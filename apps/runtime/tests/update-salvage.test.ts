import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryRuntimeHost } from '../src/runtime.js';

const roots: string[] = [];
async function rmRoot(value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(value, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rmRoot(value)));
});

describe('stale update salvage', () => {
  it('heals a dead-instance updating state instead of blocking forever', async () => {
    const { mkdtemp: mk } = await import('node:fs/promises');
    const { tmpdir: td } = await import('node:os');
    const { join: jn } = await import('node:path');
    const root = await mk(jn(td(), 'sentry-salvage-'));
    roots.push(root);
    const source = jn(root, 'source');
    await mkdir(jn(source, 'src'), { recursive: true });
    await writeFile(jn(source, 'package.json'), '{"name":"salvage"}');
    await writeFile(jn(source, 'src', 'a.ts'), 'export const a = 1;');
    // Seed via core (same-process), then fake a dead-instance update op.
    const { SentryDatabase, SentryRepository, RuntimeInstanceLease } = await import('@qa/persistence');
    const { ProjectManager } = await import('@qa/project-manager');
    const seedDb = new SentryDatabase({ dataRoot: jn(root, 'data') });
    const seedRepo = new SentryRepository(seedDb);
    const seedLease = new RuntimeInstanceLease(seedRepo, { autoHeartbeat: false });
    seedLease.start();
    const seedProjects = new ProjectManager(jn(root, 'data'), seedRepo, { runtimeLease: seedLease });
    const added = await seedProjects.addProject(source);
    // Reuse the seed lease's instance id for the fake op row (FK): the lease
    // is released below, so the owner reads as dead to the host's recovery.
    const deadInstanceId = seedLease.instanceId;
    seedLease.release();
    seedDb.close();
    // Simulate a killed update: state=updating + stale operation row.
    const { createOperationId, nowIsoTimestamp } = await import('@qa/shared');
    const { RuntimeOperationSchema } = await import('@qa/schemas');
    const db2 = new SentryDatabase({ dataRoot: jn(root, 'data') });
    const repo2 = new SentryRepository(db2);
    const { ManagedProjectCopySchema } = await import('@qa/schemas');
    const copy = repo2.getManagedCopy(added.project.id);
    repo2.saveManagedCopy(
      ManagedProjectCopySchema.parse({
        ...copy,
        state: 'updating',
        runtimeInstanceId: deadInstanceId,
      }),
    );
    repo2.saveRuntimeOperation(
      RuntimeOperationSchema.parse({
        schemaVersion: 1,
        id: createOperationId(),
        projectId: added.project.id,
        runtimeInstanceId: deadInstanceId,
        type: 'project_update',
        stage: 'preparing',
        createdAt: nowIsoTimestamp(),
        updatedAt: nowIsoTimestamp(),
      }),
    );
    db2.close();
    const host = new SentryRuntimeHost(jn(root, 'data'), () => undefined);
    try {
      await host.recover();
      // updateProject must salvage (dead owner) and proceed to validation,
      // not fail with PROJECT_LOCKED. It succeeds fully on the tiny fixture.
      const result = (await host.updateProject(added.project.id)) as {
        revision: { id: string };
        managedCopy: { state: string };
      };
      expect(result.managedCopy.state).toBe('ready');
    } finally {
      host.close();
    }
  }, 120000);
});
