import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeInstanceLease, SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import {
  createFakeHarnessRegistry,
  ingestMergeIssues,
  mergeRun,
  RunCoordinator,
  verifyMerge,
} from '@qa/run-engine';
import { SystemdSandboxBackend } from '@qa/verifier';
import { SentryRuntimeHost } from '../src/runtime.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production RPC and historical pipeline compatibility', () => {
  it.each(['runs.merge', 'runs.verify', 'issues.ingest', 'verify.start'])(
    'keeps retired %s unreachable over runtime RPC',
    async (method) => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-retired-rpc-'));
      roots.push(root);
      const host = new SentryRuntimeHost(root, () => undefined);
      try {
        await host.recover();
        await expect(host.dispatch(method, {})).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
      } finally {
        host.close();
      }
    },
  );

  it.each(['full', 'targeted'] as const)(
    'reads persisted %s findings, evidence and historical lineage after reopening',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'sentry-pipeline-history-'));
      roots.push(root);
      const source = join(root, 'source');
      const dataRoot = join(root, 'data');
      await mkdir(source);
      await writeFile(join(source, 'README.md'), '# Historical fixture\n');
      const database = new SentryDatabase({ dataRoot });
      const repository = new SentryRepository(database);
      const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
      lease.start();
      const saved = await (async () => {
        try {
          const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
          const added = await manager.addProject(source);
          // Simulation is an explicit fixture for old data, never a production adapter.
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
          const { result: merge } = mergeRun(repository, details.run.id);
          // Saved compatibility outcomes only: this test makes no real sandbox claim.
          vi.spyOn(SystemdSandboxBackend.prototype, 'preflight').mockResolvedValue({
            available: false,
            backend: 'none',
            reason: 'controlled compatibility fixture',
          });
          const verification = await verifyMerge(repository, dataRoot, merge.id);
          const ingested = ingestMergeIssues(repository, merge.id);
          expect(details.findings.length).toBeGreaterThan(0);
          expect(verification.attempts.length).toBeGreaterThan(0);
          expect(ingested.issues.length).toBeGreaterThan(0);
          return {
            details,
            merge,
            verification,
            ingested,
            clusters: repository.listClusters(merge.id),
            occurrences: repository.listOccurrencesForRun(details.run.id),
          };
        } finally {
          lease.release();
          database.close();
        }
      })();
      const host = new SentryRuntimeHost(dataRoot, () => undefined);
      try {
        await host.recover();
        const snapshot = await host.dispatch('runs.get', { runId: saved.details.run.id });
        expect(snapshot).toMatchObject({
          run: saved.details.run,
          agentRuns: saved.details.agentRuns,
          findings: saved.details.findings,
          evidence: saved.details.evidence,
          mergeResults: [{ ...saved.merge, clusters: saved.clusters }],
          verificationRuns: [{ ...saved.verification.run, attempts: saved.verification.attempts }],
          issues: saved.occurrences,
          ...(mode === 'targeted' ? { targetSpec: { includePaths: ['README.md'] } } : {}),
        });
        for (const issue of saved.ingested.issues) {
          expect(await host.dispatch('issues.get', { issueId: issue.issueId })).toBeDefined();
          expect(await host.dispatch('retests.list', { issueId: issue.issueId })).toEqual([]);
        }
      } finally {
        host.close();
      }
    },
    30000,
  );
});
