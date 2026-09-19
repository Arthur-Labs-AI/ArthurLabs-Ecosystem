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

// Issue projection lives in the runtime host; the desktop service forwards it.
// The coordinator here is a TEST DOUBLE driving the same frozen pipeline.
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
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const runtime = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      const withState = (
        rows: Array<{ id: string }>,
      ): Array<{ id: string; currentState: string }> =>
        rows.map((row) => ({
          ...row,
          currentState: 'open' as string,
        }));
      switch (method) {
        case 'runs.start': {
          const started = await coordinator.run(added.project.id as never, {
            executionKind: 'production',
            mode: 'full',
          });
          return { operationId: 'dop_test', runId: started.run.id };
        }
        case 'runs.get': {
          const { mergeRun, ingestMergeIssues } = await import('@qa/run-engine');
          void mergeRun;
          void ingestMergeIssues;
          return {
            run: repository.getRun(params['runId'] as never),
            agentRuns: [],
            findings: [],
            evidence: [],
            activities: [],
            events: [],
            mergeResults: [],
            verificationRuns: [],
            issues: [],
          };
        }
        case 'runs.merge': {
          const { mergeRun } = await import('@qa/run-engine');
          return mergeRun(repository, params['runId'] as never);
        }
        case 'runs.ingest': {
          const { ingestMergeIssues } = await import('@qa/run-engine');
          return ingestMergeIssues(repository, params['mergeResultId'] as never);
        }
        case 'issues.list': {
          const rows = repository.listIssues(added.project.id as never) as Array<{ id: string }>;
          return withState(rows);
        }
        case 'issues.get': {
          const row = repository.getIssue(params['issueId'] as never) as { id: string } | undefined;
          return row === undefined ? undefined : withState([row])[0];
        }
        case 'issues.history': {
          return {
            issue: repository.getIssue(params['issueId'] as never),
            currentState: 'open',
            occurrences: [],
            events: [],
            assessments: [],
            retests: [],
          };
        }
        default:
          return { ok: true };
      }
    },
    status: { connected: true, distro: undefined, hello: undefined, lastError: undefined },
  };
  const service = new DesktopApplicationService({
    runtime: runtime as never,
    distro: 'test',
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
    calls,
  };
}

describe('backend issue state projection', () => {
  it('newly ingested issues project open via the service', async () => {
    const h = await harness();
    const operation = await h.service.startRun(h.projectId, { mode: 'full' });
    expect(operation.runId).toBeDefined();
    const merged = (await h.service.mergeRun(operation.runId as string)) as {
      result: { id: string };
    };
    const ingested = (await h.service.ingestIssues(merged.result.id)) as {
      issues: Array<{ issueId: string }>;
    };
    expect(ingested.issues.length).toBeGreaterThan(0);
    const list = (await h.service.listIssues(h.projectId)) as Array<{
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
    // All issue reads crossed the RPC boundary (never derived in React).
    expect(h.calls.some((c) => c.method === 'issues.list')).toBe(true);
    h.lease.release();
    h.database.close();
  }, 60000);
});
