import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { RunCoordinator, createFakeHarnessRegistry } from '@qa/run-engine';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';
import { INITIAL_AGENT_STACKS } from '@qa/domain';

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

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-issue-state-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Issue fixture');
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'issue-fixture' }));
  await writeFile(join(source, 'src', 'index.ts'), 'export const ok = true;');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const registry = createFakeHarnessRegistry('success');
  const coordinator = new RunCoordinator(dataRoot, repository, lease, registry);
  const added = await projects.addProject(source);
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
  return {
    dataRoot,
    database,
    repository,
    lease,
    service,
    coordinator,
    projectId: added.project.id,
  };
}

describe('backend issue state projection', () => {
  it('newly ingested issues project open via the service', async () => {
    const h = await harness();
    const full = await h.coordinator.run(h.projectId, {
      executionKind: 'simulation',
      mode: 'full',
    });
    const merged = h.service.mergeRun(full.run.id) as { result: { id: string } };
    const ingested = h.service.ingestIssues(merged.result.id) as {
      issues: Array<{ issueId: string }>;
    };
    expect(ingested.issues.length).toBeGreaterThan(0);
    const list = h.service.listIssues(h.projectId) as Array<{
      id: string;
      currentState: string;
    }>;
    expect(list.length).toBe(ingested.issues.length);
    for (const item of list) expect(item.currentState).toBe('open');
    const one = (await h.service.getIssue(ingested.issues[0]?.issueId as string)) as {
      currentState: string;
    };
    expect(one.currentState).toBe('open');
    const history = (await h.service.issueHistory(ingested.issues[0]?.issueId as string)) as {
      currentState: string;
    };
    expect(history.currentState).toBe('open');
    h.lease.release();
    h.database.close();
  }, 60000);
});
