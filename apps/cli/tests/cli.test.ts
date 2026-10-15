import { spawn, spawnSync } from 'node:child_process';
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

/** Keep Vitest RPC and runtime-lease heartbeats responsive while a
 *  CLI subprocess runs on slow WSL/DrvFs storage. */
function invoke(args: readonly string[], dataRoot: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ['--no-warnings', entry, ...args], {
        // Legacy direct-execution suite: production defaults to the Desktop
        // broker, so these subprocesses pin the development-only transport.
        env: { ...process.env, SENTRY_DATA_ROOT: dataRoot, SENTRY_CLI_TRANSPORT: 'direct' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    },
  );
}

function machine(
  result: { status: number | null; stdout: string; stderr: string },
  expectedCommand: string,
): CliEnvelope {
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
      { agentStackId: 'stack_opencode_main', status: 'completed' },
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
        { agentStackId: 'stack_opencode_main', status: 'completed' },
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
      { agentStackId: 'stack_opencode_main', status: 'cancelled' },
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
    expect(versionLine()).toBe('qa 1.0.1');
  });

  it('doctor reports runtime foundation OK and points to agent diagnostics', () => {
    const lines = doctorLines();
    expect(lines[0]).toBe('Sentry');
    expect(lines.join('\n')).toContain('Domain       OK');
    expect(lines.join('\n')).not.toContain('ERROR');
    expect(lines.join('\n')).toContain('qa agent doctor opencode');
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

  it('lists agents, reports deterministic doctor failures, and types missing model configuration', async () => {
    const f = await fixture();
    const listed = await invoke(['agent', 'list', '--json'], f.dataRoot);
    expect(listed.status).toBe(0);
    const listResponse = machine(listed, 'agent.list');
    expect(listResponse.ok && listResponse.data).toMatchObject({
      agents: [
        {
          id: 'opencode',
          harness: 'opencode',
          modelEnvironmentVariable: 'SENTRY_OPENCODE_MODEL',
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
      ['--no-warnings', entry, 'agent', 'doctor', 'opencode', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SENTRY_DATA_ROOT: f.dataRoot,
          SENTRY_CLI_TRANSPORT: 'direct',
          SENTRY_OPENCODE_BINARY: join(f.root, 'missing-opencode'),
          SENTRY_OPENCODE_MODEL: 'openrouter-test-model',
        },
      },
    );
    expect(doctor.status).toBe(0);
    const doctorResponse = machine(doctor, 'agent.doctor');
    expect(doctorResponse.ok && doctorResponse.data).toMatchObject({
      agent: 'opencode',
      status: 'unavailable',
      readiness: 'unconfigured',
      credentialConfigured: false,
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
            SENTRY_CLI_TRANSPORT: 'direct',
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
    // run reaches selected-agent preflight, where the emptied OpenCode model
    // must produce the typed config error (not PROJECT_NOT_FOUND).
    const added = spawnSync(
      process.execPath,
      ['--no-warnings', entry, 'project', 'add', f.source, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, SENTRY_DATA_ROOT: f.dataRoot, SENTRY_CLI_TRANSPORT: 'direct' },
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
        'opencode',
        '--wait',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SENTRY_DATA_ROOT: f.dataRoot,
          SENTRY_OPENCODE_MODEL: '',
          SENTRY_CLI_TRANSPORT: 'direct',
        },
      },
    );
    expect(start.status).toBe(6);
    const startResponse = machine(start, 'run.start');
    expect(!startResponse.ok && startResponse.error.code).toBe('OPENCODE_MODEL_NOT_CONFIGURED');
    // Several CLI subprocesses took 64s on a WSL/DrvFs checkout; this
    // test-only budget does not change production command deadlines.
  }, 180_000);

  it('supports the complete subprocess JSON lifecycle with one document per command', async () => {
    const f = await fixture();
    const capabilities = await invoke(['capabilities', '--json'], f.dataRoot);
    expect(capabilities.status).toBe(0);
    const capabilityResponse = machine(capabilities, 'capabilities');
    expect(capabilityResponse.ok && capabilityResponse.data).toMatchObject({
      cliContractVersion: 1,
      features: { realAgentExecution: true, fakeRunSimulation: true },
    });

    const add = await invoke(['project', 'add', f.source, '--json'], f.dataRoot);
    expect(add.status).toBe(0);
    const added = machine(add, 'project.add');
    expect(added.ok).toBe(true);
    if (!added.ok || added.command !== 'project.add') throw new Error('Unexpected response');
    const projectId = added.data.projectId;

    const list = await invoke(['project', 'list', '--json'], f.dataRoot);
    expect(list.status).toBe(0);
    const listed = machine(list, 'project.list');
    expect(listed.ok && listed.command === 'project.list' && listed.data.projects).toHaveLength(1);

    const show = await invoke(['project', 'show', projectId, '--json'], f.dataRoot);
    expect(show.status).toBe(0);
    const shown = machine(show, 'project.show');
    expect(shown.ok && shown.command === 'project.show' && shown.data.project.id).toBe(projectId);

    await writeFile(join(f.source, 'index.ts'), 'export const value = 1;\n');
    const update = await invoke(['project', 'update', projectId, '--json'], f.dataRoot);
    expect(update.status).toBe(0);
    const updated = machine(update, 'project.update');
    expect(updated.ok && updated.command === 'project.update' && updated.data.revisionId).not.toBe(
      added.data.revisionId,
    );

    const simulate = await invoke(
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

    const runList = await invoke(['run', 'list', projectId, '--json'], f.dataRoot);
    expect(runList.status).toBe(0);
    const runs = machine(runList, 'run.list');
    expect(runs.ok && runs.command === 'run.list' && runs.data.runs[0]?.runId).toBe(runId);

    const runShow = await invoke(['run', 'show', runId, '--json'], f.dataRoot);
    expect(runShow.status).toBe(0);
    const details = machine(runShow, 'run.show');
    expect(
      details.ok && details.command === 'run.show' && details.data.counts.events,
    ).toBeGreaterThan(0);

    const status = await invoke(['run', 'status', runId, '--json'], f.dataRoot);
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

    const exported = await invoke(
      ['run', 'export', runId, '--format', 'json', '--json'],
      f.dataRoot,
    );
    expect(exported.status).toBe(0);
    const exportResponse = machine(exported, 'run.export');
    if (!exportResponse.ok || exportResponse.command !== 'run.export') {
      throw new Error('Unexpected response');
    }
    expect(JSON.parse(await readFile(exportResponse.data.path, 'utf8'))).toMatchObject({
      qaRun: { id: runId },
    });

    const deleted = await invoke(['project', 'delete', projectId, '--yes', '--json'], f.dataRoot);
    expect(deleted.status).toBe(0);
    const deleteResponse = machine(deleted, 'project.delete');
    expect(deleteResponse.ok && deleteResponse.data).toMatchObject({ projectId, deleted: true });
    // Eleven sequential CLI subprocesses took 170s under parallel WSL/DrvFs
    // load; the larger test-only budget leaves production timeouts unchanged.
  }, 240_000);

  it('merges a simulated run deterministically with stable exit semantics', async () => {
    const f = await fixture();
    const add = await invoke(['project', 'add', f.source, '--json'], f.dataRoot);
    expect(add.status).toBe(0);
    const added = machine(add, 'project.add');
    if (!added.ok || added.command !== 'project.add') throw new Error('Unexpected response');
    const simulate = await invoke(
      ['run', 'simulate', added.data.projectId, '--scenario', 'success', '--json'],
      f.dataRoot,
    );
    expect(simulate.status).toBe(5);
    const simulated = machine(simulate, 'run.simulate');
    if (!simulated.ok || simulated.command !== 'run.simulate')
      throw new Error('Unexpected response');
    const runId = simulated.data.runId;
    const merged = await invoke(['run', 'merge', runId, '--json'], f.dataRoot);
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
    const remerged = await invoke(['run', 'merge', runId, '--json'], f.dataRoot);
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
    const missing = await invoke(
      ['run', 'merge', 'run_01K7777777777777777777A8W9', '--json'],
      f.dataRoot,
    );
    expect(missing.status).toBe(3);
    const missingResponse = machine(missing, 'run.merge');
    expect(!missingResponse.ok && missingResponse.error.code).toBe('RUN_NOT_FOUND');
  }, 60_000);

  it('verifies a merged simulated run with stable exit semantics', async () => {
    const f = await fixture();
    const add = await invoke(['project', 'add', f.source, '--json'], f.dataRoot);
    expect(add.status).toBe(0);
    const added = machine(add, 'project.add');
    if (!added.ok || added.command !== 'project.add') throw new Error('Unexpected response');
    const simulate = await invoke(
      ['run', 'simulate', added.data.projectId, '--scenario', 'success', '--json'],
      f.dataRoot,
    );
    expect(simulate.status).toBe(5);
    const simulated = machine(simulate, 'run.simulate');
    if (!simulated.ok || simulated.command !== 'run.simulate')
      throw new Error('Unexpected response');
    const merged = await invoke(['run', 'merge', simulated.data.runId, '--json'], f.dataRoot);
    expect(merged.status).toBe(0);
    const mergeResponse = machine(merged, 'run.merge');
    if (!mergeResponse.ok || mergeResponse.command !== 'run.merge') {
      throw new Error('Unexpected response');
    }
    const started = await invoke(
      ['verify', 'start', mergeResponse.data.mergeResultId, '--json'],
      f.dataRoot,
    );
    expect(started.status).toBe(0);
    const verifyResponse = machine(started, 'verify.start');
    if (!verifyResponse.ok || verifyResponse.command !== 'verify.start') {
      throw new Error('Unexpected response');
    }
    expect(verifyResponse.data.mergeResultId).toBe(mergeResponse.data.mergeResultId);
    expect(verifyResponse.data.verificationRunId).toMatch(/^vrun_/);
    expect(verifyResponse.data.attempts.total).toBeGreaterThan(0);
    // Verification outcomes never affect the exit code (§70).
    const shown = await invoke(
      ['verify', 'show', verifyResponse.data.verificationRunId, '--json'],
      f.dataRoot,
    );
    expect(shown.status).toBe(0);
    const showResponse = machine(shown, 'verify.show');
    if (!showResponse.ok || showResponse.command !== 'verify.show') {
      throw new Error('Unexpected response');
    }
    expect(showResponse.data.attempts.length).toBe(verifyResponse.data.attempts.total);
    // Unknown merge result maps to the not-found exit category.
    const missing = await invoke(
      ['verify', 'start', 'merge_01K7777777777777777777A8W9', '--json'],
      f.dataRoot,
    );
    expect(missing.status).toBe(3);
    const missingResponse = machine(missing, 'verify.start');
    expect(!missingResponse.ok && missingResponse.error.code).toBe('RUN_NOT_FOUND');
  }, 120_000);

  it('returns typed machine errors and stable exit categories', async () => {
    const f = await fixture();
    const invalid = await invoke(['project', 'add', '--json'], f.dataRoot);
    expect(invalid.status).toBe(2);
    const invalidResponse = machine(invalid, 'project.add');
    expect(!invalidResponse.ok && invalidResponse.error.code).toBe('INVALID_ARGUMENT');

    const missingProject = await invoke(
      ['project', 'show', 'proj_01K7777777777777777777A8W1', '--json'],
      f.dataRoot,
    );
    expect(missingProject.status).toBe(3);
    const missingProjectResponse = machine(missingProject, 'project.show');
    expect(!missingProjectResponse.ok && missingProjectResponse.error.code).toBe(
      'PROJECT_NOT_FOUND',
    );

    const missingRun = await invoke(
      ['run', 'status', 'run_01K7777777777777777777A8W3', '--json'],
      f.dataRoot,
    );
    expect(missingRun.status).toBe(3);
    const missingRunResponse = machine(missingRun, 'run.status');
    expect(!missingRunResponse.ok && missingRunResponse.error.code).toBe('RUN_NOT_FOUND');

    const missingSource = await invoke(
      ['project', 'add', join(f.root, 'missing'), '--json'],
      f.dataRoot,
    );
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
    // Four CLI subprocesses took 42s on WSL/DrvFs even when run alone.
  }, 120_000);

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
    const add = machine(
      await invoke(['project', 'add', f.source, '--json'], f.dataRoot),
      'project.add',
    );
    if (!add.ok || add.command !== 'project.add') throw new Error('Unexpected response');
    const simulation = machine(
      await invoke(['run', 'simulate', add.data.projectId, '--json'], f.dataRoot),
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
      const status = await invoke(['run', 'status', active.id, '--json'], f.dataRoot);
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

      const blockedUpdate = await invoke(
        ['project', 'update', active.projectId, '--json'],
        f.dataRoot,
      );
      expect(blockedUpdate.status).toBe(4);
      const conflict = machine(blockedUpdate, 'project.update');
      expect(!conflict.ok && conflict.error).toMatchObject({
        code: 'ACTIVE_RUN_EXISTS',
        retryable: true,
      });

      const activeExport = await invoke(
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
  }, 120_000);

  it('serves Phase 7 targeted validation, cancel, revisions, and issue inspection', async () => {
    const f = await fixture();
    const add = machine(
      await invoke(['project', 'add', f.source, '--json'], f.dataRoot),
      'project.add',
    );
    if (!add.ok || add.command !== 'project.add') throw new Error('Unexpected response');
    const projectId = add.data.projectId;

    // Targeted mode requires --paths.
    const noPaths = await invoke(
      ['run', 'start', projectId, '--mode', 'targeted', '--wait', '--json'],
      f.dataRoot,
    );
    expect(noPaths.status).toBe(2);
    const noPathsResponse = machine(noPaths, 'run.start');
    expect(!noPathsResponse.ok && noPathsResponse.error.code).toBe('INVALID_ARGUMENT');

    // Full mode rejects --paths.
    const fullPaths = await invoke(
      ['run', 'start', projectId, '--mode', 'full', '--paths', 'src', '--wait', '--json'],
      f.dataRoot,
    );
    expect(fullPaths.status).toBe(2);
    const fullPathsResponse = machine(fullPaths, 'run.start');
    expect(!fullPathsResponse.ok && fullPathsResponse.error.code).toBe('INVALID_ARGUMENT');

    // Unknown command hint stays stable for the new areas.
    const revisions = await invoke(['project', 'revisions', projectId, '--json'], f.dataRoot);
    expect(revisions.status).toBe(0);
    const revisionsResponse = machine(revisions, 'project.revisions');
    expect(
      revisionsResponse.ok &&
        revisionsResponse.command === 'project.revisions' &&
        revisionsResponse.data.revisions.length,
    ).toBeGreaterThan(0);
    expect(
      revisionsResponse.ok &&
        revisionsResponse.command === 'project.revisions' &&
        revisionsResponse.data.revisions[0],
    ).toMatchObject({ current: true, runIds: [] });

    // No issues yet: empty list, stable not-found for show/history.
    const empty = await invoke(['issue', 'list', projectId, '--json'], f.dataRoot);
    expect(empty.status).toBe(0);
    const emptyResponse = machine(empty, 'issue.list');
    expect(
      emptyResponse.ok && emptyResponse.command === 'issue.list' && emptyResponse.data.issues,
    ).toEqual([]);
    const missing = await invoke(
      ['issue', 'show', 'issue_01K7777777777777777777A8W9', '--json'],
      f.dataRoot,
    );
    expect(missing.status).toBe(3);
    const missingResponse = machine(missing, 'issue.show');
    expect(!missingResponse.ok && missingResponse.error.code).toBe('ISSUE_NOT_FOUND');
    const missingHistory = await invoke(
      ['issue', 'history', 'issue_01K7777777777777777777A8W9', '--json'],
      f.dataRoot,
    );
    expect(missingHistory.status).toBe(3);

    // Terminal runs report already_terminal (honest machine state, exit 0)
    // with outputs intact — never a fake cancel, never a state-conflict error.
    const simulate = machine(
      await invoke(['run', 'simulate', projectId, '--scenario', 'success', '--json'], f.dataRoot),
      'run.simulate',
    );
    if (!simulate.ok || simulate.command !== 'run.simulate') throw new Error('Unexpected response');
    const cancel = await invoke(['run', 'cancel', simulate.data.runId, '--json'], f.dataRoot);
    expect(cancel.status).toBe(0);
    const cancelResponse = machine(cancel, 'run.cancel');
    if (!cancelResponse.ok || cancelResponse.command !== 'run.cancel')
      throw new Error('Unexpected response');
    expect(cancelResponse.data.status).toBe('already_terminal');
    expect(cancelResponse.data.ownerAcknowledged).toBe(false);

    // Issue ingest creates one open issue per cluster, idempotently.
    const merged = machine(
      await invoke(['run', 'merge', simulate.data.runId, '--json'], f.dataRoot),
      'run.merge',
    );
    if (!merged.ok || merged.command !== 'run.merge') throw new Error('Unexpected response');
    const ingest = await invoke(
      ['issue', 'ingest', merged.data.mergeResultId, '--json'],
      f.dataRoot,
    );
    expect(ingest.status).toBe(0);
    const ingestResponse = machine(ingest, 'issue.ingest');
    expect(
      ingestResponse.ok &&
        ingestResponse.command === 'issue.ingest' &&
        ingestResponse.data.issues.length,
    ).toBeGreaterThan(0);
    const reingest = await invoke(
      ['issue', 'ingest', merged.data.mergeResultId, '--json'],
      f.dataRoot,
    );
    expect(reingest.status).toBe(0);
    const reingestResponse = machine(reingest, 'issue.ingest');
    expect(
      reingestResponse.ok &&
        reingestResponse.command === 'issue.ingest' &&
        reingestResponse.data.issues.every((issue: { created: boolean }) => !issue.created),
    ).toBe(true);
    const listed = machine(
      await invoke(['issue', 'list', projectId, '--json'], f.dataRoot),
      'issue.list',
    );
    expect(listed.ok && listed.command === 'issue.list' && listed.data.issues[0]).toMatchObject({
      currentState: 'open',
    });
    const issueId = (
      ingestResponse.ok && ingestResponse.command === 'issue.ingest'
        ? ingestResponse.data.issues[0]
        : undefined
    ) as { issueId: string } | undefined;
    if (issueId === undefined) throw new Error('ingest produced no issue');
    const history = machine(
      await invoke(['issue', 'history', issueId.issueId, '--json'], f.dataRoot),
      'issue.history',
    );
    expect(
      history.ok && history.command === 'issue.history' && history.data.events.length,
    ).toBeGreaterThan(0);

    // Retest guards: unknown issue → not-found; unknown retest run → not-found;
    // retest start requires --wait.
    const retestMissing = await invoke(
      ['retest', 'show', 'retest_01K7777777777777777777A8W9', '--json'],
      f.dataRoot,
    );
    expect(retestMissing.status).toBe(3);
    const noWait = await invoke(['retest', 'start', issueId.issueId, '--json'], f.dataRoot);
    expect(noWait.status).toBe(2);
  }, 240_000);

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
