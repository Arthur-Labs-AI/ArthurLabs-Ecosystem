import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/arguments.js';
import { executeFrontendCommand, frontendErrorEnvelope } from '../src/frontend-application.js';
import { SentryDesktopClient } from '../src/desktop-client.js';
import { runCli } from '../src/index.js';
import { errorExitCode } from '../src/errors.js';
import { successExitCode } from '../src/output.js';

const RUN_ID = 'run_01K7777777777777777777A8W3';
const PROJECT_ID = 'proj_01K7777777777777777777A8W1';

function agentCounts(overrides: Record<string, number> = {}): Record<string, number> {
  return {
    configured: 3,
    queued: 0,
    starting: 0,
    planning: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    interrupted: 0,
    ...overrides,
  };
}

interface FakeBroker {
  readonly pipePath: string;
  readonly seen: Array<{ command: string; payload: Record<string, unknown> }>;
  readonly clients: string[];
  close(): Promise<void>;
}

async function startFakeBroker(
  handler: (command: string, payload: Record<string, unknown>) => unknown,
): Promise<FakeBroker> {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-fake-broker-'));
  const pipePath =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\sentry-fake-' + dir.split(/\\/).pop()
      : join(dir, 'broker.sock');
  const seen: Array<{ command: string; payload: Record<string, unknown> }> = [];
  const clients: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let hello = false;
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) {
          index = buffer.indexOf('\n');
          continue;
        }
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (!hello) {
          const client = (frame['client'] ?? {}) as { name?: string };
          clients.push(String(client.name ?? ''));
          hello = true;
          socket.write(
            JSON.stringify({
              type: 'welcome',
              protocolVersion: 1,
              product: { name: 'Sentry', version: 'test' },
            }) + '\n',
          );
        } else {
          const id = String(frame['id']);
          const command = String(frame['command']);
          const payload = (frame['payload'] ?? {}) as Record<string, unknown>;
          seen.push({ command, payload });
          void (async () => {
            try {
              const result = await handler(command, payload);
              socket.write(JSON.stringify({ type: 'response', id, ok: true, result }) + '\n');
            } catch (error) {
              const code = (error as { code?: string }).code ?? 'DESKTOP_ERROR';
              socket.write(
                JSON.stringify({
                  type: 'response',
                  id,
                  ok: false,
                  error: { code, message: String((error as Error).message ?? error) },
                }) + '\n',
              );
            }
          })();
        }
        index = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => resolve());
  });
  return {
    pipePath,
    seen,
    clients,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function clientFor(broker: FakeBroker): SentryDesktopClient {
  return new SentryDesktopClient({
    pipePath: broker.pipePath,
    clientName: 'Nexus',
    timeoutMs: 15000,
  });
}
describe('cli frontend over the desktop broker', () => {
  it('reports capabilities with the Nexus contract surface', async () => {
    const broker = await startFakeBroker(() => {
      throw new Error('unexpected call');
    });
    try {
      const response = await executeFrontendCommand(parseCommand(['capabilities']), {
        createClient: () => clientFor(broker),
      });
      expect(response).toMatchObject({
        command: 'capabilities',
        ok: true,
        data: {
          cliContractVersion: 1,
          features: { realAgentExecution: true, runCancellation: true },
          asyncRunStart: true,
          runResultExport: true,
          ipcProtocolVersion: 1,
          productionCommands: {
            runSimulation: false,
            realRunExecution: true,
            runResult: true,
            runExport: true,
          },
        },
      });
      expect(broker.clients).toEqual(['Nexus']);
    } finally {
      await broker.close();
    }
  });

  it('maps project list and run status from broker payloads', async () => {
    const broker = await startFakeBroker((command) => {
      if (command === 'projects:list')
        return [
          {
            projectId: PROJECT_ID,
            name: 'Demo',
            state: 'ready',
            currentRevisionId: 'rev_01K7777777777777777777A8W1',
            sourcePath: 'C:/demo',
            updatedAt: '2026-09-28T00:00:00.000Z',
            runCount: 0,
          },
        ];
      if (command === 'runs:status')
        return {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          mode: 'full',
          status: 'completed',
          createdAt: '2026-09-28T00:00:00.000Z',
          completedAt: '2026-09-28T00:01:00.000Z',
          agents: agentCounts({ completed: 3 }),
          findings: { total: 2 },
        };
      throw Object.assign(new Error('Unknown command: ' + command), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
    });
    try {
      const listed = await executeFrontendCommand(parseCommand(['project', 'list']), {
        createClient: () => clientFor(broker),
      });
      expect(listed.ok && listed.command === 'project.list' && listed.data.projects).toHaveLength(
        1,
      );
      const status = await executeFrontendCommand(parseCommand(['run', 'status', RUN_ID]), {
        createClient: () => clientFor(broker),
      });
      expect(status).toMatchObject({
        command: 'run.status',
        ok: true,
        data: { runId: RUN_ID, status: 'completed' },
      });
    } finally {
      await broker.close();
    }
  });

  it('preserves every public broker error code for Nexus branching', async () => {
    const broker = await startFakeBroker(() => {
      throw Object.assign(new Error('boom'), { code: 'RUN_NOT_COMPLETE' });
    });
    try {
      const parsed = parseCommand(['run', 'result', RUN_ID]);
      await expect(
        executeFrontendCommand(parsed, { createClient: () => clientFor(broker) }),
      ).rejects.toMatchObject({ code: 'RUN_NOT_COMPLETE' });
      const table: Array<{ code: string; exit: number }> = [
        { code: 'PROJECT_NOT_FOUND', exit: 3 },
        { code: 'RUN_NOT_FOUND', exit: 3 },
        { code: 'RUN_NOT_COMPLETE', exit: 4 },
        { code: 'PROVIDER_NOT_READY', exit: 6 },
        { code: 'ACTIVE_RUN_EXISTS', exit: 4 },
        { code: 'PROJECT_LOCKED', exit: 4 },
        { code: 'CLI_COMMAND_FORBIDDEN', exit: 2 },
        { code: 'SENTRY_DESKTOP_NOT_RUNNING', exit: 1 },
        { code: 'RESPONSE_TOO_LARGE', exit: 4 },
        { code: 'PROTOCOL_VERSION_MISMATCH', exit: 1 },
        { code: 'RUN_MAY_HAVE_STARTED', exit: 4 },
      ];
      for (const { code, exit } of table) {
        const envelope = frontendErrorEnvelope(
          'run.status',
          Object.assign(new Error('x'), { code }),
        );
        expect(envelope.error.code).toBe(code);
        expect(errorExitCode(envelope.error)).toBe(exit);
      }
      const unknown = frontendErrorEnvelope(
        'run.status',
        Object.assign(new Error('x'), { code: 'SOME_FUTURE_CODE' }),
      );
      expect(unknown.error.code).toBe('INTERNAL_ERROR');
    } finally {
      await broker.close();
    }
  });

  it('starts async, survives CLI disconnect, and polls the same run later', async () => {
    let runs = 0;
    const broker = await startFakeBroker((command) => {
      if (command === 'runs:start') return { operationId: 'dop_test', runId: RUN_ID };
      if (command === 'runs:status') {
        runs += 1;
        return {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          mode: 'full',
          status: runs < 3 ? 'agents_running' : 'completed',
          createdAt: '2026-09-28T00:00:00.000Z',
          completedAt: null,
          agents: agentCounts({ running: runs < 3 ? 3 : 0, completed: runs < 3 ? 0 : 3 }),
          findings: { total: 0 },
        };
      }
      throw Object.assign(new Error('Unknown command: ' + command), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
    });
    try {
      const started = await executeFrontendCommand(
        parseCommand([
          'run',
          'start',
          PROJECT_ID,
          '--mode',
          'full',
          '--agents',
          'opencode,deepseek,glm',
        ]),
        { createClient: () => clientFor(broker) },
      );
      expect(started).toMatchObject({
        command: 'run.start',
        ok: true,
        data: { runId: RUN_ID, operationId: 'dop_test' },
      });
      const startCall = broker.seen.find((call) => call.command === 'runs:start');
      expect(startCall?.payload['agentStackIds']).toEqual([
        'stack_opencode_main',
        'stack_deepseek_main',
        'stack_glm_main',
      ]);
      // CLI process exits here in production; the runtime keeps the run.
      const later = await executeFrontendCommand(parseCommand(['run', 'status', RUN_ID]), {
        createClient: () => clientFor(broker),
      });
      expect(later.ok && later.command === 'run.status' && later.data.status).toBe(
        'agents_running',
      );
    } finally {
      await broker.close();
    }
  });

  it('observes a run with --wait through the canonical run, not a second owner', async () => {
    let polls = 0;
    const broker = await startFakeBroker((command) => {
      if (command === 'runs:start') return { operationId: 'dop_test', runId: RUN_ID };
      if (command === 'runs:status') {
        polls += 1;
        return {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          mode: 'full',
          status: polls < 2 ? 'agents_running' : 'completed',
          createdAt: '2026-09-28T00:00:00.000Z',
          completedAt: polls < 2 ? null : '2026-09-28T00:01:00.000Z',
          agents: agentCounts({
            configured: 1,
            running: polls < 2 ? 1 : 0,
            completed: polls < 2 ? 0 : 1,
          }),
          findings: { total: 0 },
        };
      }
      if (command === 'runs:get')
        return {
          run: { id: RUN_ID },
          agentRuns: [{ agentStackId: 'stack_opencode_main', status: 'completed' }],
          findings: [{ id: 'f1' }],
          evidence: [],
          exports: [],
          counts: { agentRuns: 1, findings: 1, evidence: 0, activities: 0, events: 0, exports: 0 },
        };
      throw Object.assign(new Error('Unknown command: ' + command), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
    });
    try {
      const response = await executeFrontendCommand(
        parseCommand([
          'run',
          'start',
          PROJECT_ID,
          '--mode',
          'full',
          '--agents',
          'opencode',
          '--wait',
        ]),
        { createClient: () => clientFor(broker) },
      );
      expect(response).toMatchObject({
        command: 'run.start',
        ok: true,
        data: { runId: RUN_ID, status: 'completed', findings: { total: 1 } },
      });
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(broker.seen.filter((call) => call.command === 'runs:start')).toHaveLength(1);
    } finally {
      await broker.close();
    }
  });

  it('returns the canonical export bytes for run result without reformatting', async () => {
    const canonical = { runId: RUN_ID, status: 'completed', findings: [{ id: 'f1', title: 'X' }] };
    const broker = await startFakeBroker((command) => {
      if (command === 'runs:export-content')
        return {
          filename: 'sentry-' + RUN_ID + '.json',
          mimeType: 'application/json',
          format: 'json',
          sizeBytes: 10,
          contentBase64: Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64'),
        };
      throw Object.assign(new Error('Unknown command: ' + command), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
    });
    try {
      const response = await executeFrontendCommand(parseCommand(['run', 'result', RUN_ID]), {
        createClient: () => clientFor(broker),
      });
      expect(response).toMatchObject({
        command: 'run.result',
        ok: true,
        data: { runId: RUN_ID, format: 'json', result: canonical },
      });
      expect(broker.seen).toHaveLength(1);
      expect(broker.seen[0]?.command).toBe('runs:export-content');
    } finally {
      await broker.close();
    }
  });
  it('fails deterministically when Desktop is not running', async () => {
    const missing =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\sentry-fake-missing-' + process.pid
        : join(tmpdir(), 'sentry-fake-missing-' + process.pid + '.sock');
    const parsed = parseCommand(['run', 'status', RUN_ID]);
    const client = new SentryDesktopClient({ pipePath: missing, timeoutMs: 5000 });
    await expect(
      executeFrontendCommand(parsed, { createClient: () => client }),
    ).rejects.toMatchObject({ code: 'SENTRY_DESKTOP_NOT_RUNNING' });
    const envelope = frontendErrorEnvelope(parsed.command, {
      code: 'SENTRY_DESKTOP_NOT_RUNNING',
      message: 'gone',
    });
    expect(envelope).toMatchObject({
      command: 'run.status',
      ok: false,
      error: { code: 'SENTRY_DESKTOP_NOT_RUNNING' },
    });
    expect(errorExitCode(envelope.error)).toBe(1);
  });

  it('passes broker error codes through for Nexus instead of collapsing them', async () => {
    const broker = await startFakeBroker(() => {
      throw Object.assign(
        new Error('Cannot start QA - provider not ready: stack_opencode_main: no credential'),
        { code: 'PROVIDER_NOT_READY' },
      );
    });
    try {
      const parsed = parseCommand(['run', 'start', PROJECT_ID, '--mode', 'full']);
      await expect(
        executeFrontendCommand(parsed, { createClient: () => clientFor(broker) }),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_READY' });
      const envelope = frontendErrorEnvelope(
        parsed.command,
        Object.assign(new Error('Cannot start QA'), { code: 'PROVIDER_NOT_READY' }),
      );
      expect(envelope.error.code).toBe('PROVIDER_NOT_READY');
      expect(errorExitCode(envelope.error)).toBe(6);
    } finally {
      await broker.close();
    }
  });

  it('keeps machine stdout as exactly one JSON document', async () => {
    const broker = await startFakeBroker((command) => {
      if (command === 'runs:status')
        return {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          mode: 'full',
          status: 'completed',
          createdAt: '2026-09-28T00:00:00.000Z',
          completedAt: '2026-09-28T00:01:00.000Z',
          agents: agentCounts({ completed: 3 }),
          findings: { total: 0 },
        };
      throw Object.assign(new Error('Unknown command: ' + command), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
    });
    const previous = process.env['SENTRY_CLI_PIPE_PATH'];
    process.env['SENTRY_CLI_PIPE_PATH'] = broker.pipePath;
    try {
      const lines: string[] = [];
      const diagnostics: string[] = [];
      const code = await runCli(['node', 'cli', 'run', 'status', RUN_ID, '--json'], {
        stdout: (message) => lines.push(message),
        stderr: (message) => diagnostics.push(message),
      });
      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      expect(diagnostics).toEqual([]);
      const parsed = JSON.parse(lines[0] ?? '') as { command?: string; ok?: boolean };
      expect(parsed).toMatchObject({ command: 'run.status', ok: true });
    } finally {
      if (previous === undefined) delete process.env['SENTRY_CLI_PIPE_PATH'];
      else process.env['SENTRY_CLI_PIPE_PATH'] = previous;
      await broker.close();
    }
  });

  it('emits machine JSON errors without diagnostic contamination', async () => {
    const missing =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\sentry-fake-missing-json-' + process.pid
        : join(tmpdir(), 'sentry-fake-missing-json-' + process.pid + '.sock');
    const previous = process.env['SENTRY_CLI_PIPE_PATH'];
    process.env['SENTRY_CLI_PIPE_PATH'] = missing;
    try {
      const lines: string[] = [];
      const diagnostics: string[] = [];
      const code = await runCli(['node', 'cli', 'capabilities', '--json'], {
        stdout: (message) => lines.push(message),
        stderr: (message) => diagnostics.push(message),
      });
      expect(code).toBe(1);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? '') as { ok?: boolean; error?: { code?: string } };
      expect(parsed).toMatchObject({ ok: false, error: { code: 'SENTRY_DESKTOP_NOT_RUNNING' } });
    } finally {
      if (previous === undefined) delete process.env['SENTRY_CLI_PIPE_PATH'];
      else process.env['SENTRY_CLI_PIPE_PATH'] = previous;
    }
  });

  it('redacts secret-shaped values from frontend errors', () => {
    const envelope = frontendErrorEnvelope(
      'run.start',
      Object.assign(new Error('start failed; DEEPSEEK_API_KEY=hunter2'), {
        code: 'DEEPSEEK_START_FAILED',
      }),
    );
    expect(JSON.stringify(envelope)).not.toContain('hunter2');
    expect(envelope.error.code).toBe('DEEPSEEK_START_FAILED');
  });

  it('routes run export through export bytes with an explicit --out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-export-'));
    const broker = await startFakeBroker((command) => {
      if (command === 'runs:export-content')
        return {
          filename: 'run.log',
          mimeType: 'text/plain',
          format: 'log',
          sizeBytes: 11,
          contentBase64: Buffer.from('hello world', 'utf8').toString('base64'),
        };
      throw Object.assign(new Error('Unknown command: ' + command), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
    });
    try {
      const out = join(dir, 'run.log');
      const response = await executeFrontendCommand(
        parseCommand(['run', 'export', RUN_ID, '--format', 'log', '--out', out]),
        { createClient: () => clientFor(broker) },
      );
      expect(response).toMatchObject({
        command: 'run.export',
        ok: true,
        data: { runId: RUN_ID, path: out },
      });
      await expect(readFile(out, 'utf8')).resolves.toBe('hello world');
      const parsed = parseCommand(['run', 'export', RUN_ID, '--format', 'log']);
      await expect(
        executeFrontendCommand(parsed, { createClient: () => clientFor(broker) }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves success exit codes deterministic for async and terminal runs', async () => {
    expect(
      successExitCode({
        schemaVersion: 1,
        command: 'run.start',
        ok: true,
        data: {
          simulated: false,
          runId: RUN_ID,
          projectId: PROJECT_ID,
          status: 'running',
          operationId: 'dop_1',
        },
      }),
    ).toBe(0);
    expect(
      successExitCode({
        schemaVersion: 1,
        command: 'run.start',
        ok: true,
        data: {
          simulated: false,
          runId: RUN_ID,
          projectId: PROJECT_ID,
          status: 'failed',
          operationId: 'dop_1',
          agents: {
            configured: 1,
            completed: 0,
            failed: 1,
            timedOut: 0,
            interrupted: 0,
            cancelled: 0,
            runs: [],
          },
          findings: { total: 0 },
        },
      }),
    ).toBe(6);
  });
});
