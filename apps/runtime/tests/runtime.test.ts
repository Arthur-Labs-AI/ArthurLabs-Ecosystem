import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@qa/runtime-protocol';
import { SentryRuntimeHost, serveStdio } from '../src/runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

async function tempDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sentry-runtime-test-'));
  roots.push(root);
  return join(root, 'data');
}

describe('runtime host identity', () => {
  it('handshake reports platform and a non-electron node host', async () => {
    const host = new SentryRuntimeHost(await tempDataRoot(), () => undefined);
    try {
      await host.recover();
      const hello = host.hello() as {
        protocolVersion: number;
        platform: string;
        processExecPath: string;
        nodeVersion: string;
      };
      expect(hello.protocolVersion).toBe(RUNTIME_PROTOCOL_VERSION);
      expect(hello.platform).toBe(process.platform);
      expect(hello.processExecPath.toLowerCase().endsWith('electron.exe')).toBe(false);
      expect(hello.nodeVersion).toBe(process.version);
    } finally {
      host.close();
    }
  });

  it('configure stores models and secrets in memory only (no persistence)', async () => {
    const host = new SentryRuntimeHost(await tempDataRoot(), () => undefined);
    try {
      await host.recover();
      await host.configure({
        models: { deepseek: 'deepseek-flash' },
        providers: { deepseekApiKey: 'sk-test-fake-secret' },
      });
      expect(process.env['SENTRY_DEEPSEEK_MODEL']).toBe('deepseek-flash');
      expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-test-fake-secret');
      const gate = (await host.productionReadiness(['stack_deepseek_main'])) as { ready: boolean };
      expect(gate.ready).toBe(true);
    } finally {
      delete process.env['SENTRY_DEEPSEEK_MODEL'];
      delete process.env['DEEPSEEK_API_KEY'];
      host.close();
    }
  });

  it('rejects unknown methods with UNKNOWN_METHOD', async () => {
    const host = new SentryRuntimeHost(await tempDataRoot(), () => undefined);
    try {
      await host.recover();
      await expect(host.dispatch('nope.unknown', {})).rejects.toMatchObject({
        code: 'UNKNOWN_METHOD',
      });
    } finally {
      host.close();
    }
  });
});

describe('stdio RPC loop', () => {
  it('serves hello over stdio with stdout protocol-only', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: string[] = [];
    const dataRoot = await tempDataRoot();
    const serving = serveStdio({
      dataRoot,
      input: input as never,
      output: output as never,
      onStderr: (message: string) => {
        errors.push(message);
      },
      onExit: () => undefined,
    });
    let received = '';
    output.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    input.write(
      JSON.stringify({ type: 'request', id: 'rpc_1', method: 'runtime.hello', params: {} }) + '\n',
    );
    const deadline = Date.now() + 15000;
    while (!received.includes('"rpc_1"') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(received).toContain('"rpc_1"');
    expect(received).toContain('"ok":true');
    input.write(
      JSON.stringify({ type: 'request', id: 'rpc_2', method: 'runtime.shutdown', params: {} }) +
        '\n',
    );
    await serving;
    for (const line of received.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      expect(() => JSON.parse(trimmed)).not.toThrow();
    }
    expect(errors.join('\n')).not.toContain('DEEPSEEK_API_KEY');
  }, 30000);

  it('responds with structured errors to malformed input without dying', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const dataRoot = await tempDataRoot();
    const serving = serveStdio({
      dataRoot,
      input: input as never,
      output: output as never,
      onStderr: () => undefined,
      onExit: () => undefined,
    });
    let received = '';
    output.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    input.write('{not json\n');
    input.write(
      JSON.stringify({ type: 'request', id: 'rpc_9', method: 'system.info', params: {} }) + '\n',
    );
    const deadline = Date.now() + 15000;
    while (!received.includes('"rpc_9"') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(received).toContain('"rpc_9"');
    input.write(
      JSON.stringify({ type: 'request', id: 'rpc_10', method: 'runtime.shutdown', params: {} }) +
        '\n',
    );
    await serving;
  }, 30000);
});
