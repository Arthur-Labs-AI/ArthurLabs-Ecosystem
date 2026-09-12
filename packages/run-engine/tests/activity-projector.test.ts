import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { SnapshotEngine } from '@qa/snapshot-engine';
import {
  createAgentRunId,
  createHarnessEventId,
  createQARunId,
  createRunActivityId,
  nowIsoTimestamp,
} from '@qa/shared';
import { RunActivityProjector } from '../src/activity-projector.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RunActivityProjector boundaries', () => {
  it('truncates model-influenced titles instead of breaking persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-projector-'));
    roots.push(root);
    const dataRoot = join(root, 'data');
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    try {
      const source = join(root, 'source');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'README.md'), '# Fixture\n');
      const added = await new ProjectManager(dataRoot, repository).addProject(source);
      const snapshot = await new SnapshotEngine(dataRoot, repository).createSnapshot({
        projectId: added.project.id,
        projectRevisionId: added.revision.id,
        qaRunId: createQARunId(),
        workingCopyPath: join(dataRoot, 'projects', added.project.id, 'working-copy'),
      });
      const projector = new RunActivityProjector(repository);
      const qaRunId = createQARunId();
      const agentRunId = createAgentRunId();
      const parentActivityId = createRunActivityId();
      const context = repository.getContextForRevision(added.revision.id);
      if (context === undefined) throw new Error('missing context');
      repository.saveRun({
        schemaVersion: 1,
        id: qaRunId,
        projectId: added.project.id,
        snapshotId: snapshot.id,
        projectContextSnapshotId: context.id,
        mode: 'full',
        status: 'agents_running',
        configuration: {
          agentStackIds: ['stack_muse_main'],
          verificationLevel: 'strict',
          policy: { id: 'qa-standard', version: 1 },
        },
        createdAt: nowIsoTimestamp(),
        startedAt: nowIsoTimestamp(),
      });
      repository.saveAgentRun({
        schemaVersion: 1,
        id: agentRunId,
        qaRunId,
        agentStackId: 'stack_muse_main',
        taskType: 'qa',
        status: 'running',
        startedAt: nowIsoTimestamp(),
      });
      const longMessage = 'x'.repeat(2000);
      const failed = projector.project(
        {
          schemaVersion: 1,
          eventId: createHarnessEventId(),
          agentRunId,
          timestamp: nowIsoTimestamp(),
          type: 'run.failed',
          failure: { code: 'MUSE_INVALID_RESULT', message: longMessage, retryable: false },
        },
        qaRunId,
        parentActivityId,
      );
      expect(failed.title.length).toBeLessThanOrEqual(300);
      const staged = projector.stage({
        qaRunId,
        parentActivityId,
        source: 'sentry',
        kind: 'runtime',
        title: 'y'.repeat(1000),
      });
      expect(staged.title.length).toBeLessThanOrEqual(300);
    } finally {
      database.close();
    }
  });
});
