// Full production-path regression: real CLI frontend code against a real
// Electron broker, the real shared command router, a real
// DesktopApplicationService, and a fake WSL runtime backend. The command-name
// boundary between frontend and broker is NOT mocked: the frontend must
// generate broker commands the real router accepts (this is what caught the
// runs:export-content vs runs:exportContent mismatch). Test-only
// cross-package source imports; production CLI code never imports desktop
// modules, and the CLI never touches a database, lease, or harness here.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { SentryCliServer } from '../../desktop/src/main/cli-server.js';
import { dispatchDesktopCommand } from '../../desktop/src/main/desktop-command-router.js';
import { DesktopApplicationService } from '../../desktop/src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../desktop/src/main/services/provider-credentials.js';
import { parseCommand } from '../src/arguments.js';
import { executeFrontendCommand } from '../src/frontend-application.js';
import { SentryDesktopClient } from '../src/desktop-client.js';
import { runCli } from '../src/index.js';

const RUN_ID = 'run_01K7777777777777777777A8W3';
const PROJECT_ID = 'proj_01K7777777777777777777A8W1';
const REVISION_ID = 'rev_01K7777777777777777777A8W1';
const CANONICAL_RESULT = {
  runId: RUN_ID,
  status: 'completed',
  findings: [{ id: 'f1', title: 'Leak' }],
};

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

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('enc:' + value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice(4),
  };
}

interface FullPathHarness {
  readonly server: SentryCliServer;
  readonly seenRuntime: Array<{ method: string; params: Record<string, unknown> }>;
  readonly createdRuns: Array<{ runId: string; operationId?: string }>;
  readonly client: () => SentryDesktopClient;
  close(): Promise<void>;
}

async function harness(): Promise<FullPathHarness> {
  const root = await mkdtemp(join(tmpdir(), 'sentry-full-path-'));
  const credentials = new ProviderCredentialService({
    filePath: join(root, 'providers.json'),
    safeStorage: fakeSafeStorage(),
  });
  const seenRuntime: Array<{ method: string; params: Record<string, unknown> }> = [];
  const createdRuns: Array<{ runId: string; operationId?: string }> = [];
  const runtime = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      seenRuntime.push({ method, params });
      if (method === 'production.preRunGate') return { ready: true, warnings: [], stacks: [] };
      if (method === 'runs.start') return { operationId: 'dop_e2e', runId: RUN_ID };
      if (method === 'runs.status') {
        // Small delay keeps the client connection observable mid-flight for
        // the identity test; the lifecycle still completes in milliseconds.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          mode: 'full',
          status: 'completed',
          createdAt: '2026-09-28T00:00:00.000Z',
          completedAt: '2026-09-28T00:01:00.000Z',
          agents: agentCounts({ completed: 3 }),
          findings: { total: 1 },
        };
      }
      if (method === 'runs.exportContent') {
        return {
          filename: 'sentry-' + RUN_ID + '.json',
          mimeType: 'application/json',
          format: 'json',
          sizeBytes: 42,
          contentBase64: Buffer.from(JSON.stringify(CANONICAL_RESULT), 'utf8').toString('base64'),
        };
      }
      if (method === 'runs.cancel')
        return { runId: RUN_ID, status: 'cancelled', cancelledAgents: 1, ownerAcknowledged: true };
      if (method === 'projects.list') {
        return [
          {
            projectId: PROJECT_ID,
            name: 'E2E',
            state: 'ready',
            currentRevisionId: REVISION_ID,
            sourcePath: 'C:/e2e',
            updatedAt: '2026-09-28T00:00:00.000Z',
            runCount: 1,
          },
        ];
      }
      if (method === 'runtime.configure') return { configured: true };
      throw Object.assign(new Error('Unexpected runtime call: ' + method), {
        code: 'UNKNOWN_METHOD',
      });
    },
    status: { connected: true, distro: 'Ubuntu', hello: undefined, lastError: undefined },
  };
  const service = new DesktopApplicationService({
    runtime: runtime as never,
    distro: 'Ubuntu',
    credentials,
    agentStacks: [...INITIAL_AGENT_STACKS],
  });
  const server = new SentryCliServer({
    pipePath:
      process.platform === 'win32'
        ? '\\\\.\\pipe\\sentry-e2e-' + process.pid + '-' + Math.floor(Math.random() * 1e6)
        : join(root, 'e2e.sock'),
    dispatch: (command, payload) =>
      dispatchDesktopCommand(
        service,
        command,
        payload,
        {
          onRunCreated: (runId, operationId) => {
            createdRuns.push({ runId, operationId });
          },
        },
        { external: true },
      ),
  });
  await server.start();
  return {
    server,
    seenRuntime,
    createdRuns,
    client: () =>
      new SentryDesktopClient({
        pipePath: server.status.pipePath,
        clientName: 'Nexus',
        clientVersion: '0.1.0',
        timeoutMs: 15000,
      }),
    close: async () => {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe('full production path: cli to canonical runtime', () => {
  it('runs the Nexus lifecycle end to end across fresh invocations', async () => {
    const h = await harness();
    try {
      const capabilities = await executeFrontendCommand(parseCommand(['capabilities']), {
        createClient: h.client,
      });
      expect(capabilities).toMatchObject({
        command: 'capabilities',
        ok: true,
        data: {
          cliContractVersion: 1,
          ipcProtocolVersion: 1,
          productionCommands: {
            runSimulation: false,
            realRunExecution: true,
            runResult: true,
            runExport: true,
          },
        },
      });
      const listed = await executeFrontendCommand(parseCommand(['project', 'list']), {
        createClient: h.client,
      });
      expect(listed.ok && listed.command === 'project.list' && listed.data.projects).toHaveLength(
        1,
      );
      // Client 1 starts the run, then its process exits.
      const started = await executeFrontendCommand(
        parseCommand([
          'run',
          'start',
          PROJECT_ID,
          '--mode',
          'full',
          '--agents',
          'opencode,deepseek,glm',
          '--timeout-ms',
          '600000',
        ]),
        { createClient: h.client },
      );
      expect(started).toMatchObject({
        command: 'run.start',
        ok: true,
        data: { runId: RUN_ID, operationId: 'dop_e2e' },
      });
      // The shared router fired run-created hooks, so Desktop live updates
      // track this CLI-started run exactly like a UI-started run.
      expect(h.createdRuns).toEqual([{ runId: RUN_ID, operationId: 'dop_e2e' }]);
      const startCall = h.seenRuntime.find((call) => call.method === 'runs.start');
      expect(startCall?.params['agentStackIds']).toEqual([
        'stack_opencode_main',
        'stack_deepseek_main',
        'stack_glm_main',
      ]);
      expect(startCall?.params['runTimeoutMs']).toBe(600000);
      expect(h.seenRuntime.some((call) => call.method === 'production.preRunGate')).toBe(true);
      // Client 2 polls the same canonical run later.
      const status = await executeFrontendCommand(parseCommand(['run', 'status', RUN_ID]), {
        createClient: h.client,
      });
      expect(status).toMatchObject({
        command: 'run.status',
        ok: true,
        data: { runId: RUN_ID, status: 'completed' },
      });
      // Client 2 fetches the canonical JSON result.
      const result = await executeFrontendCommand(parseCommand(['run', 'result', RUN_ID]), {
        createClient: h.client,
      });
      expect(result).toMatchObject({
        command: 'run.result',
        ok: true,
        data: { runId: RUN_ID, format: 'json', result: CANONICAL_RESULT },
      });
      // run export materializes the same canonical bytes to a file.
      const dir = await mkdtemp(join(tmpdir(), 'sentry-e2e-export-'));
      try {
        const out = join(dir, 'run.json');
        const exported = await executeFrontendCommand(
          parseCommand(['run', 'export', RUN_ID, '--format', 'json', '--out', out]),
          { createClient: h.client },
        );
        expect(exported).toMatchObject({
          command: 'run.export',
          ok: true,
          data: { runId: RUN_ID, path: out },
        });
        await expect(readFile(out, 'utf8')).resolves.toBe(JSON.stringify(CANONICAL_RESULT));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      const cancelled = await executeFrontendCommand(parseCommand(['run', 'cancel', RUN_ID]), {
        createClient: h.client,
      });
      expect(cancelled).toMatchObject({
        command: 'run.cancel',
        ok: true,
        data: { runId: RUN_ID, status: 'cancelled' },
      });
    } finally {
      await h.close();
    }
  });

  it('rejects invalid timeouts at the parser, never silently', async () => {
    expect(() =>
      parseCommand(['run', 'start', PROJECT_ID, '--mode', 'full', '--timeout-ms', 'nope']),
    ).toThrow();
    expect(() =>
      parseCommand(['run', 'start', PROJECT_ID, '--mode', 'full', '--timeout-ms', '500']),
    ).toThrow();
    expect(() =>
      parseCommand(['run', 'start', PROJECT_ID, '--mode', 'full', '--timeout-ms', '99999999999']),
    ).toThrow();
    const h = await harness();
    try {
      const started = await executeFrontendCommand(
        parseCommand(['run', 'start', PROJECT_ID, '--mode', 'full', '--timeout-ms', '1000']),
        { createClient: h.client },
      );
      expect(started.ok).toBe(true);
      expect(
        h.seenRuntime.find((call) => call.method === 'runs.start')?.params['runTimeoutMs'],
      ).toBe(1000);
    } finally {
      await h.close();
    }
  });

  it('keeps machine stdout to exactly one JSON document on the real path', async () => {
    const h = await harness();
    const previous = process.env['SENTRY_CLI_PIPE_PATH'];
    process.env['SENTRY_CLI_PIPE_PATH'] = h.server.status.pipePath;
    try {
      const lines: string[] = [];
      const diagnostics: string[] = [];
      const code = await runCli(['node', 'cli', 'run', 'result', RUN_ID, '--json'], {
        stdout: (message) => lines.push(message),
        stderr: (message) => diagnostics.push(message),
      });
      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      expect(diagnostics).toEqual([]);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({
        command: 'run.result',
        ok: true,
        data: { result: CANONICAL_RESULT },
      });
    } finally {
      if (previous === undefined) delete process.env['SENTRY_CLI_PIPE_PATH'];
      else process.env['SENTRY_CLI_PIPE_PATH'] = previous;
      await h.close();
    }
  });

  it('shows Nexus identity in broker status while connected', async () => {
    const h = await harness();
    try {
      const pending = executeFrontendCommand(parseCommand(['run', 'status', RUN_ID]), {
        createClient: h.client,
      });
      let observed: string[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        observed = h.server.status.connectedClients.map(
          (client) => client.name + '@' + (client.version ?? ''),
        );
        if (observed.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observed).toEqual(['Nexus@0.1.0']);
      await pending;
      for (
        let attempt = 0;
        attempt < 40 && h.server.status.connectedClients.length > 0;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(h.server.status.connectedClients).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('refuses development-only commands without touching the broker', async () => {
    const h = await harness();
    try {
      await expect(
        executeFrontendCommand(parseCommand(['run', 'simulate', PROJECT_ID]), {
          createClient: h.client,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(h.seenRuntime).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
