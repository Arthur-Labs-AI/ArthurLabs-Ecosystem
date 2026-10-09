import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeInstanceLease, SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import {
  createFakeHarnessRegistry,
  ingestMergeIssues,
  mergeRun,
  retestIssue,
  RunCoordinator,
  type RunOptions,
} from '@qa/run-engine';
import { createQARunId, createRetestRunId } from '@qa/shared';
import { RetestRunSchema, type RetestRun } from '@qa/schemas';
import { SentryRuntimeHost } from '../src/runtime.js';

vi.mock('@qa/run-engine', async (original) => {
  const actual = await original<typeof import('@qa/run-engine')>();
  return { ...actual, retestIssue: vi.fn(actual.retestIssue) };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-start-identity-'));
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(source);
  await writeFile(join(source, 'README.md'), '# Identity fixture\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await projects.addProject(source);
  const coordinator = new RunCoordinator(
    dataRoot,
    repository,
    lease,
    createFakeHarnessRegistry('success'),
  );
  const saved = await coordinator.run(added.project.id, { executionKind: 'simulation' });
  const { result: merge } = mergeRun(repository, saved.run.id);
  const issueId = ingestMergeIssues(repository, merge.id).issues[0]!.issueId;
  const notify = vi.fn();
  const host = new SentryRuntimeHost(dataRoot, notify);
  cleanups.push(async () => {
    host.close();
    lease.release();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { host, repository, saved, issueId, merge, lease, projects, source, coordinator, notify };
}

it('preserves a real project-lock rejection when the accepted run persists before detection wakes', async () => {
  const f = await fixture();
  const original = RunCoordinator.prototype.run;
  const frozen = deferred<void>();
  const release = deferred<void>();
  const workflows: Array<ReturnType<RunCoordinator['run']>> = [];
  vi.spyOn(RunCoordinator.prototype, 'run').mockImplementation((id, options) => {
    const workflow = original.call(f.coordinator, id, {
      ...options,
      onSnapshotFrozen: async () => {
        frozen.resolve();
        await release.promise;
      },
    });
    workflows.push(workflow);
    return workflow;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const accepted = f.host.startRun(f.saved.run.projectId, { mode: 'full' });
  const refused = f.host.startRun(f.saved.run.projectId, { mode: 'full' });
  const refusal = refused.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await frozen.promise;
    await vi.advanceTimersByTimeAsync(100);
    const response = await accepted;
    expect(response.runId).not.toBe(f.saved.run.id);
    expect(f.repository.getRun(response.runId as never)?.status).toBe('agents_running');
    expect(await refusal).toMatchObject({ error: { code: 'ACTIVE_RUN_EXISTS' } });
    expect(f.repository.listRuns(f.saved.run.projectId)).toHaveLength(2);
  } finally {
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.allSettled([...workflows, accepted, refused]);
  }
});

it.each(['run', 'retest'] as const)('never returns an unpersisted %s identity', async (kind) => {
  const f = await fixture();
  const workflow = deferred<never>();
  if (kind === 'run') {
    vi.spyOn(RunCoordinator.prototype, 'run').mockImplementation((_id, options) => {
      options.onRunCreated?.({ ...f.saved.run, id: createQARunId() });
      return workflow.promise;
    });
  } else {
    vi.mocked(retestIssue).mockImplementationOnce((_deps, _id, options) => {
      options?.onRetestCreated?.({ id: createRetestRunId() } as RetestRun);
      return workflow.promise;
    });
  }
  try {
    const starting =
      kind === 'run'
        ? f.host.startRun(f.saved.run.projectId, { mode: 'full' })
        : f.host.startRetest(f.issueId, {});
    await expect(starting).rejects.toMatchObject({
      code: kind === 'run' ? 'RUN_NOT_FOUND' : 'RETEST_NOT_FOUND',
    });
    expect(f.notify).not.toHaveBeenCalledWith(
      kind === 'run' ? 'run.created' : 'retest.created',
      expect.anything(),
    );
  } finally {
    workflow.reject(new Error('fixture workflow cleanup'));
    await workflow.promise.catch(() => undefined);
  }
});

it('returns a synchronously persisted request identity before workflow settlement', async () => {
  const f = await fixture();
  const row = { ...f.saved.run, id: createQARunId() };
  const workflow = deferred<typeof f.saved>();
  vi.spyOn(RunCoordinator.prototype, 'run').mockImplementation((_id, options) => {
    f.repository.saveRun(row);
    options.onRunCreated?.(row);
    return workflow.promise;
  });
  vi.useFakeTimers();
  let response: unknown;
  const starting = f.host.startRun(row.projectId, { mode: 'full' }).then((value) => {
    response = value;
    return value;
  });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(response).toMatchObject({ runId: row.id, status: row.status });
    expect(f.repository.getRun(row.id)).toEqual(row);
    await expect(f.host.dispatch('runtime.shutdown', {})).rejects.toMatchObject({
      code: 'RUNTIME_BUSY',
    });
  } finally {
    workflow.resolve({ ...f.saved, run: row });
    await vi.advanceTimersByTimeAsync(100);
    await starting;
  }
});

it('never associates a conflicting request with the accepted request row', async () => {
  const f = await fixture();
  const row = { ...f.saved.run, id: createQARunId() };
  const accepted = deferred<typeof f.saved>();
  const refused = deferred<typeof f.saved>();
  let created: RunOptions['onRunCreated'];
  vi.spyOn(RunCoordinator.prototype, 'run')
    .mockImplementationOnce((_id, options) => {
      created = options.onRunCreated;
      return accepted.promise;
    })
    .mockImplementationOnce(() => refused.promise);
  vi.useFakeTimers();
  const first = f.host.startRun(row.projectId, { mode: 'full' });
  const second = f.host.startRun(row.projectId, { mode: 'full' });
  const secondOutcome = second.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  f.repository.saveRun(row);
  created?.(row);
  const conflict = Object.assign(new Error('project already locked'), { code: 'PROJECT_LOCKED' });
  refused.reject(conflict);
  try {
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toMatchObject({ runId: row.id });
    await expect(secondOutcome).resolves.toEqual({ error: conflict });
  } finally {
    accepted.resolve({ ...f.saved, run: row });
    await Promise.allSettled([first, second]);
  }
});

it('returns a fast persisted retest row without waiting for the retest to finish', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'README.md'), '# Updated identity fixture\n');
  const target = await f.projects.updateProjectCopy(f.saved.run.projectId);
  const row = RetestRunSchema.parse({
    schemaVersion: 1,
    id: createRetestRunId(),
    retestVersion: 1,
    projectId: f.saved.run.projectId,
    issueId: f.issueId,
    sourceProjectRevisionId: f.repository.getSnapshot(f.saved.run.snapshotId)!.projectRevisionId,
    targetProjectRevisionId: target.revision.id,
    sourceSnapshotId: f.saved.run.snapshotId,
    sourceQaRunId: f.saved.run.id,
    sourceMergeResultId: f.merge.id,
    sourceFindingClusterId: f.merge.clusters[0]!.id,
    agentStackIds: ['stack_deepseek_main'],
    status: 'created',
    runtimeInstanceId: f.lease.instanceId,
    createdAt: f.saved.run.createdAt,
  });
  const workflow = deferred<Awaited<ReturnType<typeof retestIssue>>>();
  vi.mocked(retestIssue).mockImplementationOnce((_deps, _id, options) => {
    f.repository.saveRetestRun(row);
    options?.onRetestCreated?.(row);
    return workflow.promise;
  });
  vi.useFakeTimers();
  let response: unknown;
  const starting = f.host.startRetest(f.issueId, {}).then((value) => {
    response = value;
    return value;
  });
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect(response).toMatchObject({ retestRunId: row.id });
    expect(f.repository.getRetestRun(row.id)).toEqual(row);
  } finally {
    workflow.resolve({
      retestRun: row,
      assessment: undefined,
      spec: undefined,
      targetRun: undefined,
    });
    await vi.advanceTimersByTimeAsync(50);
    await starting;
  }
});

it('keeps concurrent real retest request identities distinct before child settlement', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'README.md'), '# Retest identity revision B\n');
  await f.projects.updateProjectCopy(f.saved.run.projectId);
  const actual = await vi.importActual<typeof import('@qa/run-engine')>('@qa/run-engine');
  const originalIntegrity = ProjectManager.prototype.assertWorkingCopyIntegrity;
  const barrier = deferred<void>();
  let checks = 0;
  vi.spyOn(ProjectManager.prototype, 'assertWorkingCopyIntegrity').mockImplementation(
    async function (id) {
      const revision = await originalIntegrity.call(this, id);
      checks += 1;
      if (checks === 2) barrier.resolve();
      await barrier.promise;
      return revision;
    },
  );
  const release = deferred<void>();
  const bothCreated = deferred<void>();
  const rows: RetestRun[] = [];
  const workflows: Array<ReturnType<typeof retestIssue>> = [];
  vi.mocked(retestIssue).mockImplementation((deps, id, options) => {
    const workflow = actual.retestIssue(
      { ...deps, registry: createFakeHarnessRegistry('success') },
      id,
      {
        ...options,
        onRetestCreated: (row) => {
          rows.push(row);
          options?.onRetestCreated?.(row);
          if (rows.length === 2) bothCreated.resolve();
        },
        onChildSnapshotFrozen: async () => {
          await release.promise;
        },
      },
    );
    workflows.push(workflow);
    return workflow;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const first = f.host.startRetest(f.issueId, {});
  const second = f.host.startRetest(f.issueId, {});
  try {
    await bothCreated.promise;
    await vi.advanceTimersByTimeAsync(50);
    const responses = await Promise.all([first, second]);
    expect(new Set(responses.map((response) => response.retestRunId))).toEqual(
      new Set(rows.map((row) => row.id)),
    );
    expect(new Set(responses.map((response) => response.operationId)).size).toBe(2);
  } finally {
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.allSettled([...workflows, first, second]);
  }
}, 15000);
