import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeLinuxRuntimeClient } from '../../src/main/platform/linux/native-linux-runtime-client.js';
import { StdioRuntimeClient } from '../../src/main/runtime/stdio-runtime-client.js';
import { RuntimeInstanceLease, SentryDatabase, SentryRepository } from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { createFakeHarnessRegistry, RunCoordinator } from '@qa/run-engine';
import type { RuntimeInstance } from '@qa/schemas';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeEntry = join(desktopRoot, '..', 'runtime', 'dist', 'host.js');
const entryExists = existsSync(runtimeEntry);

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Real native runtime process boundary (generic-Linux transport
 * acceptance, NOT a product-support claim): spawns standalone Node on the
 * built runtime entry with piped stdio — no spawn mock, no CachyOS host
 * detection (GitHub CI runs Ubuntu), no providers, no keys, no paid calls.
 * Requires the built runtime (`turbo test` builds first); skipped when the
 * entry is absent so direct vitest runs without a build stay green.
 */
describe.runIf(process.platform === 'linux' && entryExists)('native runtime child process', () => {
  it('reconnects after a real child crash and recovers seeded in-flight state without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-crash-reconnect-'));
    roots.push(root);
    const source = join(root, 'source');
    const dataRoot = join(root, 'data');
    await mkdir(source);
    await writeFile(join(source, 'README.md'), '# Crash fixture\n');
    const database = new SentryDatabase({ dataRoot });
    const repository = new SentryRepository(database);
    const lease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
    lease.start();
    const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
    const added = await projects.addProject(source);
    const runs = new RunCoordinator(
      dataRoot,
      repository,
      lease,
      createFakeHarnessRegistry('success'),
    );
    const interrupted = await runs.run(added.project.id, { executionKind: 'simulation' });
    const completed = await runs.run(added.project.id, { executionKind: 'simulation' });
    lease.release();
    let child: ChildProcess | undefined;
    let launches = 0;
    const client = new StdioRuntimeClient({
      launch: () => {
        launches += 1;
        child = spawn(process.execPath, [runtimeEntry, '--stdio', '--data-root', dataRoot], {
          stdio: 'pipe',
        });
        return child;
      },
    });
    try {
      await client.start();
      const owners = database.connection
        .prepare('SELECT payload FROM runtime_instances')
        .all() as Array<{ payload: string }>;
      const owner = owners
        .map((row) => JSON.parse(row.payload) as RuntimeInstance)
        .find((row) => row.processId === child?.pid)!;
      expect(owner).toBeDefined();
      // Controlled durable crash fixture; the subprocess owns the actual lease.
      repository.saveRun({
        ...interrupted.run,
        status: 'agents_running',
        completedAt: undefined,
        summary: undefined,
        runtimeInstanceId: owner.id,
      });
      const unfinished = interrupted.agentRuns[1]!;
      repository.saveAgentRun({ ...unfinished, status: 'running', completedAt: undefined });
      repository.saveManagedCopy({
        ...repository.getManagedCopy(added.project.id)!,
        state: 'locked_for_run',
        lockedByQARunId: interrupted.run.id,
        runtimeInstanceId: owner.id,
      });
      await client.request('runs.cancel', { runId: interrupted.run.id });
      expect(repository.getRunControlRequest(interrupted.run.id)?.completedAt).toBeUndefined();
      const exited = new Promise<void>((resolve) => client.onExit(() => resolve()));
      child!.kill('SIGKILL');
      await exited;
      await expect(client.request('runs.get', { runId: interrupted.run.id })).rejects.toMatchObject(
        { code: 'RUNTIME_OFFLINE' },
      );
      // Advance durable lease time explicitly rather than sleeping for expiry.
      repository.saveRuntimeInstance({
        ...owner,
        heartbeatAt: '2020-01-01T00:00:00.000Z',
        startedAt: '2020-01-01T00:00:00.000Z',
      });
      await client.start();
      const snapshot = (await client.request('runs.get', { runId: interrupted.run.id })) as {
        run: { status: string };
        agentRuns: Array<{ id: string; status: string }>;
        findings: Array<{ id: string }>;
        evidence: Array<{ id: string }>;
      };
      expect(snapshot.run.status).toBe('partial');
      expect(snapshot.agentRuns.find((agent) => agent.id === unfinished.id)?.status).toBe(
        'interrupted',
      );
      expect(snapshot.findings.map((finding) => finding.id)).toEqual(
        interrupted.findings.map((finding) => finding.id),
      );
      expect(snapshot.evidence.map((evidence) => evidence.id)).toEqual(
        interrupted.evidence.map((evidence) => evidence.id),
      );
      expect(repository.getRun(completed.run.id)).toEqual(completed.run);
      expect(repository.getManagedCopy(added.project.id)?.state).toBe('ready');
      expect(repository.getRunControlRequest(interrupted.run.id)?.completedAt).toBeDefined();
      expect(repository.listRuns(added.project.id)).toHaveLength(2);
      expect(launches).toBe(2);
      await client.stop();
      const freshLease = new RuntimeInstanceLease(repository, { autoHeartbeat: false });
      freshLease.start();
      try {
        const fresh = await new RunCoordinator(
          dataRoot,
          repository,
          freshLease,
          createFakeHarnessRegistry('success'),
        ).run(added.project.id, { executionKind: 'simulation' });
        expect(fresh.run.status).toBe('completed');
      } finally {
        freshLease.release();
      }
    } finally {
      await client.stop();
      database.close();
    }
  }, 120000);

  it('handshakes, serves RPC, and shuts down gracefully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-native-spawn-'));
    roots.push(root);
    const dataRoot = await realpath(root);
    const client = new NativeLinuxRuntimeClient({
      // Acceptable here because this test runs under standalone Node,
      // never Electron. Production resolution never uses execPath.
      nodeExecutable: process.execPath,
      runtimeEntry,
      dataRoot,
    });
    const hello = await client.start();
    try {
      expect(hello.platform).toBe('linux');
      // This transport fixture also runs on WSL. The explicit launcher does
      // not turn its child into a native host or prove CachyOS acceptance.
      expect(hello.isWsl).toBe(
        Boolean(process.env['WSL_DISTRO_NAME'] || process.env['WSL_INTEROP']),
      );
      expect(hello.isElectron).toBe(false);
      expect(hello.processExecPath.toLowerCase()).not.toContain('electron');
      expect(client.status.connected).toBe(true);
      expect(client.status).toMatchObject({
        hostPlatform: 'linux',
        executionMode: 'native-linux',
      });
      const info = (await client.request('system.info', {}, 30000)) as {
        dataRoot: string;
        versions: Record<string, string>;
      };
      expect(await realpath(info.dataRoot)).toBe(dataRoot);
      expect(typeof info.versions).toBe('object');
    } finally {
      await client.stop();
    }
    // stop() resolves only after the child exits (or the bounded kill
    // fallback fires): offline here proves the real process is gone.
    expect(client.status.connected).toBe(false);
    // And the transport restarts cleanly against a fresh child.
    const second = await client.start();
    expect(second.platform).toBe('linux');
    await client.stop();
    expect(client.status.connected).toBe(false);
  }, 120000);
});

describe.runIf(process.platform !== 'linux' || !entryExists)('native runtime child process', () => {
  it('skips outside generic-Linux CI with a built runtime', () => {
    expect(process.platform === 'linux' && entryExists).toBe(false);
  });
});
