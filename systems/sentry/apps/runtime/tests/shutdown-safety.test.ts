import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunCoordinator } from '@qa/run-engine';
import { createProjectId } from '@qa/shared';
import { PassThrough } from 'node:stream';
import { SentryRuntimeHost, serveStdio } from '../src/runtime.js';

it('refuses shutdown while a run is pending, including before row creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentry-shutdown-'));
  const host = new SentryRuntimeHost(root, () => undefined);
  let release!: (error: Error) => void;
  const run = vi.spyOn(RunCoordinator.prototype, 'run').mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        release = reject;
      }),
  );
  const pending = host.startRun(createProjectId(), { mode: 'full' });
  void pending.catch(() => undefined);
  try {
    await expect(host.dispatch('runtime.shutdown', {})).rejects.toMatchObject({
      code: 'RUNTIME_BUSY',
    });
    expect(host.hello()).toMatchObject({ runtimeVersion: '1.0.2' });
  } finally {
    release(new Error('fixture cancelled before row creation'));
    await pending.catch(() => undefined);
    run.mockRestore();
    await expect(host.dispatch('runtime.shutdown', {})).resolves.toEqual({ shuttingDown: true });
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the stdio host alive when another request is in flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentry-rpc-shutdown-'));
  const input = new PassThrough();
  const output = new PassThrough();
  const exit = vi.fn();
  let received = '';
  output.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });
  const serving = serveStdio({
    dataRoot: root,
    input: input as never,
    output: output as never,
    onExit: exit,
    onStderr: () => undefined,
  });
  const frame = (id: string, method: string) =>
    JSON.stringify({ type: 'request', id, method, params: {} }) + '\n';
  try {
    input.write(frame('hello', 'runtime.hello') + frame('busy-stop', 'runtime.shutdown'));
    const deadline = Date.now() + 10000;
    while (!received.includes('RUNTIME_REQUESTS_BUSY') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toContain('RUNTIME_REQUESTS_BUSY');
    expect(exit).not.toHaveBeenCalled();
    input.write(frame('idle-stop', 'runtime.shutdown'));
    await serving;
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(0);
    expect(received).toContain('"shuttingDown":true');
  } finally {
    input.end();
    await serving;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
