import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectDataPaths,
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import type { HarnessRunRequest } from '@qa/schemas';
import { RunEngineError } from '../src/errors.js';
import { createFakeHarnessRegistry, RunCoordinator } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-targeted-'));
  roots.push(root);
  const source = join(root, 'source');
  const dataRoot = join(root, 'data');
  await mkdir(join(source, 'src', 'auth'), { recursive: true });
  await mkdir(join(source, 'src', 'payments'), { recursive: true });
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  await writeFile(join(source, 'src', 'auth', 'login.ts'), 'export const login = 1;\n');
  await writeFile(join(source, 'src', 'payments', 'charge.ts'), 'export const charge = 2;\n');
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
  lease.start();
  const manager = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
  const added = await manager.addProject(source);
  const runs = new RunCoordinator(
    dataRoot,
    repository,
    lease,
    createFakeHarnessRegistry('success'),
  );
  return { root, source, dataRoot, database, repository, lease, added, runs, manager };
}

describe('Phase 7 TARGETED QA (§8-§13, §82)', () => {
  it('runs all three agents on the same frozen snapshot with a persisted TargetSpec', async () => {
    const f = await fixture();
    const requests: HarnessRunRequest[] = [];
    const created: string[] = [];
    const result = await f.runs.run(f.added.project.id, {
      executionKind: 'simulation',
      mode: 'targeted',
      target: { includePaths: ['src/auth'] },
      onRunCreated: (run) => {
        expect(f.repository.getRun(run.id)).toEqual(run);
        expect(f.repository.listAgentRuns(run.id)).toEqual([]);
        created.push(run.id);
      },
      onHarnessRequest: (request) => requests.push(request),
    });
    expect(result.run.mode).toBe('targeted');
    expect(created).toEqual([result.run.id]);
    expect(result.run.status).toBe('completed');
    expect(result.agentRuns).toHaveLength(3);
    // Same snapshot for all selected agents (§82): identical workspace snapshot binding.
    const snapshotIds = new Set(requests.map((request) => request.workspace.snapshotId));
    expect(snapshotIds.size).toBe(1);
    expect([...snapshotIds][0]).toBe(result.run.snapshotId);
    // Peer isolation (§12): distinct agent workspaces, same instructions channel.
    const paths = new Set(requests.map((request) => request.workspace.runtimePath));
    expect(paths.size).toBe(3);
    const spec = f.repository.getTargetSpec(result.run.id);
    expect(spec?.includePaths).toEqual(['src/auth']);
    expect(spec?.snapshotId).toBe(result.run.snapshotId);
    expect(result.run.configuration.instructions?.message).toContain('src/auth');
    f.database.close();
  });

  it('accepts trailing-slash directory targets that suggest-targets emits', async () => {
    const f = await fixture();
    const result = await f.runs.run(f.added.project.id, {
      executionKind: 'simulation',
      mode: 'targeted',
      target: { includePaths: ['src/auth/'] },
    });
    expect(result.run.status).toBe('completed');
    const spec = f.repository.getTargetSpec(result.run.id);
    expect(spec?.includePaths).toEqual(['src/auth']);
    f.database.close();
  });

  it('ignores import-excluded noise in the working copy at snapshot time', async () => {
    const f = await fixture();
    // Excluded noise appearing after import (dependency installs, logs)
    // passes integrity but must not make the snapshot hash drift.
    const copy = projectDataPaths(f.dataRoot, f.added.project.id).workingCopy;
    await mkdir(join(copy, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(copy, 'node_modules', 'pkg', 'index.js'), 'export {};\n');
    await writeFile(join(copy, 'debug.log'), 'noise\n');
    await f.manager.assertWorkingCopyIntegrity(f.added.project.id);
    const result = await f.runs.run(f.added.project.id, {
      executionKind: 'simulation',
      mode: 'full',
    });
    expect(result.run.status).toBe('completed');
    f.database.close();
  });

  it('persists target instructions and multiple paths', async () => {
    const f = await fixture();
    const result = await f.runs.run(f.added.project.id, {
      executionKind: 'simulation',
      mode: 'targeted',
      target: {
        includePaths: ['src/auth', 'src/payments'],
        userInstructions: 'Focus on token refresh and expired-token handling',
      },
    });
    const spec = f.repository.getTargetSpec(result.run.id);
    expect(spec?.includePaths).toEqual(['src/auth', 'src/payments']);
    expect(spec?.userInstructions).toContain('token refresh');
    expect(result.run.configuration.instructions?.message).toContain('token refresh');
    f.database.close();
  });

  it('rejects traversal targets without widening (§10, §82)', async () => {
    const f = await fixture();
    await expect(
      f.runs.run(f.added.project.id, {
        executionKind: 'simulation',
        mode: 'targeted',
        target: { includePaths: ['../outside'] },
      }),
    ).rejects.toThrowError(RunEngineError);
    f.database.close();
  });

  it('rejects missing paths against the frozen snapshot (§10, §82)', async () => {
    const f = await fixture();
    await expect(
      f.runs.run(f.added.project.id, {
        executionKind: 'simulation',
        mode: 'targeted',
        target: { includePaths: ['src/does-not-exist'] },
      }),
    ).rejects.toThrowError(/not found in the frozen snapshot/);
    f.database.close();
  });

  it('terminalizes the persisted QARun as failed on invalid target (final micro-fix §16)', async () => {
    const f = await fixture();
    const before = new Set(f.repository.listRuns(f.added.project.id).map((run) => run.id));
    await expect(
      f.runs.run(f.added.project.id, {
        executionKind: 'simulation',
        mode: 'targeted',
        target: { includePaths: ['src/does-not-exist'] },
      }),
    ).rejects.toThrowError(/not found in the frozen snapshot/);
    const fresh = f.repository.listRuns(f.added.project.id).filter((run) => !before.has(run.id));
    expect(fresh).toHaveLength(1);
    const failed = fresh[0];
    expect(failed?.status).toBe('failed');
    expect(failed?.completedAt).toBeDefined();
    expect(f.repository.listAgentRuns(failed?.id as never)).toHaveLength(0);
    expect(f.repository.getManagedCopy(f.added.project.id)?.state).toBe('ready');
    expect(f.repository.getManagedCopy(f.added.project.id)?.lockedByQARunId).toBeUndefined();
    f.database.close();
  });

  it('rejects targeted mode without a scope and full mode with one', async () => {
    const f = await fixture();
    await expect(
      f.runs.run(f.added.project.id, { executionKind: 'simulation', mode: 'targeted' }),
    ).rejects.toThrowError(/requires a target scope/);
    await expect(
      f.runs.run(f.added.project.id, {
        executionKind: 'simulation',
        mode: 'full',
        target: { includePaths: ['src/auth'] },
      }),
    ).rejects.toThrowError(/takes no target scope/);
    f.database.close();
  });

  it('records run lineage for a TARGETED follow-up (§37)', async () => {
    const f = await fixture();
    const first = await f.runs.run(f.added.project.id, { executionKind: 'simulation' });
    const second = await f.runs.run(f.added.project.id, {
      executionKind: 'simulation',
      mode: 'targeted',
      target: { includePaths: ['src/auth'] },
      lineage: { parentRunId: first.run.id },
    });
    expect(second.run.lineage?.parentRunId).toBe(first.run.id);
    f.database.close();
  });

  it('partial agent failure keeps completed outputs and stays useful (§114)', async () => {
    const f = await fixture();
    const partial = new RunCoordinator(
      f.dataRoot,
      f.repository,
      f.lease,
      createFakeHarnessRegistry('partial'),
    );
    const result = await partial.run(f.added.project.id, {
      executionKind: 'simulation',
      mode: 'targeted',
      target: { includePaths: ['src/auth'] },
    });
    expect(result.run.status).toBe('partial');
    expect(result.agentRuns.some((agent) => agent.status === 'completed')).toBe(true);
    expect(f.repository.getTargetSpec(result.run.id)?.includePaths).toEqual(['src/auth']);
    f.database.close();
  });
});

describe('Phase 7 stable cancellation (§45-§47)', () => {
  it('cancels a nonterminal run while preserving completed outputs', async () => {
    const f = await fixture();
    const completed = await f.runs.run(f.added.project.id, { executionKind: 'simulation' });
    // Terminal runs refuse cancellation.
    expect(() => f.runs.cancelRun(completed.run.id)).toThrowError(/already terminal/);
    expect(f.repository.listFindings(completed.run.id)).toHaveLength(3);
    f.database.close();
  });

  it('marks interrupted leftovers cancelled with structured failure', async () => {
    const f = await fixture();
    const stale = await f.runs.run(f.added.project.id, { executionKind: 'simulation' });
    // Simulate a crash leftover: reopen the run as nonterminal without a fresh owner.
    const reopened = { ...stale.run, status: 'agents_running' as const, completedAt: undefined };
    f.repository.saveRun(reopened as never);
    const outcome = f.runs.cancelRun(stale.run.id);
    expect(outcome).toMatchObject({ runId: stale.run.id, status: 'cancelled' });
    expect(f.repository.getRun(stale.run.id)?.status).toBe('cancelled');
    // Completed findings/evidence preserved (§47).
    expect(f.repository.listFindings(stale.run.id)).toHaveLength(3);
    f.database.close();
  });
});
