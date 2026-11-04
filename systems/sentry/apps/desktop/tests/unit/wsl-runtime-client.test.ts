import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@qa/runtime-protocol';
import {
  buildWslArgs,
  WslRuntimeClient,
  WslRuntimeManager,
} from '../../src/main/services/wsl-runtime-client.js';
import type { RuntimeHello } from '../../src/main/runtime/runtime-client.js';

/** Capture the effective wsl.exe invocation without spawning anything real. */
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

/** Fake WSL child: records stdin, emits stdout/stderr/exit on demand. */
class FakeWslChild extends EventEmitter {
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

const ENTRY = '/home/test/.local/share/sentry/runtime/current/apps/runtime/dist/host.js';

const TEST_HELLO: RuntimeHello = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  runtimeVersion: 'test-0.0.0',
  platform: 'linux',
  isWsl: true,
  nodeVersion: 'v22.0.0',
  processExecPath: '/usr/bin/node',
  distro: 'Ubuntu',
  dataRoot: '/home/test/.local/share/sentry',
};

function installResponder(fake: FakeWslChild): void {
  fake.onWrite = (line) => {
    const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
    if (parsed.method === 'runtime.hello' && typeof parsed.id === 'string') {
      const id = parsed.id;
      queueMicrotask(() => {
        fake.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({ type: 'response', id, ok: true, result: TEST_HELLO }) + '\n',
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

describe('wsl runtime launch', () => {
  it('builds the stdio argv without a data root', () => {
    expect(buildWslArgs('Ubuntu', ENTRY)).toEqual(['-d', 'Ubuntu', '--', 'node', ENTRY, '--stdio']);
  });

  it('forwards --data-root when configured', () => {
    expect(buildWslArgs('Ubuntu', ENTRY, '/home/test/.data')).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'node',
      ENTRY,
      '--stdio',
      '--data-root',
      '/home/test/.data',
    ]);
  });

  it('spawns wsl.exe with the distro and runtime entry', async () => {
    const fake = new FakeWslChild();
    installResponder(fake);
    spawnCell.child = fake;
    const client = new WslRuntimeClient({ distro: 'Ubuntu', runtimeEntry: ENTRY });
    const hello = await client.start();
    expect(spawnCell.last?.command).toBe('wsl.exe');
    expect(spawnCell.last?.args).toEqual(['-d', 'Ubuntu', '--', 'node', ENTRY, '--stdio']);
    expect(hello.platform).toBe('linux');
    expect(client.status).toMatchObject({ connected: true, distro: 'Ubuntu' });
    await client.stop();
  });

  it('passes --data-root through to the spawned runtime', async () => {
    const fake = new FakeWslChild();
    installResponder(fake);
    spawnCell.child = fake;
    const client = new WslRuntimeClient({
      distro: 'Ubuntu',
      runtimeEntry: ENTRY,
      dataRoot: '/home/test/.data',
    });
    await client.start();
    expect(spawnCell.last?.command).toBe('wsl.exe');
    expect(spawnCell.last?.args).toEqual([
      '-d',
      'Ubuntu',
      '--',
      'node',
      ENTRY,
      '--stdio',
      '--data-root',
      '/home/test/.data',
    ]);
    await client.stop();
  });

  it('fails closed with the WSL offline error before start', async () => {
    const client = new WslRuntimeClient({ distro: 'Ubuntu', runtimeEntry: ENTRY });
    const failure = await client.request('system.info').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'RUNTIME_OFFLINE' });
    if (!(failure instanceof Error)) throw new Error('expected an Error');
    expect(failure.message).toContain('WSL runtime unavailable');
    expect(spawnCell.last).toBeUndefined();
    expect(client.status.connected).toBe(false);
  });

  it('reports wsl.exe spawn failures with WSL-specific text', async () => {
    const fake = new FakeWslChild();
    const client = new WslRuntimeClient({
      distro: 'Ubuntu',
      runtimeEntry: ENTRY,
      launcher: () => fake as unknown as ChildProcess,
    });
    const exits: Array<number | null> = [];
    client.onExit((code) => {
      exits.push(code);
    });
    const starting = client.start();
    fake.emit('error', new Error('boom'));
    await expect(starting).rejects.toThrow('wsl.exe spawn failed: boom');
    expect(client.status.lastError).toContain('wsl.exe spawn failed: ');
    expect(exits).toEqual([null]);
  });
});

describe('wsl runtime manager', () => {
  it('persists the distro preference round-trip', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'sentry-wsl-pref-'));
    try {
      const manager = new WslRuntimeManager({ userDataDir: dir });
      await manager.savePreferredDistro('Ubuntu');
      await expect(manager.loadPreferredDistro()).resolves.toBe('Ubuntu');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
