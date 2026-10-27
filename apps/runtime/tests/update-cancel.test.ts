import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
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

describe('revision update cancellation', () => {
  it('aborts an in-flight update and preserves the healthy copy', async () => {
    const { mkdtemp: mk } = await import('node:fs/promises');
    const { tmpdir: td } = await import('node:os');
    const { join: jn } = await import('node:path');
    const root = await mk(jn(td(), 'sentry-update-cancel-'));
    roots.push(root);
    const source = jn(root, 'source');
    await mkdir(jn(source, 'src'), { recursive: true });
    await writeFile(jn(source, 'package.json'), '{"name":"cancel-me"}');
    await writeFile(jn(source, 'src', 'a.ts'), 'export const a = 1;');
    const { SentryDatabase, SentryRepository, RuntimeInstanceLease } =
      await import('@qa/persistence');
    const { ProjectManager } = await import('@qa/project-manager');
    const seedDb = new SentryDatabase({ dataRoot: jn(root, 'data') });
    const seedRepo = new SentryRepository(seedDb);
    const seedLease = new RuntimeInstanceLease(seedRepo, { autoHeartbeat: false });
    seedLease.start();
    const seedProjects = new ProjectManager(jn(root, 'data'), seedRepo, {
      runtimeLease: seedLease,
    });
    const added = await seedProjects.addProject(source);
    const revisionBefore = added.revision.id;
    seedLease.release();
    seedDb.close();
    const host = new SentryRuntimeHost(jn(root, 'data'), () => undefined);
    try {
      // The abort lands before the in-flight update reaches any signal
      // check, so the rejection below is deterministic (no timing race).
      const pending = host.updateProject(added.project.id);
      const cancelled = host.cancelUpdateProject();
      expect(cancelled).toEqual({ cancelled: true, count: 1 });
      await expect(pending).rejects.toThrow();
      expect(host.cancelUpdateProject()).toEqual({ cancelled: false, count: 0 });
      const copy = host.getProject(added.project.id) as unknown as {
        managedCopy: { state: string };
        revision: { id: string };
      };
      expect(copy.managedCopy.state).toBe('ready');
      expect(copy.revision.id).toBe(revisionBefore);
      const { projectDataPaths } = await import('@qa/persistence');
      const kept = await readFile(
        join(projectDataPaths(jn(root, 'data'), added.project.id).workingCopy, 'src', 'a.ts'),
        'utf8',
      );
      expect(kept).toContain('export const a = 1;');
    } finally {
      host.close();
    }
  }, 60000);

  it('routes projects.cancelUpdate to the revision abort', async () => {
    const { mkdtemp: mk } = await import('node:fs/promises');
    const { tmpdir: td } = await import('node:os');
    const { join: jn } = await import('node:path');
    const root = await mk(jn(td(), 'sentry-update-cancel-rpc-'));
    roots.push(root);
    const host = new SentryRuntimeHost(jn(root, 'data'), () => undefined);
    try {
      await expect(host.dispatch('projects.cancelUpdate', {})).resolves.toEqual({
        cancelled: false,
        count: 0,
      });
    } finally {
      host.close();
    }
  }, 60000);
});
