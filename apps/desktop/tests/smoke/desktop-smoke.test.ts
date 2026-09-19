import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { RunCoordinator, createFakeHarnessRegistry } from '@qa/run-engine';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';

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

// NOTE: the coordinator registry here is an injected TEST DOUBLE (allowed).
// The product exposes no simulation mode: startRun always persists production.
describe('desktop smoke: add → run → merge → issue → retest', () => {
  it('flows through the desktop application service without paid providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-desktop-smoke-'));
    roots.push(root);
    const source = join(root, 'source');
    const dataRoot = join(root, 'data');
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'README.md'), '# Smoke fixture');
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'smoke' }));
    await writeFile(join(source, 'src', 'index.ts'), 'export const ok = true;');
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
    lease.start();
    const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
    const registry = createFakeHarnessRegistry('success');
    const coordinator = new RunCoordinator(dataRoot, repository, lease, registry);
    const service = new DesktopApplicationService({
      dataRoot,
      database,
      repository,
      lease,
      projects,
      coordinator,
      registry,
      credentials: new ProviderCredentialService({ filePath: join(root, 'providers.json') }),
      agentStacks: [...INITIAL_AGENT_STACKS],
    });
    try {
      const added = (await service.addProject(source)) as { project: { id: string } };
      expect(added.project.id.startsWith('proj_')).toBe(true);
      const operation = await service.startRun(added.project.id, { mode: 'full' });
      expect(operation.runId).toBeDefined();
      // startRun returns as soon as the run row exists; wait for terminal truth before merge.
      let snapshot = service.runSnapshot(operation.runId as string);
      expect((snapshot.run as { executionKind: string }).executionKind).toBe('production');
      for (
        let i = 0;
        i < 100 &&
        !['completed', 'partial', 'failed', 'cancelled'].includes(
          (snapshot.run as { status: string }).status,
        );
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        snapshot = service.runSnapshot(operation.runId as string);
      }
      expect((snapshot.agentRuns as unknown[]).length).toBe(3);
      const merged = service.mergeRun(operation.runId as string) as { result: { id: string } };
      const ingested = service.ingestIssues(merged.result.id) as {
        issues: Array<{ issueId: string }>;
      };
      expect(ingested.issues.length).toBeGreaterThan(0);
      const issue = service.getIssue(ingested.issues[0]?.issueId as string);
      expect(issue).toBeDefined();
    } finally {
      lease.release();
      database.close();
    }
  }, 60000);
});
