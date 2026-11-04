import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryCliServer } from '../../src/main/cli-server.js';

const servers: SentryCliServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function pipePath(tag: string): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\sentry-test-' + tag + '-' + process.pid;
  return join(tmpdir(), 'sentry-test-' + tag + '-' + process.pid + '.sock');
}

interface TestClient {
  readonly socket: Socket;
  nextLine(timeoutMs?: number): Promise<string>;
  send(frame: unknown): void;
  sendRaw(text: string): void;
  sendBytes(bytes: Buffer): void;
  close(): void;
}

async function connect(pipe: string): Promise<TestClient> {
  const socket = createConnection(pipe);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  let buffer = '';
  const waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  const pending: string[] = [];
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else pending.push(line);
      index = buffer.indexOf('\n');
    }
  });
  return {
    socket,
    nextLine: (timeoutMs = 5000) => {
      const queued = pending.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for broker line')),
          timeoutMs,
        );
        waiters.push({ resolve, reject, timer });
      });
    },
    send: (frame: unknown) => {
      socket.write(JSON.stringify(frame) + '\n');
    },
    sendRaw: (text: string) => {
      socket.write(text);
    },
    sendBytes: (bytes: Buffer) => {
      socket.write(bytes);
    },
    close: () => {
      socket.destroy();
    },
  };
}

async function startServer(
  tag: string,
  dispatch?: (command: string, payload: Record<string, unknown>) => Promise<unknown>,
  logs?: string[],
): Promise<SentryCliServer> {
  const server = new SentryCliServer({
    pipePath: pipePath(tag),
    dispatch: dispatch ?? (async () => ({ ok: true })),
    logger: (message) => {
      logs?.push(message);
    },
  });
  servers.push(server);
  await server.start();
  return server;
}

async function hello(client: TestClient, name = 'Nexus'): Promise<Record<string, unknown>> {
  client.send({ type: 'hello', protocolVersion: 1, client: { type: 'cli', name } });
  return JSON.parse(await client.nextLine()) as Record<string, unknown>;
}
describe('sentry CLI broker', () => {
  it('starts and reports CLI started with no clients', async () => {
    const server = await startServer('started');
    expect(server.status.started).toBe(true);
    expect(server.status.connectedClients).toEqual([]);
    expect(server.status.error).toBeUndefined();
  });

  it('completes the hello handshake and captures the declared client name', async () => {
    const server = await startServer('hello');
    const client = await connect(server.status.pipePath);
    try {
      const welcome = await hello(client, 'Nexus');
      expect(welcome['type']).toBe('welcome');
      expect(welcome['protocolVersion']).toBe(1);
      expect(server.status.connectedClients.map((c) => c.name)).toEqual(['Nexus']);
    } finally {
      client.close();
    }
  });

  it('rejects protocol-version mismatches without tracking the client', async () => {
    const server = await startServer('version');
    const client = await connect(server.status.pipePath);
    try {
      client.send({ type: 'hello', protocolVersion: 999, client: { type: 'cli', name: 'Nexus' } });
      const frame = JSON.parse(await client.nextLine()) as { code?: string };
      expect(frame['code']).toBe('PROTOCOL_VERSION_MISMATCH');
      expect(server.status.connectedClients).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('rejects malformed JSON safely', async () => {
    const server = await startServer('malformed');
    const client = await connect(server.status.pipePath);
    try {
      client.sendRaw('this is not json\n');
      const frame = JSON.parse(await client.nextLine()) as { code?: string };
      expect(frame['code']).toBe('MALFORMED_JSON');
    } finally {
      client.close();
    }
  });

  it('dispatches known commands and surfaces router errors with codes', async () => {
    const seen: string[] = [];
    const server = await startServer('dispatch', async (command) => {
      seen.push(command);
      if (command === 'projects:list') return [{ projectId: 'proj_1' }];
      throw Object.assign(new Error('Unknown command: ' + command), {
        code: 'IPC_UNKNOWN_CHANNEL',
      });
    });
    const client = await connect(server.status.pipePath);
    try {
      await hello(client);
      client.send({ type: 'request', id: 'r1', command: 'projects:list', payload: {} });
      const ok = JSON.parse(await client.nextLine()) as { ok: boolean; result?: unknown };
      expect(ok.ok).toBe(true);
      expect(ok.result).toEqual([{ projectId: 'proj_1' }]);
      client.send({ type: 'request', id: 'r2', command: 'nope:missing', payload: {} });
      const failed = JSON.parse(await client.nextLine()) as {
        ok: boolean;
        error?: { code?: string };
      };
      expect(failed.ok).toBe(false);
      expect(failed.error?.code).toBe('IPC_UNKNOWN_CHANNEL');
      expect(seen).toEqual(['projects:list', 'nope:missing']);
    } finally {
      client.close();
    }
  });

  it('cleans up client tracking on disconnect and serves sequential clients', async () => {
    const server = await startServer('sequential');
    const first = await connect(server.status.pipePath);
    await hello(first, 'Nexus');
    expect(server.status.connectedClients).toHaveLength(1);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.status.connectedClients).toEqual([]);
    const second = await connect(server.status.pipePath);
    try {
      const welcome = await hello(second, 'Sentry CLI');
      expect(welcome['type']).toBe('welcome');
      expect(server.status.connectedClients.map((c) => c.name)).toEqual(['Sentry CLI']);
    } finally {
      second.close();
    }
  });

  it('ignores untrusted extra identity fields and rejects nameless hellos', async () => {
    const server = await startServer('identity');
    const client = await connect(server.status.pipePath);
    try {
      client.send({
        type: 'hello',
        protocolVersion: 1,
        client: { type: 'cli', name: 'Nexus', admin: true, role: 'owner' },
      });
      await client.nextLine();
      const tracked = server.status.connectedClients[0];
      expect(tracked?.name).toBe('Nexus');
      expect(tracked as unknown as Record<string, unknown>).not.toHaveProperty('admin');
    } finally {
      client.close();
    }
    const nameless = await connect(server.status.pipePath);
    try {
      nameless.send({ type: 'hello', protocolVersion: 1, client: { type: 'cli' } });
      const frame = JSON.parse(await nameless.nextLine()) as { code?: string };
      expect(frame['code']).toBe('MALFORMED_MESSAGE');
    } finally {
      nameless.close();
    }
  });

  it('never logs secret-shaped values from payloads', async () => {
    const logs: string[] = [];
    const server = await startServer('secrets', async () => ({ ok: true }), logs);
    const client = await connect(server.status.pipePath);
    try {
      await hello(client);
      client.send({
        type: 'request',
        id: 's1',
        command: 'providers:status',
        payload: { probe: 'DEEPSEEK_API_KEY=hunter2-secret' },
      });
      await client.nextLine();
      expect(logs.join('\n')).not.toContain('hunter2');
    } finally {
      client.close();
    }
  });

  it('lets dispatched work continue after the client disconnects', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const server = await startServer('persist', async () => {
      await gate;
      settled = true;
      return { runId: 'run_01K7777777777777777777A8W1' };
    });
    const client = await connect(server.status.pipePath);
    await hello(client);
    client.send({ type: 'request', id: 'r1', command: 'runs:start', payload: {} });
    client.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(true);
    expect(server.status.started).toBe(true);
  });

  it('reassembles a handshake split mid-emoji across TCP chunks', async () => {
    const server = await startServer('split');
    const client = await connect(server.status.pipePath);
    try {
      const frame = JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        client: { type: 'cli', name: 'Nexus 😀' },
      });
      const bytes = Buffer.from(frame + '\n', 'utf8');
      const emojiAt = bytes.indexOf(Buffer.from([0xf0]));
      client.sendBytes(bytes.subarray(0, emojiAt + 2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      client.sendBytes(bytes.subarray(emojiAt + 2));
      const welcome = JSON.parse(await client.nextLine()) as { type?: string };
      expect(welcome.type).toBe('welcome');
      expect(server.status.connectedClients.map((c) => c.name)).toEqual(['Nexus 😀']);
    } finally {
      client.close();
    }
  });

  it('fails safely when no Desktop owns the pipe', async () => {
    const missing = pipePath('nothing-listening');
    await expect(connect(missing)).rejects.toThrow();
  });

  it('enforces line limits in UTF-8 bytes, not JS character count', async () => {
    const server = new SentryCliServer({
      pipePath: pipePath('bytes'),
      dispatch: async () => ({ ok: true }),
      limits: { maxLineBytes: 128, maxRequestBytes: 128, maxResponseBytes: 4096 },
    });
    servers.push(server);
    await server.start();
    const client = await connect(server.status.pipePath);
    try {
      await hello(client);
      // 30 chars of two-byte text: 105 JS chars but 135 UTF-8 bytes.
      // A .length comparison would admit this line; the byte bound rejects it.
      const wide = 'é'.repeat(30);
      const line = JSON.stringify({
        type: 'request',
        id: 'r1',
        command: 'runs:status',
        payload: { note: wide },
      });
      expect(line.length).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(128);
      client.sendRaw(line + '\n');
      const frame = JSON.parse(await client.nextLine()) as { code?: string };
      expect(frame['code']).toBe('MESSAGE_TOO_LARGE');
    } finally {
      client.close();
    }
  });
});
