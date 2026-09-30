import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@qa/runtime-protocol';
import {
  buildNativeArgs,
  NativeLinuxRuntimeClient,
} from '../../src/main/platform/linux/native-linux-runtime-client.js';
import type { RuntimeHello } from '../../src/main/runtime/runtime-client.js';

/** Capture the effective native spawn without launching anything real. */
const spawnCell = vi.hoisted(() => ({
  last: undefined as { command: string; args: readonly string[] } | undefined,
  child: undefined as unknown,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[]) => {
      spawnCell.last = { command, args };
      return spawnCell.child;
    },
  };
});

class FakeNativeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  killed = false;
  onWrite: ((line: string) => void) | undefined;
  readonly stdin = {
    write: (line: string): boolean => {
      const text = String(line);
      this.stdinWrites.push(text);
      this.onWrite?.(text);
      return true;
    },
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const NODE = '/usr/bin/node';
const ENTRY = '/home/test/.local/share/sentry/runtime/current/apps/runtime/dist/host.js';

const NATIVE_HELLO: RuntimeHello = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  runtimeVersion: 'test-0.0.0',
  platform: 'linux',
  isWsl: false,
  isElectron: false,
  nodeVersion: 'v22.0.0',
  processExecPath: '/usr/bin/node',
  dataRoot: '/home/test/.local/share/sentry',
};

function installResponder(fake: FakeNativeChild, hello: RuntimeHello = NATIVE_HELLO): void {
  fake.onWrite = (line) => {
    const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
    if (parsed.method === 'runtime.hello' && typeof parsed.id === 'string') {
      const id = parsed.id;
      queueMicrotask(() => {
        fake.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({ type: 'response', id, ok: true, result: hello }) + '\n',
            'utf8',
          ),
        );
      });
    }
    if (parsed.method === 'runtime.shutdown') {
      queueMicrotask(() => {
        fake.emit('exit', 0);
      });
    }
  };
}

beforeEach(() => {
  spawnCell.last = undefined;
  spawnCell.child = undefined;
});

describe('native linux runtime launch', () => {
  it('builds the stdio argv without a data root', () => {
    expect(buildNativeArgs(ENTRY)).toEqual([ENTRY, '--stdio']);
  });

  it('forwards --data-root when configured', () => {
    expect(buildNativeArgs(ENTRY, '/home/test/.data')).toEqual([
      ENTRY,
      '--stdio',
      '--data-root',
      '/home/test/.data',
    ]);
  });

  it('spawns standalone Node with the entry — never wsl.exe, never a shell', async () => {
    const fake = new FakeNativeChild();
    installResponder(fake);
    spawnCell.child = fake;
    const client = new NativeLinuxRuntimeClient({ nodeExecutable: NODE, runtimeEntry: ENTRY });
    const hello = await client.start();
    expect(spawnCell.last?.command).toBe(NODE);
    expect(spawnCell.last?.command).not.toContain('wsl');
    expect(spawnCell.last?.command).not.toContain('electron');
    expect(spawnCell.last?.command).not.toContain('sh');
    expect(spawnCell.last?.args).toEqual([ENTRY, '--stdio']);
    expect(hello.platform).toBe('linux');
    expect(hello.isWsl).toBe(false);
    expect(client.status).toMatchObject({
      connected: true,
      hostPlatform: 'linux',
      executionMode: 'native-linux',
    });
    await client.stop();
  });

  it('passes --data-root through to the spawned runtime', async () => {
    const fake = new FakeNativeChild();
    installResponder(fake);
    spawnCell.child = fake;
    const client = new NativeLinuxRuntimeClient({
      nodeExecutable: NODE,
      runtimeEntry: ENTRY,
      dataRoot: '/home/test/.data',
    });
    await client.start();
    expect(spawnCell.last?.command).toBe(NODE);
    expect(spawnCell.last?.args).toEqual([ENTRY, '--stdio', '--data-root', '/home/test/.data']);
    await client.stop();
  });

  it('reports the native distribution in status', async () => {
    const fake = new FakeNativeChild();
    installResponder(fake);
    const client = new NativeLinuxRuntimeClient({
      nodeExecutable: NODE,
      runtimeEntry: ENTRY,
      distribution: { id: 'cachyos', prettyName: 'CachyOS' },
      launcher: () => fake as unknown as ChildProcess,
    });
    await client.start();
    expect(client.status.distribution).toEqual({ id: 'cachyos', prettyName: 'CachyOS' });
    expect(client.status.distro).toBeUndefined();
    await client.stop();
  });

  it('fails closed with the native offline error before start', async () => {
    const client = new NativeLinuxRuntimeClient({ nodeExecutable: NODE, runtimeEntry: ENTRY });
    const failure = await client.request('system.info').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'RUNTIME_OFFLINE' });
    if (!(failure instanceof Error)) throw new Error('expected an Error');
    expect(failure.message).toContain('Native runtime unavailable');
  });

  it('reports native spawn failures without wsl text', async () => {
    const fake = new FakeNativeChild();
    const client = new NativeLinuxRuntimeClient({
      nodeExecutable: NODE,
      runtimeEntry: ENTRY,
      launcher: () => fake as unknown as ChildProcess,
    });
    const starting = client.start();
    fake.emit('error', new Error('boom'));
    await expect(starting).rejects.toThrow('Native runtime spawn failed: boom');
  });

  it('completes the native handshake over the shared transport', async () => {
    const fake = new FakeNativeChild();
    installResponder(fake);
    const client = new NativeLinuxRuntimeClient({
      nodeExecutable: NODE,
      runtimeEntry: ENTRY,
      launcher: () => fake as unknown as ChildProcess,
    });
    const seen: Array<{ event: string; payload: unknown }> = [];
    client.onNotification((event, payload) => {
      seen.push({ event, payload });
    });
    const hello = await client.start();
    expect(hello).toMatchObject({ platform: 'linux', isWsl: false, isElectron: false });
    fake.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'notification', event: 'activeRuns.updated' }) + '\n',
        'utf8',
      ),
    );
    expect(seen).toEqual([{ event: 'activeRuns.updated', payload: undefined }]);
    await client.stop();
    expect(fake.killed).toBe(false);
    expect(client.status.connected).toBe(false);
  });
});
