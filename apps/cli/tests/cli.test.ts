import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQARunId, nowIsoTimestamp } from '@qa/shared';
import {
  CliEnvelopeSchema,
  CliSuccessEnvelopeSchema,
  QARunSchema,
  type CliEnvelope,
} from '@qa/schemas';
import { ProjectManager } from '@qa/project-manager';
import {
  RuntimeInstanceLease,
  RuntimePersistenceError,
  SentryDatabase,
  SentryRepository,
} from '@qa/persistence';
import { errorEnvelope, errorExitCode } from '../src/errors.js';
import { summarizeRunStartAgents } from '../src/application.js';
import { doctorLines, runCli, versionLine } from '../src/index.js';
import { successExitCode } from '../src/output.js';

const roots: string[] = [];
const entry = resolve(__dirname, '..', 'dist', 'index.js');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

function invoke(args: readonly string[], dataRoot: string) {
  return spawnSync(process.execPath, ['--no-warnings', entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SENTRY_DATA_ROOT: dataRoot },
  });
}

function machine(result: ReturnType<typeof invoke>, expectedCommand: string): CliEnvelope {
  expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  expect(result.stderr).toBe('');
  const parsed: unknown = JSON.parse(result.stdout);
  const response = CliEnvelopeSchema.parse(parsed);
  expect(response.schemaVersion).toBe(1);
  expect(response.command).toBe(expectedCommand);
  return response;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentry-cli-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  return { root, dataRoot, source };
}

describe('qa cli', () => {
  it('reports the exact per-agent outcome for a partial production run', () => {
    const agents = summarizeRunStartAgents([
      { agentStackId: 'stack_muse_main', status: 'completed' },
      {
        agentStackId: 'stack_deepseek_main',
        status: 'failed',
        failure: {
          code: 'DEEPSEEK_START_FAILED',
          message: 'initialize timed out; DEEPSEEK_API_KEY=must-not-leak',
          retryable: true,
        },
      },
      { agentStackId: 'stack_glm_main', status: 'completed' },
    ]);

    expect(agents).toMatchObject({
      configured: 3,
      completed: 2,
      failed: 1,
      timedOut: 0,
      interrupted: 0,
      cancelled: 0,
      runs: [
        { agentStackId: 'stack_muse_main', status: 'completed' },
        {
          agentStackId: 'stack_deepseek_main',
          status: 'failed',
          failure: { code: 'DEEPSEEK_START_FAILED', retryable: true },
        },
        { agentStackId: 'stack_glm_main', status: 'completed' },
      ],
    });
    expect(JSON.stringify(agents)).not.toContain('must-not-leak');

    const response = CliSuccessEnvelopeSchema.parse({
      schemaVersion: 1,
      command: 'run.start',
      ok: true,
      data: {
        simulated: false,
        runId: 'run_01K7777777777777777777A8W3',
        projectId: 'proj_01K7777777777777777777A8W1',
        status: 'partial',
        agents,
        findings: { total: 0 },
      },
    });
    expect(response).toMatchObject({
      schemaVersion: 1,
      command: 'run.start',
      ok: true,
      data: { status: 'partial', agents: { configured: 3, completed: 2, failed: 1 } },
    });
  });

  it('does not hide timed-out, interrupted, or cancelled agents in failed', () => {
    const agents = summarizeRunStartAgents([
      {
        agentStackId: 'stack_deepseek_main',
        status: 'timed_out',
        failure: { code: 'AGENT_TIMEOUT', message: 'Timed out.', retryable: true },
      },
      {
        agentStackId: 'stack_glm_main',
        status: 'interrupted',
        failure: { code: 'WORKER_DISCONNECTED', message: 'Interrupted.', retryable: true },
      },
      { agentStackId: 'stack_muse_main', status: 'cancelled' },
    ]);
    expect(agents).toMatchObject({
      configured: 3,
      completed: 0,
      failed: 0,
      timedOut: 1,
      interrupted: 1,
      cancelled: 1,
    });
  });

  it('--version prints qa version', () => {
    expect(versionLine()).toMatch(/^qa \d+\.\d+\.\d+$/);
  });

  it('doctor reports runtime foundation OK and points to Muse diagnostics', () => {
    const lines = doctorLines();
    expect(lines[0]).toBe('Sentry');
    expect(lines.join('\n')).toContain('Domain       OK');
    expect(lines.join('\n')).not.toContain('ERROR');
    expect(lines.join('\n')).toContain('qa agent doctor muse');
    expect(lines.join('\n')).toContain('SQLite       OK');
  });

  it('keeps human help and uses invalid-argument exit semantics', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runCli(['node', 'qa', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: qa'));
    expect(runCli(['node', 'qa', 'unknown'])).toBe(2);
    expect(error).toHaveBeenCalledWith('INVALID_ARGUMENT: Unknown command: unknown');
    log.mockRestore();
    error.mockRestore();
  });

  it('lists Muse, reports deterministic doctor failures, and types missing model configuration', async () => {
    const f = await fixture();
    const listed = invoke(['agent', 'list', '--json'], f.dataRoot);
    expect(listed.status).toBe(0);
    const listResponse = machine(listed, 'agent.list');
    expect(listResponse.ok && listResponse.data).toMatchObject({
      agents: [
        {
          id: 'muse',
          harness: 'muse-code',
          modelEnvironmentVariable: 'SENTRY_MUSE_MODEL',
        },
        {
          id: 'deepseek',
          harness: 'deepseek-harness',
          modelEnvironmentVariable: 'SENTRY_DEEPSEEK_MODEL',
        },
        { id: 'glm', harness: 'claude-code', modelEnvironmentVariable: 'SENTRY_GLM_MODEL' },
      ],
    });

    const doctor = spawnSync(
      process.execPath,
      ['--no-warnings', entry, 'agent', 'doctor', 'muse', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SENTRY_DATA_ROOT: f.dataRoot,
          SENTRY_MUSE_BINARY: join(f.root, 'missing-muse'),
          SENTRY_MUSE_MODEL: 'muse-spark-1.3-contributor',
        },
      },
    );
    expect(doctor.status).toBe(0);
    const doctorResponse = machine(doctor, 'agent.doctor');
    expect(doctorResponse.ok && doctorResponse.data).toMatchObject({
      agent: 'muse',
      status: 'unavailable',
      sdkVersion: '0.1.1',
      readiness: 'unavailable',
      runtimeVerified: false,
    });

    for (const [agent, binaryVariable, sdkVersion] of [
      ['deepseek', 'SENTRY_DEEPSEEK_BINARY', '0.1.5-rc.2'],
      ['glm', 'SENTRY_CLAUDE_BINARY', '2.1.270'],
    ] as const) {
      const stackDoctor = spawnSync(
        process.execPath,
        ['--no-warnings', entry, 'agent', 'doctor', agent, '--json'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            SENTRY_DATA_ROOT: f.dataRoot,
            [binaryVariable]: join(f.root, 'missing-' + agent),
          },
        },
      );
      expect(stackDoctor.status).toBe(0);
      const stackResponse = machine(stackDoctor, 'agent.doctor');
      expect(stackResponse.ok && stackResponse.data).toMatchObject({
        agent,
        status: 'unavailable',
        sdkVersion,
        runtimeVerified: false,
      });
    }

    // Register a real project first so project resolution succeeds and the
    // run reaches selected-agent preflight, where the emptied Muse model
    // must produce the typed config error (not PROJECT_NOT_FOUND).
    const added = spawnSync(
      process.execPath,
      ['--no-warnings', entry, 'project', 'add', f.source, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, SENTRY_DATA_ROOT: f.dataRoot },
      },
    );
    expect(added.status).toBe(0);
    const addedResponse = machine(added, 'project.add');
    if (!addedResponse.ok) throw new Error('Fixture project registration failed');
    const projectId = (addedResponse.data as { projectId: string }).projectId;
    expect(typeof projectId).toBe('string');

    const start = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        entry,
        'run',
        'start',
        projectId,
        '--mode',
        'full',
        '--agents',
        'muse',
        '--wait',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, SENTRY_DATA_ROOT: f.dataRoot, SENTRY_MUSE_MODEL: '' },
      },
    );
    expect(start.status).toBe(6);
    const startResponse = machine(start, 'run.start');
    expect(!startResponse.ok && startResponse.error.code).toBe('MUSE_MODEL_NOT_CONFIGURED');
  });

  it('supports the complete subprocess JSON lifecycle with one document per command', async () => {
    const f = await fixture();
    const capabilities = invoke(['capabilities', '--json'], f.dataRoot);
    expect(capabilities.status).toBe(0);
    const capabilityResponse = machine(capabilities, 'capabilities');
    expect(capabilityResponse.ok && capabilityResponse.data).toMatchObject({
      cliContractVersion: 1,
      features: { realAgentExecution: true, fakeRunSimulation: true },
    });

    const add = invoke(['project', 'add', f.source, '--json'], f.dataRoot);
    expect(add.status).toBe(0);
    const added = machine(add, 'project.add');
    expect(added.ok).toBe(true);
    if (!added.ok || added.command !== 'project.add') throw new Error('Unexpected response');
    const projectId = added.data.projectId;

    const list = invoke(['project', 'list', '--json'], f.dataRoot);
    expect(list.status).toBe(0);
    const listed = machine(list, 'project.list');
    expect(listed.ok && listed.command === 'project.list' && listed.data.projects).toHaveLength(1);

    const show = invoke(['project', 'show', projectId, '--json'], f.dataRoot);
    expect(show.status).toBe(0);
    const shown = machine(show, 'project.show');
    expect(shown.ok && shown.command === 'project.show' && shown.data.project.id).toBe(projectId);

    await writeFile(join(f.source, 'index.ts'), 'export const value = 1;\n');
    const update = invoke(['project', 'update', projectId, '--json'], f.dataRoot);
    expect(update.status).toBe(0);
    const updated = machine(update, 'project.update');
    expect(updated.ok && updated.command === 'project.update' && updated.data.revisionId).not.toBe(
      added.data.revisionId,
    );

    const simulate = invoke(
      ['run', 'simulate', projectId, '--scenario', 'success', '--json'],
      f.dataRoot,
    );
    expect(simulate.status).toBe(5);
    const simulated = machine(simulate, 'run.simulate');
    expect(simulated.ok).toBe(true);
    if (!simulated.ok || simulated.command !== 'run.simulate')
      throw new Error('Unexpected response');
    expect(simulated.data.simulated).toBe(true);
    const runId = simulated.data.runId;

    const runList = invoke(['run', 'list', projectId, '--json'], f.dataRoot);
    expect(runList.status).toBe(0);
    const runs = machine(runList, 'run.list');
    expect(runs.ok && runs.command === 'run.list' && runs.data.runs[0]?.runId).toBe(runId);

    const runShow = invoke(['run', 'show', runId, '--json'], f.dataRoot);
    expect(runShow.status).toBe(0);
    const details = machine(runShow, 'run.show');
    expect(
      details.ok && details.command === 'run.show' && details.data.counts.events,
    ).toBeGreaterThan(0);

    const status = invoke(['run', 'status', runId, '--json'], f.dataRoot);
    expect(status.status).toBe(0);
    const statusResponse = machine(status, 'run.status');
    expect(
      statusResponse.ok && statusResponse.command === 'run.status' && statusResponse.data.tokens,
    ).toMatchObject({
      inputTokens: 303,
      outputTokens: 120,
      cachedInputTokens: 30,
      totalTokens: 423,
      turns: 6,
    });

    const exported = invoke(['run', 'export', runId, '--format', 'json', '--json'], f.dataRoot);
    expect(exported.status).toBe(0);
    const exportResponse = machine(exported, 'run.export');
    if (!exportResponse.ok || exportResponse.command !== 'run.export') {
      throw new Error('Unexpected response');
    }
    expect(JSON.parse(await readFile(exportResponse.data.path, 'utf8'))).toMatchObject({
      qaRun: { id: runId },
    });

    const deleted = invoke(['project', 'delete', projectId, '--yes', '--json'], f.dataRoot);
    expect(deleted.status).toBe(0);
    const deleteResponse = machine(deleted, 'project.delete');
    expect(deleteResponse.ok && deleteResponse.data).toMatchObject({ projectId, deleted: true });
    // Test-only budget: this integration test launches many sequential Node
    // subprocesses, which is slow on virtualized/9P storage. Production
    // timeouts are unchanged and assertions are not weakened.
  }, 60_000);

  it('merges a simulated run deterministically with stable exit semantics', async () => {
    const f = await fixture();
    const add = invoke(['project', 'add', f.source, '--json'], f.dataRoot);
    expect(add.status).toBe(0);
    const added = machine(add, 'project.add');
    if (!added.ok || added.command !== 'project.add') throw new Error('Unexpected response');
    const simulate = invoke(
      ['run', 'simulate', added.data.projectId, '--scenario', 'success', '--json'],
      f.dataRoot,
    );
    expect(simulate.status).toBe(5);
    const simulated = machine(simulate, 'run.simulate');
    if (!simulated.ok || simulated.command !== 'run.simulate')
      throw new Error('Unexpected response');
    const runId = simulated.data.runId;
    const merged = invoke(['run', 'merge', runId, '--json'], f.dataRoot);
    expect(merged.status).toBe(0);
    const mergeResponse = machine(merged, 'run.merge');
    if (!mergeResponse.ok || mergeResponse.command !== 'run.merge') {
      throw new Error('Unexpected response');
    }
    expect(mergeResponse.data).toMatchObject({
      runId,
      reused: false,
      sourceFindings: 3,
      usableAgents: 3,
    });
    expect(mergeResponse.data.clusters).toBeGreaterThan(0);
    expect(mergeResponse.data.mergeResultId).toMatch(/^merge_/);
    // Idempotent: second merge reuses the persisted result.
    const remerged = invoke(['run', 'merge', runId, '--json'], f.dataRoot);
    expect(remerged.status).toBe(0);
    const remergeResponse = machine(remerged, 'run.merge');
    if (!remergeResponse.ok || remergeResponse.command !== 'run.merge') {
      throw new Error('Unexpected response');
    }
    expect(remergeResponse.data).toMatchObject({
      runId,
      reused: true,
      mergeResultId: mergeResponse.data.mergeResultId,
    });
    // Unknown run maps to the established not-found exit category.
    const missing = invoke(
      ['run', 'merge', 'run_01K7777777777777777777A8W9', '--json'],
      f.dataRoot,
    );
    expect(missing.status).toBe(3);
    const missingResponse = machine(missing, 'run.merge');
    expect(!missingResponse.ok && missingResponse.error.code).toBe('RUN_NOT_FOUND');
  }, 60_000);

  it('returns typed machine errors and stable exit categories', async () => {
    const f = await fixture();
    const invalid = invoke(['project', 'add', '--json'], f.dataRoot);
    expect(invalid.status).toBe(2);
    const invalidResponse = machine(invalid, 'project.add');
    expect(!invalidResponse.ok && invalidResponse.error.code).toBe('INVALID_ARGUMENT');

    const missingProject = invoke(
      ['project', 'show', 'proj_01K7777777777777777777A8W1', '--json'],
      f.dataRoot,
    );
    expect(missingProject.status).toBe(3);
    const missingProjectResponse = machine(missingProject, 'project.show');
    expect(!missingProjectResponse.ok && missingProjectResponse.error.code).toBe(
      'PROJECT_NOT_FOUND',
    );

    const missingRun = invoke(
      ['run', 'status', 'run_01K7777777777777777777A8W3', '--json'],
      f.dataRoot,
    );
    expect(missingRun.status).toBe(3);
    const missingRunResponse = machine(missingRun, 'run.status');
    expect(!missingRunResponse.ok && missingRunResponse.error.code).toBe('RUN_NOT_FOUND');

    const missingSource = invoke(['project', 'add', join(f.root, 'missing'), '--json'], f.dataRoot);
    expect(missingSource.status).toBe(3);
    const missingSourceResponse = machine(missingSource, 'project.add');
    expect(!missingSourceResponse.ok && missingSourceResponse.error.code).toBe(
      'PROJECT_SOURCE_NOT_FOUND',
    );

    const internal = errorEnvelope('project.list', new Error('secret=do-not-leak'));
    expect(internal.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Sentry could not complete the command.',
      retryable: false,
    });
    expect(JSON.stringify(internal)).not.toContain('do-not-leak');
    expect(errorExitCode(internal.error)).toBe(1);

    const busy = errorEnvelope(
      'project.update',
      new RuntimePersistenceError('SQLITE_BUSY', 'Sentry data is busy; retry shortly'),
    );
    expect(busy.error).toMatchObject({ code: 'SQLITE_BUSY', retryable: true });
    expect(errorExitCode(busy.error)).toBe(4);
  });

  it('distinguishes findings, execution failure, partial QA, and cancellation exits', () => {
    const response = (status: 'completed' | 'failed' | 'partial' | 'cancelled', findings: number) =>
      CliSuccessEnvelopeSchema.parse({
        schemaVersion: 1,
        command: 'run.simulate',
        ok: true,
        data: {
          simulated: true,
          runId: 'run_01K7777777777777777777A8W3',
          projectId: 'proj_01K7777777777777777777A8W1',
          status,
          findings: { total: findings },
        },
      });
    expect(successExitCode(response('completed', 0))).toBe(0);
    expect(successExitCode(response('completed', 2))).toBe(5);
    expect(successExitCode(response('failed', 0))).toBe(6);
    expect(successExitCode(response('partial', 1))).toBe(7);
    expect(successExitCode(response('cancelled', 0))).toBe(8);
  });

  it('status from another process does not recover a run with a healthy owner', async () => {
    const f = await fixture();
    const add = machine(invoke(['project', 'add', f.source, '--json'], f.dataRoot), 'project.add');
    if (!add.ok || add.command !== 'project.add') throw new Error('Unexpected response');
    const simulation = machine(
      invoke(['run', 'simulate', add.data.projectId, '--json'], f.dataRoot),
      'run.simulate',
    );
    if (!simulation.ok || simulation.command !== 'run.simulate')
      throw new Error('Unexpected response');

    const database = new SentryDatabase({ dataRoot: f.dataRoot });
    const repository = new SentryRepository(database);
    const owner = new RuntimeInstanceLease(repository);
    owner.start();
    const projects = new ProjectManager(f.dataRoot, repository, { runtimeLease: owner });
    const persisted = repository.getRun(simulation.data.runId);
    if (persisted === undefined) throw new Error('Run fixture missing');
    const activeRunId = createQARunId();
    const active = QARunSchema.parse({
      ...persisted,
      id: activeRunId,
      runtimeInstanceId: owner.instanceId,
      status: 'agents_running',
      createdAt: nowIsoTimestamp(),
      startedAt: nowIsoTimestamp(),
      completedAt: undefined,
      summary: undefined,
    });
    repository.saveRun(active);
    projects.lockProjectForRun(active.projectId, active.id);

    try {
      const status = invoke(['run', 'status', active.id, '--json'], f.dataRoot);
      expect(status.status).toBe(0);
      const response = machine(status, 'run.status');
      expect(response.ok && response.command === 'run.status' && response.data.status).toBe(
        'agents_running',
      );
      expect(
        response.ok && response.command === 'run.status' && response.data.agents.configured,
      ).toBe(active.configuration.agentStackIds.length);
      expect(repository.getRun(active.id)?.status).toBe('agents_running');
      expect(repository.getManagedCopy(active.projectId)).toEqual(
        expect.objectContaining({
          state: 'locked_for_run',
          lockedByQARunId: active.id,
          runtimeInstanceId: owner.instanceId,
        }),
      );

      const blockedUpdate = invoke(['project', 'update', active.projectId, '--json'], f.dataRoot);
      expect(blockedUpdate.status).toBe(4);
      const conflict = machine(blockedUpdate, 'project.update');
      expect(!conflict.ok && conflict.error).toMatchObject({
        code: 'ACTIVE_RUN_EXISTS',
        retryable: true,
      });

      const activeExport = invoke(
        ['run', 'export', active.id, '--format', 'json', '--json'],
        f.dataRoot,
      );
      expect(activeExport.status).toBe(4);
      const exportConflict = machine(activeExport, 'run.export');
      expect(!exportConflict.ok && exportConflict.error).toMatchObject({
        code: 'RUN_NOT_COMPLETE',
        retryable: true,
      });
    } finally {
      repository.saveRun(
        QARunSchema.parse({
          ...active,
          status: 'completed',
          completedAt: nowIsoTimestamp(),
        }),
      );
      projects.unlockProjectAfterRun(active.projectId, active.id);
      owner.release();
      database.close();
    }
  }, 30_000);

  it('supports actual built CLI invocation', () => {
    const result = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(versionLine());
  });

  it('does not execute or set exitCode when the built module is imported', () => {
    const entryUrl = pathToFileURL(entry).href;
    const script = `await import(${JSON.stringify(entryUrl)}); console.log(JSON.stringify({ exitCode: process.exitCode ?? null }));`;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', script, 'importer-placeholder.mjs'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('{"exitCode":null}');
  });
});
