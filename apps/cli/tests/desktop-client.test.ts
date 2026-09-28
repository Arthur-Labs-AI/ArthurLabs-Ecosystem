import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopNotRunningError, SentryDesktopClient } from '../src/desktop-client.js';

const brokers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((close) => close()));
});

function brokerPipe(): string {
  if (process.platform === 'win32')
    return '\\\\.\\pipe\\sentry-client-test-' + process.pid + '-' + Math.floor(Math.random() * 1e6);
  return join(
    tmpdir(),
    'sentry-client-test-' + process.pid + '-' + Math.floor(Math.random() * 1e6) + '.sock',
  );
}

async function startRawBroker(
  onLine: (line: string, send: (frame: unknown) => void, sendRaw: (bytes: Buffer) => void) => void,
): Promise<{ pipePath: string; seenNames: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-raw-broker-'));
  const pipePath = process.platform === 'win32' ? brokerPipe() : join(dir, 'broker.sock');
  const seenNames: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) {
          const frame = JSON.parse(line) as { client?: { name?: string } };
          if (typeof frame.client?.name === 'string') seenNames.push(frame.client.name);
          onLine(
            line,
            (response: unknown) => socket.write(JSON.stringify(response) + '\n'),
            (bytes: Buffer) => socket.write(bytes),
          );
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
  brokers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { pipePath, seenNames };
}
describe('sentry desktop client', () => {
  it('handshakes and resolves typed requests', async () => {
    const { pipePath } = await startRawBroker((line, send) => {
      const frame = JSON.parse(line) as { type?: string; id?: string };
      if (frame.type === 'hello')
        send({ type: 'welcome', protocolVersion: 1, product: { name: 'Sentry', version: 'test' } });
      else send({ type: 'response', id: frame.id, ok: true, result: { projects: [] } });
    });
    const client = new SentryDesktopClient({ pipePath, clientName: 'Sentry CLI', timeoutMs: 5000 });
    await client.connect();
    await expect(client.request('projects:list', {})).resolves.toEqual({ projects: [] });
    await client.close();
  });

  it('identifies Nexus name and version during the handshake', async () => {
    let helloClient: unknown;
    const { pipePath, seenNames } = await startRawBroker((line, send) => {
      const frame = JSON.parse(line) as { type?: string; client?: unknown };
      if (frame.type === 'hello') helloClient = frame.client;
      send({ type: 'welcome', protocolVersion: 1, product: { name: 'Sentry', version: 'test' } });
    });
    const previousName = process.env['SENTRY_CLI_CLIENT_NAME'];
    const previousVersion = process.env['SENTRY_CLI_CLIENT_VERSION'];
    process.env['SENTRY_CLI_CLIENT_NAME'] = 'Nexus';
    process.env['SENTRY_CLI_CLIENT_VERSION'] = '0.1.0';
    try {
      const client = new SentryDesktopClient({ pipePath, timeoutMs: 5000 });
      await client.connect();
      await client.close();
      expect(seenNames).toEqual(['Nexus']);
      expect(helloClient).toMatchObject({ type: 'cli', name: 'Nexus', version: '0.1.0' });
    } finally {
      if (previousName === undefined) delete process.env['SENTRY_CLI_CLIENT_NAME'];
      else process.env['SENTRY_CLI_CLIENT_NAME'] = previousName;
      if (previousVersion === undefined) delete process.env['SENTRY_CLI_CLIENT_VERSION'];
      else process.env['SENTRY_CLI_CLIENT_VERSION'] = previousVersion;
    }
  });

  it('rejects a broker line that exceeds the byte bound', async () => {
    const { pipePath } = await startRawBroker((line, send) => {
      const frame = JSON.parse(line) as { type?: string; id?: string };
      if (frame.type === 'hello') {
        send({ type: 'welcome', protocolVersion: 1 });
        return;
      }
      // 20 emoji add 20 chars but 80 UTF-8 bytes: the complete line is
      // ~80 chars (under a 128-char comparison) but ~140 bytes (over the
      // 128-byte bound), proving byte enforcement.
      send({ type: 'response', id: frame.id, ok: true, result: { note: '😀'.repeat(20) } });
    });
    const client = new SentryDesktopClient({
      pipePath,
      timeoutMs: 5000,
      limits: { maxLineBytes: 32, maxResponseBytes: 128 },
    });
    await client.connect();
    await expect(client.request('runs:status', { runId: 'run_x' })).rejects.toMatchObject({
      code: 'MESSAGE_TOO_LARGE',
    });
    await client.close();
  });

  it('reassembles a broker response split mid-Cyrillic across writes', async () => {
    const { pipePath } = await startRawBroker((line, _send, sendRaw) => {
      const frame = JSON.parse(line) as { type?: string; id?: string };
      if (frame.type === 'hello') {
        sendRaw(
          Buffer.from(JSON.stringify({ type: 'welcome', protocolVersion: 1 }) + '\n', 'utf8'),
        );
        return;
      }
      const response = Buffer.from(
        JSON.stringify({ type: 'response', id: frame.id, ok: true, result: { note: 'Проверка' } }) +
          '\n',
        'utf8',
      );
      const cut = response.indexOf(Buffer.from([0xd0]));
      sendRaw(response.subarray(0, cut + 1));
      setTimeout(() => sendRaw(response.subarray(cut + 1)), 20);
    });
    const client = new SentryDesktopClient({ pipePath, timeoutMs: 5000 });
    await client.connect();
    await expect(client.request('runs:status', {})).resolves.toEqual({ note: 'Проверка' });
    await client.close();
  });

  it('maps a missing pipe to desktop-not-running', async () => {
    const missing =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\sentry-client-missing-' + process.pid
        : join(tmpdir(), 'sentry-client-missing-' + process.pid + '.sock');
    const client = new SentryDesktopClient({ pipePath: missing, timeoutMs: 2000 });
    await expect(client.connect()).rejects.toBeInstanceOf(DesktopNotRunningError);
  });
});
