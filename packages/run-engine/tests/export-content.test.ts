import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { createFakeHarnessRegistry, mergeRun, RunCoordinator } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function simulatedRun() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-export-content-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  const coordinator = new RunCoordinator(
    dataRoot,
    repository,
    lease,
    createFakeHarnessRegistry('success'),
  );
  const result = await coordinator.run(added.project.id, { executionKind: 'simulation' });
  return { dataRoot, database, repository, coordinator, runId: result.run.id };
}

describe('export content for Save As', () => {
  it('returns canonical JSON bytes with independent agent sections', async () => {
    const f = await simulatedRun();
    try {
      const content = await f.coordinator.exportContent(f.runId, 'json');
      expect(content.filename).toBe('sentry-' + f.runId + '.json');
      expect(content.mimeType).toBe('application/json');
      const parsed = JSON.parse(Buffer.from(content.contentBase64, 'base64').toString('utf8')) as {
        agentRuns: unknown[];
        findings: unknown[];
        evidence: unknown[];
        mergeResults: unknown[];
      };
      expect(parsed.agentRuns.length).toBeGreaterThan(0);
      expect(parsed.findings.length).toBeGreaterThan(0);
      expect(parsed.evidence.length).toBeGreaterThan(0);
      // New runs carry no manufactured workflow objects: honest empties.
      expect(parsed.mergeResults).toHaveLength(0);
    } finally {
      f.database.close();
    }
  });

  it('emphasizes independent agents in the human log', async () => {
    const f = await simulatedRun();
    try {
      const content = await f.coordinator.exportContent(f.runId, 'log');
      expect(content.filename).toBe('sentry-' + f.runId + '.log');
      const text = Buffer.from(content.contentBase64, 'base64').toString('utf8');
      expect(text).toContain('independent agent results');
      expect(text).toContain('Run status:');
      expect(text).not.toContain('Merge result');
    } finally {
      f.database.close();
    }
  });

  it('historical merger rows keep exporting without crashing', async () => {
    const f = await simulatedRun();
    try {
      const { result } = mergeRun(f.repository, f.runId);
      expect(result.clusterCount).toBeGreaterThan(0);
      const json = await f.coordinator.exportContent(f.runId, 'json');
      const parsed = JSON.parse(Buffer.from(json.contentBase64, 'base64').toString('utf8')) as {
        mergeResults: unknown[];
        findingClusters: unknown[];
      };
      expect(parsed.mergeResults).toHaveLength(1);
      expect(parsed.findingClusters).toHaveLength(result.clusterCount);
      const log = await f.coordinator.exportContent(f.runId, 'log');
      const text = Buffer.from(log.contentBase64, 'base64').toString('utf8');
      expect(text).toContain('independent agent results');
      expect(text).toContain('Merge result');
    } finally {
      f.database.close();
    }
  });
});
