import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { projectIssueState } from '@qa/schemas';
import {
  createFakeHarnessRegistry,
  ingestMergeIssues,
  mergeRun,
  RunCoordinator,
  RunEngineError,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-ingest-'));
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
  return { root, source, dataRoot, database, repository, lease, manager, added };
}

describe('Phase 7 issue ingest (§31, §74–§75)', () => {
  it('creates one issue per cluster with occurrences and open state', async () => {
    const f = await fixture();
    const coordinator = new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      createFakeHarnessRegistry('success'),
    );
    const run = await coordinator.run(f.added.project.id, { executionKind: 'simulation' });
    const { result: merge } = mergeRun(f.repository, run.run.id);
    expect(merge.clusterCount).toBeGreaterThan(0);
    const ingested = ingestMergeIssues(f.repository, merge.id);
    expect(ingested.issues).toHaveLength(merge.clusterCount);
    expect(ingested.issues.every((issue) => issue.created)).toBe(true);
    for (const item of ingested.issues) {
      const issue = f.repository.getIssue(item.issueId);
      expect(issue?.projectId).toBe(f.added.project.id);
      expect(f.repository.listIssueOccurrences(item.issueId)).toHaveLength(1);
      expect(projectIssueState(f.repository.listIssueEvents(item.issueId))).toBe('open');
    }
    const listed = f.repository.listIssues(f.added.project.id);
    expect(listed).toHaveLength(merge.clusterCount);
    f.database.close();
  });

  it('is idempotent: repeated ingest returns originals without duplicates (§76)', async () => {
    const f = await fixture();
    const coordinator = new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      createFakeHarnessRegistry('success'),
    );
    const run = await coordinator.run(f.added.project.id, { executionKind: 'simulation' });
    const { result: merge } = mergeRun(f.repository, run.run.id);
    const first = ingestMergeIssues(f.repository, merge.id);
    const second = ingestMergeIssues(f.repository, merge.id);
    expect(second.issues).toEqual(first.issues.map((issue) => ({ ...issue, created: false })));
    expect(f.repository.listIssues(f.added.project.id)).toHaveLength(first.issues.length);
    f.database.close();
  });

  it('rejects unknown merges without inventing history (§73)', async () => {
    const f = await fixture();
    expect(() => ingestMergeIssues(f.repository, 'merge_01K7777777777777777777A8W9')).toThrowError(
      RunEngineError,
    );
    f.database.close();
  });
});
