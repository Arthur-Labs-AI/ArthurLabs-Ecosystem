import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@qa/runtime-protocol';
import {
  STDIO_REQUEST_TIMEOUT_MS,
  STDIO_ROW_CREATION_TIMEOUT_MS,
  STDIO_SHUTDOWN_GRACE_MS,
  StdioRuntimeClient,
  resolveRequestTimeout,
} from '../../src/main/runtime/stdio-runtime-client.js';
import type { RuntimeHello } from '../../src/main/runtime/runtime-client.js';

/**
 * Generic transport tests: the stdio client is driven through a fake
 * child-process seam (no WSL, no real spawn). Every behavior here must
 * hold for any future launcher that reuses this transport.
 */
class FakeChild extends EventEmitter {
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

function asChild(fake: FakeChild): ChildProcess {
  return fake as unknown as ChildProcess;
}

const TEST_HELLO: RuntimeHello = {
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  runtimeVersion: 'test-0.0.0',
  platform: 'linux',
  isWsl: false,
  isElectron: false,
  nodeVersion: 'v22.0.0',
  processExecPath: '/usr/bin/node',
  dataRoot: '/tmp/sentry-test-data',
};

function helloLine(id: string, hello: RuntimeHello = TEST_HELLO): string {
  return JSON.stringify({ type: 'response', id, ok: true, result: hello }) + '\n';
}

function lastSentId(fake: FakeChild): string {
  const raw = fake.stdinWrites.at(-1);
  if (raw === undefined) throw new Error('expected a sent request line');
  const parsed = JSON.parse(raw) as { id?: unknown };
  if (typeof parsed.id !== 'string') throw new Error('sent line has no request id');
  return parsed.id;
}

/**
 * Auto-answer runtime.hello (and runtime.shutdown when asked) the way a
 * healthy runtime host would, so start()/stop() settle deterministically.
 */
function installResponder(fake: FakeChild, hello: RuntimeHello = TEST_HELLO): void {
  fake.onWrite = (line) => {
    const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
    if (parsed.method === 'runtime.hello' && typeof parsed.id === 'string') {
      const id = parsed.id;
      queueMicrotask(() => {
        fake.stdout.emit('data', Buffer.from(helloLine(id, hello), 'utf8'));
      });
    }
    if (parsed.method === 'runtime.shutdown') {
      queueMicrotask(() => {
        fake.emit('exit', 0);
      });
    }
  };
}

async function launchStarted(
  hello: RuntimeHello = TEST_HELLO,
): Promise<{ client: StdioRuntimeClient; fake: FakeChild }> {
  let active: FakeChild | undefined;
  const client = new StdioRuntimeClient({
    launch: () => {
      const fake = new FakeChild();
      installResponder(fake, hello);
      active = fake;
      return asChild(fake);
    },
  });
  const started = await client.start();
  if (active === undefined) throw new Error('launcher did not produce a child');
  expect(started.platform).toBe(hello.platform);
  return { client, fake: active };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('stdio runtime transport', () => {
  it('retries transient request-busy refusal before detaching the runtime', async () => {
    const { client, fake } = await launchStarted();
    let refusals = 0;
    fake.onWrite = (line) => {
      const request = JSON.parse(line) as { id: string };
      queueMicrotask(() => {
        if (++refusals <= 2)
          fake.stdout.emit(
            'data',
            Buffer.from(
              JSON.stringify({
                type: 'response',
                id: request.id,
                ok: false,
                error: { code: 'RUNTIME_REQUESTS_BUSY', message: 'Wait' },
              }) + '\n',
            ),
          );
        else fake.emit('exit', 0);
      });
    };
    await client.stop();
    expect(refusals).toBe(3);
    expect(fake.killed).toBe(false);
    expect(client.status.connected).toBe(false);
  });
  it('preserves a busy runtime after refused shutdown without killing it', async () => {
    const { client, fake } = await launchStarted();
    vi.useFakeTimers();
    fake.onWrite = (line) => {
      const request = JSON.parse(line) as { id: string; method: string };
      queueMicrotask(() =>
        fake.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              type: 'response',
              id: request.id,
              ok: false,
              error: { code: 'RUNTIME_BUSY', message: 'Cancel active work first' },
            }) + '\n',
          ),
        ),
      );
    };
    const stopped = client.stop().then(
      () => 'stopped',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(STDIO_SHUTDOWN_GRACE_MS + 1);
    expect(await stopped).toMatchObject({ code: 'RUNTIME_BUSY' });
    expect(fake.killed).toBe(false);
    expect(client.status.connected).toBe(true);
    installResponder(fake);
    await client.stop();
  });
  it('fails closed with RUNTIME_OFFLINE before start', async () => {
    const client = new StdioRuntimeClient({
      launch: () => {
        throw new Error('must not launch');
      },
    });
    await expect(client.request('system.info')).rejects.toMatchObject({
      code: 'RUNTIME_OFFLINE',
    });
    expect(client.status.connected).toBe(false);
  });

  it('correlates concurrent responses out of order', async () => {
    const { client, fake } = await launchStarted();
    try {
      const first = client.request('runs.list', {}, 5000);
      const second = client.request('system.info', {}, 5000);
      const ids = fake.stdinWrites.slice(-2).map((line) => (JSON.parse(line) as { id: string }).id);
      const firstId = ids[0];
      const secondId = ids[1];
      if (firstId === undefined || secondId === undefined) {
        throw new Error('expected two sent request ids');
      }
      fake.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'response', id: secondId, ok: true, result: { info: 2 } }) + '\n',
          'utf8',
        ),
      );
      fake.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'response', id: firstId, ok: true, result: { runs: [] } }) + '\n',
          'utf8',
        ),
      );
      await expect(second).resolves.toEqual({ info: 2 });
      await expect(first).resolves.toEqual({ runs: [] });
    } finally {
      await client.stop();
    }
  });

  it('delivers runtime notifications to the registered handler', async () => {
    const { client, fake } = await launchStarted();
    try {
      const seen: Array<{ event: string; payload: unknown }> = [];
      client.onNotification((event, payload) => {
        seen.push({ event, payload });
      });
      fake.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            type: 'notification',
            event: 'run.snapshot',
            payload: { runId: 'run_01K7777777777777777777A8W1' },
          }) + '\n',
          'utf8',
        ),
      );
      expect(seen).toEqual([
        { event: 'run.snapshot', payload: { runId: 'run_01K7777777777777777777A8W1' } },
      ]);
    } finally {
      await client.stop();
    }
  });

  it('reassembles a response split mid-codepoint across chunks', async () => {
    const { client, fake } = await launchStarted();
    try {
      const pending = client.request('runs.list', {}, 5000);
      const sentId = lastSentId(fake);
      const full =
        JSON.stringify({
          type: 'response',
          id: sentId,
          ok: true,
          result: { text: 'hello \uD83D\uDE00 world' },
        }) + '\n';
      const bytes = Buffer.from(full, 'utf8');
      const emojiAt = bytes.indexOf(Buffer.from('\uD83D\uDE00', 'utf8'));
      expect(emojiAt).toBeGreaterThan(0);
      fake.stdout.emit('data', bytes.subarray(0, emojiAt + 1));
      fake.stdout.emit('data', bytes.subarray(emojiAt + 1));
      await expect(pending).resolves.toEqual({ text: 'hello \uD83D\uDE00 world' });
    } finally {
      await client.stop();
    }
  });

  it('fails exactly the oversized request instead of timing out', async () => {
    const { client, fake } = await launchStarted();
    try {
      const pending = client.request('runs.export', {}, 5000);
      const sentId = lastSentId(fake);
      const big = 'x'.repeat(9 * 1024 * 1024);
      const line = JSON.stringify({
        type: 'response',
        id: sentId,
        ok: true,
        result: { blob: big },
      });
      fake.stdout.emit('data', Buffer.from(line + '\n', 'utf8'));
      await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_MESSAGE_TOO_LARGE' });
    } finally {
      await client.stop();
    }
  });

  it('fails the transport when an oversize id cannot be recovered', async () => {
    const { client, fake } = await launchStarted();
    try {
      const first = client.request('runs.list', {}, 5000);
      const second = client.request('system.info', {}, 5000);
      fake.stdout.emit('data', Buffer.from('z'.repeat(9 * 1024 * 1024), 'utf8'));
      fake.stdout.emit('data', Buffer.from('zzz\n', 'utf8'));
      await expect(first).rejects.toMatchObject({ code: 'RUNTIME_MESSAGE_TOO_LARGE' });
      await expect(second).rejects.toMatchObject({ code: 'RUNTIME_MESSAGE_TOO_LARGE' });
    } finally {
      await client.stop();
    }
  });

  it('drops oversized notifications without harming healthy requests', async () => {
    const { client, fake } = await launchStarted();
    try {
      const pending = client.request('runs.list', {}, 5000);
      const sentId = lastSentId(fake);
      const big = 'y'.repeat(9 * 1024 * 1024);
      fake.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'notification', event: 'e', payload: { blob: big } }) + '\n',
          'utf8',
        ),
      );
      fake.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'response', id: sentId, ok: true, result: { runs: [] } }) + '\n',
          'utf8',
        ),
      );
      await expect(pending).resolves.toEqual({ runs: [] });
    } finally {
      await client.stop();
    }
  });

  it('rejects a normal request after its timeout', async () => {
    const { client } = await launchStarted();
    try {
      await expect(client.request('runs.list', {}, 30)).rejects.toMatchObject({
        code: 'RUNTIME_TIMEOUT',
      });
    } finally {
      await client.stop();
    }
  });

  it('selects the long timeout only for row-creation methods', () => {
    for (const method of ['runs.start', 'retests.start', 'projects.add', 'projects.update']) {
      expect(resolveRequestTimeout(method)).toBe(STDIO_ROW_CREATION_TIMEOUT_MS);
    }
    for (const method of ['runs.list', 'system.info', 'runtime.hello', 'projects.delete']) {
      expect(resolveRequestTimeout(method)).toBe(STDIO_REQUEST_TIMEOUT_MS);
    }
    expect(resolveRequestTimeout('runs.start', 25)).toBe(25);
    expect(STDIO_ROW_CREATION_TIMEOUT_MS).toBe(600_000);
  });

  it('rejects pending requests when the runtime exits', async () => {
    const { client, fake } = await launchStarted();
    const pending = client.request('runs.list', {}, 5000);
    fake.emit('exit', 1);
    await expect(pending).rejects.toThrow('Runtime exited');
    expect(client.status.connected).toBe(false);
    await client.stop();
  });

  it('rejects the handshake on protocol mismatch', async () => {
    await expect(launchStarted({ ...TEST_HELLO, protocolVersion: 999 })).rejects.toMatchObject({
      code: 'RUNTIME_PROTOCOL_MISMATCH',
    });
  });

  it('requires a Linux runtime platform', async () => {
    await expect(launchStarted({ ...TEST_HELLO, platform: 'win32' })).rejects.toMatchObject({
      code: 'RUNTIME_NOT_LINUX',
    });
  });

  it('rejects a legacy runtime under Electron via the executable path fallback', async () => {
    // Legacy runtimes omit isElectron: the execPath guard stays authoritative for them.
    await expect(
      launchStarted({
        ...TEST_HELLO,
        isElectron: undefined,
        processExecPath: 'C:\\host\\electron.exe',
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_UNDER_ELECTRON' });
  });

  it('shuts down gracefully without killing a cooperative runtime', async () => {
    const { client, fake } = await launchStarted();
    const writesBefore = fake.stdinWrites.length;
    await client.stop();
    expect(fake.killed).toBe(false);
    const shutdownLine = fake.stdinWrites.at(writesBefore);
    if (shutdownLine === undefined) throw new Error('expected a shutdown request');
    expect(JSON.parse(shutdownLine) as unknown).toMatchObject({
      type: 'request',
      method: 'runtime.shutdown',
    });
    expect(client.status.connected).toBe(false);
  });

  it('falls back to kill after a bounded wait when the runtime ignores shutdown', async () => {
    const fake = new FakeChild();
    fake.onWrite = (line) => {
      const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (parsed.method === 'runtime.hello' && typeof parsed.id === 'string') {
        const id = parsed.id;
        queueMicrotask(() => {
          fake.stdout.emit('data', Buffer.from(helloLine(id), 'utf8'));
        });
      }
      // runtime.shutdown is deliberately ignored: the client must kill.
    };
    const client = new StdioRuntimeClient({ launch: () => asChild(fake) });
    await client.start();
    vi.useFakeTimers();
    try {
      const stopping = client.stop();
      await vi.advanceTimersByTimeAsync(STDIO_SHUTDOWN_GRACE_MS);
      await stopping;
      expect(fake.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds stderr diagnostics in count and line length', async () => {
    const { client, fake } = await launchStarted();
    try {
      for (let index = 0; index < 60; index += 1) {
        fake.stderr.emit('data', Buffer.from('line ' + String(index) + '\n', 'utf8'));
      }
      expect(client.stderrDiagnostics).toHaveLength(50);
      expect(client.stderrDiagnostics[0]).toBe('line 10');
      fake.stderr.emit('data', Buffer.from('x'.repeat(600) + '\n', 'utf8'));
      const tail = client.stderrDiagnostics;
      const lastLine = tail[tail.length - 1];
      expect(lastLine?.length).toBe(500);
      expect(client.stderrDiagnostics).toHaveLength(50);
    } finally {
      await client.stop();
    }
  });

  it('returns the same hello on repeated start after connect', async () => {
    const { client } = await launchStarted();
    try {
      const first = await client.start();
      const second = await client.start();
      expect(second).toBe(first);
    } finally {
      await client.stop();
    }
  });

  it('rejects a second start while the handshake is in flight', async () => {
    const fake = new FakeChild();
    const client = new StdioRuntimeClient({ launch: () => asChild(fake) });
    const first = client.start();
    await expect(client.start()).rejects.toMatchObject({ code: 'RUNTIME_STARTING' });
    const sentId = lastSentId(fake);
    fake.stdout.emit('data', Buffer.from(helloLine(sentId), 'utf8'));
    const hello = await first;
    expect(hello.platform).toBe('linux');
    const stopping = client.stop();
    fake.emit('exit', 0);
    await stopping;
  });

  it('restarts cleanly after stop', async () => {
    const fakes: FakeChild[] = [];
    const client = new StdioRuntimeClient({
      launch: () => {
        const fake = new FakeChild();
        installResponder(fake);
        fakes.push(fake);
        return asChild(fake);
      },
    });
    const first = await client.start();
    await client.stop();
    const second = await client.start();
    expect(fakes.length).toBe(2);
    expect(second).toEqual(first);
    await client.stop();
  });

  it('carries no host launch knowledge in the generic transport', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main', 'runtime');
    const transport = await readFile(join(dir, 'stdio-runtime-client.ts'), 'utf8');
    const contracts = await readFile(join(dir, 'runtime-client.ts'), 'utf8');
    expect(transport).not.toContain('wsl');
    expect(transport).not.toContain('distro');
    // The contract names the execution modes ('wsl2' included) but must
    // never reference the WSL launcher executable itself.
    expect(contracts).not.toContain('wsl.exe');
  });
});

describe('stdio runtime reconnect lifecycle', () => {
  /**
   * Launcher yielding one fake child per start(). Index 0 is child A, index
   * 1 is child B, and so on. Every child answers runtime.hello; only children
   * accepted by exitOnShutdown exit when asked to shut down, so child A can
   * linger and emit late events after child B has taken over.
   */
  function sequenceClient(exitOnShutdown: (index: number) => boolean): {
    client: StdioRuntimeClient;
    fakes: FakeChild[];
  } {
    const fakes: FakeChild[] = [];
    const client = new StdioRuntimeClient({
      launch: () => {
        const index = fakes.length;
        const fake = new FakeChild();
        const shouldExit = exitOnShutdown(index);
        fake.onWrite = (line) => {
          const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
          if (parsed.method === 'runtime.hello' && typeof parsed.id === 'string') {
            const id = parsed.id;
            queueMicrotask(() => {
              fake.stdout.emit('data', Buffer.from(helloLine(id), 'utf8'));
            });
          }
          if (parsed.method === 'runtime.shutdown' && shouldExit) {
            queueMicrotask(() => {
              fake.emit('exit', 0);
            });
          }
        };
        fakes.push(fake);
        return asChild(fake);
      },
    });
    return { client, fakes };
  }

  function fakeAt(fakes: FakeChild[], index: number): FakeChild {
    const fake = fakes[index];
    if (fake === undefined) throw new Error('missing fake child ' + String(index));
    return fake;
  }

  /** Bounded watchdog: the reconnect handshake must settle in milliseconds. */
  function watchdog(ms: number): Promise<'timed-out'> {
    return new Promise((resolve) => {
      setTimeout(() => resolve('timed-out'), ms);
    });
  }

  /** Stop a child that ignores runtime.shutdown via the bounded kill fallback. */
  async function stopIgnoringShutdown(client: StdioRuntimeClient): Promise<void> {
    vi.useFakeTimers();
    try {
      const stopping = client.stop();
      await vi.advanceTimersByTimeAsync(STDIO_SHUTDOWN_GRACE_MS);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
  }

  function respond(fake: FakeChild, id: string, result: unknown): void {
    fake.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'response', id, ok: true, result }) + '\n', 'utf8'),
    );
  }

  it('does not let a stale partial frame poison the reconnect handshake', async () => {
    const { client, fakes } = sequenceClient(() => true);
    await client.start();
    const fakeA = fakeAt(fakes, 0);
    fakeA.stdout.emit('data', Buffer.from('{"type":"notification","event":', 'utf8'));
    fakeA.emit('exit', 1);
    const started = client.start();
    const outcome = await Promise.race([
      started.then((): 'connected' => 'connected'),
      watchdog(2000),
    ]);
    started.catch(() => undefined);
    expect(outcome).toBe('connected');
    expect(client.status.connected).toBe(true);
    await client.stop();
  });

  it('ignores a late exit from a replaced child', async () => {
    const { client, fakes } = sequenceClient((index) => index > 0);
    await client.start();
    const fakeA = fakeAt(fakes, 0);
    await stopIgnoringShutdown(client);
    expect(fakeA.killed).toBe(true);
    await client.start();
    const fakeB = fakeAt(fakes, 1);
    expect(client.status.connected).toBe(true);
    const exits: Array<number | null> = [];
    client.onExit((code) => {
      exits.push(code);
    });
    fakeA.emit('exit', 0);
    expect(client.status.connected).toBe(true);
    expect(client.status.hello?.platform).toBe('linux');
    expect(exits).toEqual([]);
    const pending = client.request('runs.list', {}, 5000);
    respond(fakeB, lastSentId(fakeB), { runs: [] });
    await expect(pending).resolves.toEqual({ runs: [] });
    await client.stop();
  });

  it('does not reject the new child requests on a stale exit', async () => {
    const { client, fakes } = sequenceClient((index) => index > 0);
    await client.start();
    const fakeA = fakeAt(fakes, 0);
    await stopIgnoringShutdown(client);
    await client.start();
    const fakeB = fakeAt(fakes, 1);
    const pending = client.request('runs.list', {}, 5000);
    const sentId = lastSentId(fakeB);
    fakeA.emit('exit', 0);
    respond(fakeB, sentId, { runs: [] });
    await expect(pending).resolves.toEqual({ runs: [] });
    await client.stop();
  });

  it('ignores a late error from a replaced child', async () => {
    const { client, fakes } = sequenceClient((index) => index > 0);
    await client.start();
    const fakeA = fakeAt(fakes, 0);
    await stopIgnoringShutdown(client);
    await client.start();
    const fakeB = fakeAt(fakes, 1);
    fakeA.emit('error', new Error('stale boom'));
    expect(client.status.connected).toBe(true);
    expect(client.status.lastError).toBeUndefined();
    const pending = client.request('runs.list', {}, 5000);
    respond(fakeB, lastSentId(fakeB), { runs: [] });
    await expect(pending).resolves.toEqual({ runs: [] });
    await client.stop();
  });

  it('resets framing after a failed handshake so the next child connects', async () => {
    const fakes: FakeChild[] = [];
    const client = new StdioRuntimeClient({
      launch: () => {
        const fake = new FakeChild();
        // Only the replacement child answers; child A crashes mid-handshake.
        if (fakes.length > 0) installResponder(fake);
        fakes.push(fake);
        return asChild(fake);
      },
    });
    const starting = client.start();
    const fakeA = fakeAt(fakes, 0);
    fakeA.stdout.emit('data', Buffer.from('{"type":"notification","event":', 'utf8'));
    fakeA.emit('exit', 1);
    await expect(starting).rejects.toThrow('Runtime exited before handshake');
    const started = client.start();
    const outcome = await Promise.race([
      started.then((): 'connected' => 'connected'),
      watchdog(2000),
    ]);
    started.catch(() => undefined);
    expect(outcome).toBe('connected');
    expect(client.status.connected).toBe(true);
    await client.stop();
  });
});

describe('stdio runtime electron guard', () => {
  async function handshakeWith(
    hello: Record<string, unknown>,
  ): Promise<{ client: StdioRuntimeClient; fake: FakeChild }> {
    let active: FakeChild | undefined;
    const client = new StdioRuntimeClient({
      launch: () => {
        const fake = new FakeChild();
        fake.onWrite = (line) => {
          const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
          if (parsed.method === 'runtime.shutdown') {
            queueMicrotask(() => {
              fake.emit('exit', 0);
            });
          }
        };
        active = fake;
        return asChild(fake);
      },
    });
    const starting = client.start();
    if (active === undefined) throw new Error('launcher did not produce a child');
    const sentId = lastSentId(active);
    active.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'response', id: sentId, ok: true, result: hello }) + '\n',
        'utf8',
      ),
    );
    await expect(starting).rejects.toMatchObject({ code: 'RUNTIME_UNDER_ELECTRON' });
    return { client, fake: active };
  }

  const baseHello = (): Record<string, unknown> => ({
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeVersion: 'test-0.0.0',
    platform: 'linux',
    isWsl: false,
    nodeVersion: 'v22.0.0',
    processExecPath: '/usr/bin/node',
    dataRoot: '/tmp/sentry-test-data',
  });

  it('rejects a positively detected Electron runtime regardless of filename', async () => {
    await handshakeWith({ ...baseHello(), isElectron: true });
  });

  it('keeps rejecting legacy runtimes via the executable path fallback', async () => {
    await handshakeWith({ ...baseHello(), processExecPath: 'C:\\host\\electron.exe' });
  });

  it('accepts an explicit non-Electron signal from a new runtime', async () => {
    let active: FakeChild | undefined;
    const client = new StdioRuntimeClient({
      launch: () => {
        const fake = new FakeChild();
        installResponder(fake);
        active = fake;
        return asChild(fake);
      },
    });
    const hello = await client.start();
    expect(hello.isElectron).toBe(false);
    expect(client.status.connected).toBe(true);
    if (active === undefined) throw new Error('launcher did not produce a child');
    await client.stop();
  });
});
