import { createConnection, type Socket } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import { dispatchDesktopCommand } from '../../src/main/desktop-command-router.js';
import { SentryCliServer } from '../../src/main/cli-server.js';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';

const RUN_ID = 'run_01K7777777777777777777A8W3';
const PROJECT_ID = 'proj_01K7777777777777777777A8W1';

const servers: SentryCliServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('enc:' + value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice(4),
  };
}

async function harness(onRunCreated: (runId: string, operationId?: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'sentry-loop-'));
  const credentials = new ProviderCredentialService({
    filePath: join(root, 'providers.json'),
    safeStorage: fakeSafeStorage(),
  });
  const seen: string[] = [];
  const runtime = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      seen.push(method);
      if (method === 'production.preRunGate') return { ready: true, warnings: [], stacks: [] };
      if (method === 'runs.start') return { operationId: 'dop_loop', runId: RUN_ID };
      if (method === 'runs.status') {
        const id = params['runId'];
        if (id !== RUN_ID)
          throw Object.assign(new Error('Run not found: ' + String(id)), { code: 'RUN_NOT_FOUND' });
        return {
          runId: RUN_ID,
          projectId: PROJECT_ID,
          mode: 'full',
          status: 'completed',
          createdAt: '2026-09-28T00:00:00.000Z',
          completedAt: '2026-09-28T00:01:00.000Z',
          agents: {
            configured: 3,
            queued: 0,
            starting: 0,
            planning: 0,
            running: 0,
            completed: 3,
            failed: 0,
            cancelled: 0,
            timedOut: 0,
            interrupted: 0,
          },
          findings: { total: 1 },
        };
      }
      if (method === 'runs.exportContent') {
        return {
          filename: 'run.json',
          mimeType: 'application/json',
          format: 'json',
          sizeBytes: 20,
          contentBase64: Buffer.from(
            JSON.stringify({ runId: RUN_ID, status: 'completed' }),
            'utf8',
          ).toString('base64'),
        };
      }
      if (method === 'projects.list') return [];
      return { ok: true };
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
        ? '\\\\.\\pipe\\sentry-loop-' + process.pid
        : join(root, 'loop.sock'),
    dispatch: (command, payload) =>
      dispatchDesktopCommand(service, command, payload, { onRunCreated }, { external: true }),
  });
  servers.push(server);
  await server.start();
  return { server, seen };
}

interface PipeClient {
  request(command: string, payload?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

async function connectPipe(pipePath: string, name: string): Promise<PipeClient> {
  const socket: Socket = createConnection(pipePath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  let buffer = '';
  const waiters: Array<(line: string) => void> = [];
  const queued: string[] = [];
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        try {
          const frame = JSON.parse(line) as {
            type?: string;
            id?: string;
            ok?: boolean;
            result?: unknown;
            error?: { code?: string; message?: string };
          };
          if (frame.type === 'response' && typeof frame.id === 'string' && pending.has(frame.id)) {
            const entry = pending.get(frame.id);
            pending.delete(frame.id);
            if (frame.ok === true) entry?.resolve(frame.result);
            else
              entry?.reject(
                Object.assign(new Error(frame.error?.message ?? 'failed'), {
                  code: frame.error?.code ?? 'DESKTOP_ERROR',
                }),
              );
            index = buffer.indexOf('\n');
            continue;
          }
        } catch {
          /* fall through to waiter queue */
        }
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(line);
        else queued.push(line);
      }
      index = buffer.indexOf('\n');
    }
  });
  const nextLine = (): Promise<string> => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise<string>((resolve) => {
      waiters.push(resolve);
    });
  };
  socket.write(
    JSON.stringify({ type: 'hello', protocolVersion: 1, client: { type: 'cli', name } }) + '\n',
  );
  const welcome = JSON.parse(await nextLine()) as { type?: string };
  if (welcome.type !== 'welcome') throw new Error('handshake failed');
  let counter = 0;
  return {
    request: (command, payload = {}) =>
      new Promise<unknown>((resolve, reject) => {
        counter += 1;
        const id = 't' + counter;
        pending.set(id, { resolve, reject });
        socket.write(JSON.stringify({ type: 'request', id, command, payload }) + '\n');
      }),
    close: () => {
      socket.destroy();
    },
  };
}
describe('cli broker to runtime loop', () => {
  it('runs the Nexus lifecycle against the real router and service', async () => {
    const created: Array<{ runId: string; operationId?: string }> = [];
    const { server, seen } = await harness((runId, operationId) => {
      created.push({ runId, operationId });
    });
    const first = await connectPipe(server.status.pipePath, 'Nexus');
    const started = (await first.request('runs:start', {
      projectId: PROJECT_ID,
      mode: 'full',
    })) as { runId?: string; operationId?: string };

    expect(started.runId).toBe(RUN_ID);
    expect(started.operationId).toBe('dop_loop');
    // The shared router fired the run-created hook, so Desktop live updates
    // track CLI-started runs exactly like UI-started runs.
    expect(created).toEqual([{ runId: RUN_ID, operationId: 'dop_loop' }]);
    expect(seen).toContain('production.preRunGate');
    // CLI process exits; the runtime keeps owning the run.
    first.close();
    const second = await connectPipe(server.status.pipePath, 'Nexus');
    try {
      const status = (await second.request('runs:status', { runId: RUN_ID })) as {
        status?: string;
      };
      expect(status.status).toBe('completed');
      const exported = (await second.request('runs:export-content', {
        runId: RUN_ID,
        format: 'json',
      })) as { contentBase64?: string };
      const canonical = JSON.parse(
        Buffer.from(exported.contentBase64 ?? '', 'base64').toString('utf8'),
      ) as { runId?: string };
      expect(canonical.runId).toBe(RUN_ID);
    } finally {
      second.close();
    }
  });

  it('rejects provider-secret commands over the wire', async () => {
    const { server } = await harness(() => undefined);
    const client = await connectPipe(server.status.pipePath, 'Nexus');
    try {
      await expect(
        client.request('providers:save', { name: 'X', value: 'Y' }),
      ).rejects.toMatchObject({ code: 'CLI_COMMAND_FORBIDDEN' });
      await expect(
        client.request('runtime:select-distro', { distro: 'Ubuntu' }),
      ).rejects.toMatchObject({ code: 'CLI_COMMAND_FORBIDDEN' });
    } finally {
      client.close();
    }
  });

  it('surfaces runtime typed errors with codes over the wire', async () => {
    const { server } = await harness(() => undefined);
    const client = await connectPipe(server.status.pipePath, 'Nexus');
    try {
      await expect(
        client.request('runs:status', { runId: 'run_01K7777777777777777777A8W9' }),
      ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    } finally {
      client.close();
    }
  });
});
