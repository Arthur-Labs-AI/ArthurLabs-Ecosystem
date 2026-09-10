import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SentryDatabase,
  SentryRepository,
  agentWorkspacePath,
  projectDataPaths,
  resolveInside,
  scanTree,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { AgentRunSchema, QARunSchema } from '@qa/schemas';
import type { HarnessRunRequest } from '@qa/schemas';
import { createAgentRunId, createQARunId, nowIsoTimestamp } from '@qa/shared';
import { FakeRunCoordinator } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-run-engine-'));
  roots.push(root);
  const source = join(root, 'source project');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Runtime Fixture\n\nA factual runtime fixture.');
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ devDependencies: { vitest: '2' } }),
  );
  await writeFile(join(source, 'src', 'value.txt'), 'A');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const manager = new ProjectManager(dataRoot, repository);
  const added = await manager.addProject(source);
  return { root, source, dataRoot, database, repository, manager, added };
}

describe('fake end-to-end run engine', () => {
  it('persists a successful multi-agent run, exports it, cleans workspaces, and updates revisions', async () => {
    const f = await fixture();
    const originalBefore = await scanTree(f.source);
    const coordinator = new FakeRunCoordinator(f.dataRoot, f.repository);
    const requests: HarnessRunRequest[] = [];
    const result = await coordinator.simulate(f.added.project.id, {
      scenario: 'success',
      instructions: 'Feature X behavior is intentional.',
      onHarnessRequest: (request) => requests.push(request),
    });
    expect(result.run.status).toBe('completed');
    expect(result.agentRuns).toHaveLength(3);
    expect(result.agentRuns.every((agent) => agent.status === 'completed')).toBe(true);
    expect(result.findings).toHaveLength(3);
    expect(result.evidence).toHaveLength(3);
    expect(result.events.length).toBeGreaterThan(20);
    expect(
      result.activities.some(
        (activity) => activity.kind === 'tool' && activity.status === 'completed',
      ),
    ).toBe(true);
    expect(result.exports.map((item) => item.format).sort()).toEqual(['json', 'log']);
    expect(result.run.configuration.instructions?.message).toBe(
      'Feature X behavior is intentional.',
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const serialized = JSON.stringify(request);
      expect(
        requests
          .filter((peer) => peer.agentRunId !== request.agentRunId)
          .every((peer) => !serialized.includes(peer.agentRunId)),
      ).toBe(true);
      expect(serialized).not.toContain('peer');
      expect(request.task.prompt).toContain('Feature X behavior is intentional.');
      expect(request.projectContextSnapshotId).toBe(result.run.projectContextSnapshotId);
    }
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    for (const agent of result.agentRuns) {
      await expect(
        stat(agentWorkspacePath(f.dataRoot, f.added.project.id, result.run.id, agent.id)),
      ).rejects.toThrow();
    }
    const jsonExport = result.exports.find((item) => item.format === 'json');
    expect(jsonExport).toBeDefined();
    if (jsonExport !== undefined) {
      const artifact = f.repository.getArtifact(jsonExport.artifactId);
      expect(artifact).toBeDefined();
      if (artifact !== undefined) {
        const parsed = JSON.parse(
          await readFile(resolveInside(f.dataRoot, artifact.relativeStoragePath), 'utf8'),
        ) as { qaRun: { id: string } };
        expect(parsed.qaRun.id).toBe(result.run.id);
      }
    }
    expect((await scanTree(f.source)).contentHash).toBe(originalBefore.contentHash);

    const oldRevision = f.added.revision.id;
    await writeFile(join(f.source, 'src', 'value.txt'), 'V2');
    const updated = await f.manager.updateProjectCopy(f.added.project.id);
    expect(updated.revision.id).not.toBe(oldRevision);
    expect(f.repository.getSnapshot(result.run.snapshotId)?.projectRevisionId).toBe(oldRevision);
    expect(f.repository.getRun(result.run.id)?.id).toBe(result.run.id);
    expect(
      await readFile(
        join(projectDataPaths(f.dataRoot, f.added.project.id).workingCopy, 'src', 'value.txt'),
        'utf8',
      ),
    ).toBe('V2');
    expect(updated.context?.projectRevisionId).toBe(updated.revision.id);
    await f.manager.deleteProject(f.added.project.id);
    expect(f.repository.getProject(f.added.project.id)).toBeUndefined();
    expect(await readFile(join(f.source, 'src', 'value.txt'), 'utf8')).toBe('V2');
    if (jsonExport !== undefined) {
      expect(f.repository.getArtifact(jsonExport.artifactId)).toBeUndefined();
    }
    f.database.close();
  });

  it('isolates transport loss, keeps pre-crash output durable, and finalizes the run partial', async () => {
    const f = await fixture();
    const coordinator = new FakeRunCoordinator(f.dataRoot, f.repository);
    const result = await coordinator.simulate(f.added.project.id, { scenario: 'partial' });
    expect(result.run.status).toBe('partial');
    expect(result.agentRuns.map((item) => item.status).sort()).toEqual([
      'completed',
      'completed',
      'interrupted',
    ]);
    const interrupted = result.agentRuns.find((item) => item.status === 'interrupted');
    expect(interrupted?.failure?.code).toBe('WORKER_DISCONNECTED');
    expect(result.findings).toHaveLength(3);
    expect(result.evidence).toHaveLength(3);
    expect(result.exports).toHaveLength(2);
    const runId = result.run.id;
    const interruptedId = interrupted?.id;
    f.database.close();

    const reopened = new SentryDatabase({ dataRoot: f.dataRoot });
    const repository = new SentryRepository(reopened);
    expect(repository.getRun(runId)?.status).toBe('partial');
    expect(
      interruptedId === undefined ? [] : repository.listAgentEvents(interruptedId).length,
    ).toBeGreaterThan(1);
    expect(repository.listFindings(runId)).toHaveLength(3);
    reopened.close();
  });

  it('times out one worker without cancelling peers', async () => {
    const f = await fixture();
    const result = await new FakeRunCoordinator(f.dataRoot, f.repository).simulate(
      f.added.project.id,
      {
        scenario: 'timeout',
        runTimeoutMs: 25,
      },
    );
    expect(result.run.status).toBe('partial');
    expect(
      result.agentRuns.some(
        (item) => item.status === 'timed_out' && item.failure?.code === 'RUN_TIMEOUT',
      ),
    ).toBe(true);
    expect(result.agentRuns.filter((item) => item.status === 'completed')).toHaveLength(2);
    f.database.close();
  });

  it('marks an all-fail run failed when no worker produced usable output', async () => {
    const f = await fixture();
    const result = await new FakeRunCoordinator(f.dataRoot, f.repository).simulate(
      f.added.project.id,
      { scenario: 'all-fail' },
    );
    expect(result.run.status).toBe('failed');
    expect(result.agentRuns.every((item) => item.status === 'failed')).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    f.database.close();
  });

  it('recovers nonterminal persisted state and unlocks the managed copy', async () => {
    const f = await fixture();
    const snapshotRun = await new FakeRunCoordinator(f.dataRoot, f.repository).simulate(
      f.added.project.id,
      {
        agentStackIds: ['stack_muse_main'],
      },
    );
    const runId = createQARunId();
    const timestamp = nowIsoTimestamp();
    f.repository.saveRun(
      QARunSchema.parse({
        ...snapshotRun.run,
        id: runId,
        status: 'agents_running',
        createdAt: timestamp,
        startedAt: timestamp,
        completedAt: undefined,
        summary: undefined,
      }),
    );
    const agentRunId = createAgentRunId();
    f.repository.saveAgentRun(
      AgentRunSchema.parse({
        schemaVersion: 1,
        id: agentRunId,
        qaRunId: runId,
        agentStackId: 'stack_muse_main',
        taskType: 'qa',
        status: 'running',
        startedAt: timestamp,
      }),
    );
    f.manager.lockProjectForRun(f.added.project.id, runId);
    await new FakeRunCoordinator(f.dataRoot, f.repository).recover();
    expect(f.repository.getAgentRun(agentRunId)).toMatchObject({
      status: 'interrupted',
      failure: { code: 'APP_INTERRUPTED' },
    });
    expect(f.repository.getRun(runId)?.status).toBe('failed');
    expect(f.manager.getManagedCopy(f.added.project.id).state).toBe('ready');
    f.database.close();
  });
});
