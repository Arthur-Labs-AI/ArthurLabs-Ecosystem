import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapDesktop } from '../../src/main/bootstrap.js';

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

describe('desktop smoke: add → simulate → merge → issue → retest', () => {
  it('flows through the desktop application service without paid providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-desktop-smoke-'));
    roots.push(root);
    const source = join(root, 'source');
    const dataRoot = join(root, 'data');
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'README.md'), '# Smoke fixture');
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'smoke' }));
    await writeFile(join(source, 'src', 'index.ts'), 'export const ok = true;');
    process.env['SENTRY_DATA_ROOT'] = dataRoot;
    const app = await bootstrapDesktop(dataRoot);
    try {
      const added = (await app.service.addProject(source)) as { project: { id: string } };
      expect(added.project.id.startsWith('proj_')).toBe(true);
      const operation = await app.service.startSimulation(added.project.id, { mode: 'full' });
      expect(operation.runId).toBeDefined();
      // startSimulation navigates as soon as the run row exists; wait for terminal truth before merge.
      let snapshot = app.service.runSnapshot(operation.runId as string);
      for (
        let i = 0;
        i < 100 &&
        !['completed', 'partial', 'failed', 'cancelled'].includes(
          (snapshot.run as { status: string }).status,
        );
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        snapshot = app.service.runSnapshot(operation.runId as string);
      }
      expect((snapshot.agentRuns as unknown[]).length).toBe(3);
      const merged = app.service.mergeRun(operation.runId as string) as { result: { id: string } };
      const ingested = app.service.ingestIssues(merged.result.id) as {
        issues: Array<{ issueId: string }>;
      };
      expect(ingested.issues.length).toBeGreaterThan(0);
      const issue = app.service.getIssue(ingested.issues[0]?.issueId as string);
      expect(issue).toBeDefined();
    } finally {
      app.close();
      delete process.env['SENTRY_DATA_ROOT'];
    }
  }, 60000);
});
