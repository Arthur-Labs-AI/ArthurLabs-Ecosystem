import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeInstanceLease, SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { createFakeHarnessRegistry, RunCoordinator } from '@qa/run-engine';
import { SentryRuntimeHost } from '../src/runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production RPC surface and persisted run reads', () => {
  it.each([
    'runs.merge',
    'runs.verify',
    'issues.ingest',
    'verify.start',
    'issues.list',
    'issues.get',
    'issues.history',
    'retests.list',
    'retests.start',
    'retests.get',
    'retests.cancel',
  ])('keeps removed %s unreachable over runtime RPC', async (method) => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-retired-rpc-'));
    roots.push(root);
    const host = new SentryRuntimeHost(root, () => undefined);
    try {
      await host.recover();
      await expect(host.dispatch(method, {})).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
    } finally {
      host.close();
    }
  });

  it.each(['full', 'targeted'] as const)(
    'reads persisted %s findings and evidence after reopening',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-pipeline-history-'));
      roots.push(root);
      const source = join(root, 'source');
      const dataRoot = join(root, 'data');
      await mkdir(source);
      await writeFile(join(source, 'README.md'), '# Persisted fixture\n');
      const database = new SentryDatabase({ dataRoot });
      const repository = new SentryRepository(database);
      const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
      lease.start();
      const saved = await (async () => {
        try {
          const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
          const added = await manager.addProject(source);
          // Simulation is an explicit fixture, never a production adapter.
          const coordinator = new RunCoordinator(
            dataRoot,
            repository,
            lease,
            createFakeHarnessRegistry('success'),
          );
          const details = await coordinator.run(added.project.id, {
            executionKind: 'simulation',
            mode,
            ...(mode === 'targeted' ? { target: { includePaths: ['README.md'] } } : {}),
          });
          expect(details.findings.length).toBeGreaterThan(0);
          return details;
        } finally {
          lease.release();
          database.close();
        }
      })();
      const host = new SentryRuntimeHost(dataRoot, () => undefined);
      try {
        await host.recover();
        const snapshot = await host.dispatch('runs.get', { runId: saved.run.id });
        expect(snapshot).toMatchObject({
          run: saved.run,
          agentRuns: saved.agentRuns,
          findings: saved.findings,
          evidence: saved.evidence,
          ...(mode === 'targeted' ? { targetSpec: { includePaths: ['README.md'] } } : {}),
        });
        expect(snapshot).not.toHaveProperty('mergeResults');
        expect(snapshot).not.toHaveProperty('verificationRuns');
        expect(snapshot).not.toHaveProperty('issues');
      } finally {
        host.close();
      }
    },
    30000,
  );
});
