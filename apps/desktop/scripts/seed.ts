/**
 * Developer-only seed helper: pnpm --filter @qa/desktop seed
 * Creates deterministic simulation fixtures (no paid provider calls):
 * completed FULL, TARGETED on src/auth, merge + verify + ingested issue.
 */
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import {
  RunCoordinator,
  createFakeHarnessRegistry,
  mergeRun,
  verifyMerge,
  ingestMergeIssues,
} from '@qa/run-engine';

async function main(): Promise<void> {
  const dataRoot = process.env['SENTRY_DATA_ROOT'] ?? resolveSentryDataRoot();
  const source = await mkdtempSeedSource();
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  try {
    const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
    const added = await manager.addProject(source);
    console.log('seed: project ' + added.project.id);
    const coordinator = new RunCoordinator(
      dataRoot,
      repository,
      lease,
      createFakeHarnessRegistry('success'),
    );
    const full = await coordinator.run(added.project.id, {
      executionKind: 'simulation',
      mode: 'full',
    });
    console.log('seed: FULL ' + full.run.id + ' status=' + full.run.status);
    const targeted = await coordinator.run(added.project.id, {
      executionKind: 'simulation',
      mode: 'targeted',
      target: { includePaths: ['src/auth'] },
    });
    console.log('seed: TARGETED ' + targeted.run.id + ' status=' + targeted.run.status);
    const merged = mergeRun(repository, full.run.id);
    console.log('seed: merge ' + merged.result.id + ' clusters=' + merged.result.clusters.length);
    try {
      const verified = await verifyMerge(repository, dataRoot, merged.result.id);
      console.log(
        'seed: verification ' + verified.run.id + ' attempts=' + verified.attempts.length,
      );
    } catch (error) {
      console.log(
        'seed: verification skipped: ' +
          (error instanceof Error ? error.message : String(error)).slice(0, 200),
      );
    }
    const ingested = ingestMergeIssues(repository, merged.result.id);
    console.log('seed: issues ' + ingested.issues.length);
    // Partial run: one agent fails (GLM transport-loss), merger shows 2/3 usable.
    const partialCoordinator = new RunCoordinator(
      dataRoot,
      repository,
      lease,
      createFakeHarnessRegistry('partial'),
    );
    const partial = await partialCoordinator.run(added.project.id, {
      executionKind: 'simulation',
      mode: 'full',
    });
    console.log('seed: PARTIAL ' + partial.run.id + ' status=' + partial.run.status);
    // Cancelled run: request cancellation before agents settle is timing-sensitive;
    // seed a second project revision instead so retest has an A→B lineage.
    await writeFile(
      join(source, 'src', 'auth', 'token-service.ts'),
      "export function refresh(token: string): string {\n  if (token.length === 0) throw new Error('empty');\n  return token;\n}\n",
    );
    const updated = await manager.updateProjectCopy(added.project.id);
    console.log('seed: revision B ' + updated.revision.id);
    // Retest the first ingested issue against revision B (simulation registry).
    if (ingested.issues[0] !== undefined) {
      const { retestIssue } = await import('@qa/run-engine');
      try {
        const retest = await retestIssue(
          { dataRoot, repository, lease, registry: createFakeHarnessRegistry('success') },
          ingested.issues[0].issueId,
          {},
        );
        console.log(
          'seed: retest ' + retest.retestRun.id + ' assessment=' + retest.assessment?.result,
        );
      } catch (error) {
        console.log(
          'seed: retest skipped: ' +
            (error instanceof Error ? error.message : String(error)).slice(0, 200),
        );
      }
    }
  } finally {
    lease.release();
    database.close();
  }
}

async function mkdtempSeedSource(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sentry-desktop-seed-'));
  await mkdir(join(root, 'src', 'auth'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Seed fixture\n\nDeterministic desktop seed.');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'seed-fixture', version: '0.0.0' }),
  );
  await writeFile(
    join(root, 'src', 'auth', 'token-service.ts'),
    'export function refresh(token: string): string { return token; }\n',
  );
  return root;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
