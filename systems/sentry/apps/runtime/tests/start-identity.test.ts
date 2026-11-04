import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeInstanceLease, SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { FakeHarnessAdapter, HarnessAdapterRegistry } from '@qa/harness-protocol';
import { createFakeHarnessRegistry, RunCoordinator, type RunOptions } from '@qa/run-engine';
import { createQARunId } from '@qa/shared';
import { SentryRuntimeHost } from '../src/runtime.js';

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
  const notify = vi.fn();
  const host = new SentryRuntimeHost(dataRoot, notify);
  cleanups.push(async () => {
    host.close();
    lease.release();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { host, repository, saved, lease, projects, source, coordinator, notify, dataRoot };
}

it('preserves a real project-lock rejection when the accepted run persists before detection wakes', async () => {
  const f = await fixture();
  const original = RunCoordinator.prototype.run;
  const started = deferred<void>();
  const release = deferred<void>();
  const workflows: Array<ReturnType<RunCoordinator['run']>> = [];
  // Hold the accepted run open inside its agents so the project stays locked.
  class GatedAdapter extends FakeHarnessAdapter {
    override async *run(request: Parameters<FakeHarnessAdapter['run']>[0]) {
      started.resolve();
      await release.promise;
      yield* super.run(request);
    }
  }
  const gated = new HarnessAdapterRegistry();
  for (const stack of INITIAL_AGENT_STACKS) {
    gated.register({
      stack,
      runtimeIdentity: {
        modelId: stack.model.modelId,
        adapterId: 'gated',
        adapterVersion: '0.1.0',
      },
      createAdapter: () => new GatedAdapter(),
    });
  }
  const gatedCoordinator = new RunCoordinator(f.dataRoot, f.repository, f.lease, gated);
  vi.spyOn(RunCoordinator.prototype, 'run').mockImplementation((id, options) => {
    const workflow = original.call(gatedCoordinator, id, options);
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
    await started.promise;
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

it('never returns an unpersisted run identity', async () => {
  const f = await fixture();
  const workflow = deferred<never>();
  vi.spyOn(RunCoordinator.prototype, 'run').mockImplementation((_id, options) => {
    options.onRunCreated?.({ ...f.saved.run, id: createQARunId() });
    return workflow.promise;
  });
  try {
    await expect(f.host.startRun(f.saved.run.projectId, { mode: 'full' })).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
    expect(f.notify).not.toHaveBeenCalledWith('run.created', expect.anything());
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
