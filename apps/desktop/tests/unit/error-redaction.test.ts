import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { dispatchDesktopCommand, toRouterError } from '../../src/main/desktop-command-router.js';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';
import { SentryCliServer } from '../../src/main/cli-server.js';

// Task A redaction matrix: an unmistakably synthetic secret sent through the
// ACTUAL production error-mapping functions. This value is not a credential.
const SECRET = 'sk-sentry-phase5-redaction-synthetic-only-001';
const LONG_SECRET_PADDED = SECRET + 'x'.repeat(5000);

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('enc:' + value, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad blob');
      return text.slice(4);
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  delete process.env['DEEPSEEK_API_KEY'];
});

async function redactor() {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-redact-'));
  roots.push(dir);
  const credentials = new ProviderCredentialService({
    userDataDir: dir,
    safeStorage: fakeSafeStorage(),
  });
  await credentials.load();
  await credentials.saveKey('DEEPSEEK_API_KEY', SECRET);
  return (text: string) => credentials.redactSecretsFromText(text);
}

// Dynamic access so the pre-fix tree (no such export) fails these tests
// honestly instead of failing file linkage.
async function safeError(
  error: unknown,
  options: { redactSecrets: (text: string) => string },
): Promise<{ code: string; message: string }> {
  const mod = (await import('../../src/main/desktop-command-router.js')) as Record<string, unknown>;
  const fn = mod['toSafeError'];
  if (typeof fn !== 'function') throw new Error('redaction boundary absent (pre-fix)');
  return (fn as (error: unknown, options: unknown) => { code: string; message: string })(
    error,
    options,
  );
}

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

type IpcListener = (payload: unknown) => Promise<unknown>;

async function registeredListener(
  channel: string,
  service: unknown,
  hooks: Record<string, unknown> = {},
): Promise<{ calls: Array<{ channel: string; listener: IpcListener }>; listener: IpcListener }> {
  const { ipcMain } = (await import('electron')) as unknown as {
    ipcMain: {
      handle: {
        mockImplementation: (fn: (channel: string, listener: never) => void) => void;
        mockClear: () => void;
      };
    };
  };
  const { registerDesktopIpc } = await import('../../src/main/ipc.js');
  ipcMain.handle.mockClear();
  const calls: Array<{ channel: string; listener: IpcListener }> = [];
  ipcMain.handle.mockImplementation((channel: string, listener: never) => {
    calls.push({ channel, listener: listener as unknown as IpcListener });
  });
  registerDesktopIpc(service as never, hooks as never);
  const entry = calls.find((call) => call.channel === channel);
  if (entry === undefined) throw new Error('handler not registered: ' + channel);
  return { calls, listener: entry.listener };
}

describe('registered Electron IPC boundary', () => {
  it('invokes the registered handler with redaction applied', async () => {
    const redact = await redactor();
    const failing = {
      listProjects: async () => {
        throw coded('PROVIDER_ERROR', 'upstream 500 with key ' + SECRET);
      },
    };
    const { calls, listener } = await registeredListener('projects:list', failing, {
      redactErrorText: redact,
    });
    expect(calls.length).toBeGreaterThan(0);
    const response = (await listener({})) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it('a failing redactor still yields a safe IPC response', async () => {
    const failing = {
      listProjects: async () => {
        throw coded('RUN_TIMEOUT', 'stalled with key ' + SECRET);
      },
    };
    const { listener } = await registeredListener('projects:list', failing, {
      redactErrorText: () => {
        throw new Error('scrubber down');
      },
    });
    const response = (await listener({})) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('RUN_TIMEOUT');
    expect(response.error.message).toBe('Desktop operation failed');
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it('successful IPC responses pass through untouched', async () => {
    const okService = {
      listProjects: async () => [{ id: 'proj_1', name: 'demo' }],
    };
    const { listener } = await registeredListener('projects:list', okService, {});
    const response = await listener({});
    expect(response).toEqual({ ok: true, result: [{ id: 'proj_1', name: 'demo' }] });
  });

  it('unwired handler still bounds and validates codes', async () => {
    const failing = {
      listProjects: async () => {
        throw coded('bad code!!', 'x'.repeat(5000));
      },
    };
    const { listener } = await registeredListener('projects:list', failing, {});
    const response = (await listener({})) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(response.ok).toBe(false);
    expect(response.error.code).toBe('DESKTOP_ERROR');
    expect(response.error.message.length).toBeLessThanOrEqual(1000);
  });
});

function coded(code: unknown, message: unknown) {
  return Object.assign(new Error('carrier'), { code, message } as never) as Error & {
    code: unknown;
    message: unknown;
  };
}

describe('Desktop error redaction boundary', () => {
  it('uncoded secret-bearing exception never reaches the response', async () => {
    const redact = await redactor();
    const mapped = await safeError(new Error('provider blew up: ' + SECRET), {
      redactSecrets: redact,
    });
    expect(mapped.code).toBe('DESKTOP_ERROR');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('coded secret-bearing exception keeps a safe code without the secret', async () => {
    const redact = await redactor();
    const mapped = await safeError(coded('RUN_TIMEOUT', 'timed out with key ' + SECRET), {
      redactSecrets: redact,
    });
    expect(mapped.code).toBe('RUN_TIMEOUT');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('nested Error messages cannot bypass response bounds', async () => {
    const redact = await redactor();
    const mapped = await safeError(coded('RUN_TIMEOUT', new Error(LONG_SECRET_PADDED)), {
      redactSecrets: redact,
    });
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
    expect(mapped.message.length).toBeLessThanOrEqual(1000);
  });

  it('extremely long messages use one consistent cap', () => {
    const mapped = toRouterError(new Error('x'.repeat(5000)));
    expect(mapped.message.length).toBe(1000);
  });

  it('malformed or oversized codes fall back safely', async () => {
    const redact = await redactor();
    for (const code of ['evil code!!', '', 'x'.repeat(500), 42, undefined]) {
      const mapped = await safeError(coded(code, 'something failed: ' + SECRET), {
        redactSecrets: redact,
      });
      expect(mapped.code).toBe('DESKTOP_ERROR');
      expect(JSON.stringify(mapped)).not.toContain(SECRET);
    }
  });

  it('known safe application errors stay actionable', () => {
    const guidance = 'Cannot start QA - provider not ready: stack_glm_main: no credential';
    const mapped = toRouterError(coded('PROVIDER_NOT_READY', guidance));
    expect(mapped).toEqual({ code: 'PROVIDER_NOT_READY', message: guidance });
  });

  it('provider timeout keeps its classification and budget detail', async () => {
    const redact = await redactor();
    const message = 'Agent exceeded run budget (120000 ms).';
    const mapped = await safeError(coded('RUN_TIMEOUT', message), { redactSecrets: redact });
    expect(mapped).toEqual({ code: 'RUN_TIMEOUT', message });
  });

  it('provider authentication failure guides without key disclosure', async () => {
    const redact = await redactor();
    const message = 'Provider rejected credentials (401). Check provider configuration.';
    const mapped = await safeError(coded('PROVIDER_AUTH_FAILED', message), {
      redactSecrets: redact,
    });
    expect(mapped).toEqual({ code: 'PROVIDER_AUTH_FAILED', message });
  });

  it('unexpected exception types fail safely', () => {
    for (const input of [undefined, null, 42, { message: { nested: true } }]) {
      const mapped = toRouterError(input);
      expect(mapped.code).toBe('DESKTOP_ERROR');
      expect(typeof mapped.message).toBe('string');
      expect(mapped.message.length).toBeLessThanOrEqual(1000);
    }
  });

  it('renderer IPC rejections carry no secret through the mapped response', async () => {
    const redact = await redactor();
    const failing = {
      listProjects: async () => {
        throw coded('PROVIDER_ERROR', 'upstream 500 with key ' + SECRET);
      },
    };
    let caught: unknown;
    try {
      await dispatchDesktopCommand(failing as never, 'projects:list', {}, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const mapped = await safeError(caught, { redactSecrets: redact });
    expect(mapped.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('CLI broker error responses carry no secret over the wire', { timeout: 30000 }, async () => {
    const redact = await redactor();
    const pipe =
      process.platform === 'win32'
        ? '\\\\.\\pipe\\sentry-redact-' + process.pid
        : join(tmpdir(), 'sentry-redact-' + process.pid + '.sock');
    const server = new SentryCliServer({
      pipePath: pipe,
      dispatch: async () => {
        throw coded('PROVIDER_ERROR', 'upstream 500 with key ' + SECRET);
      },
      redactErrorText: redact,
    });
    try {
      await server.start();
      const socket: Socket = await new Promise((resolve, reject) => {
        const s = createConnection(pipe);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
      const pending: string[] = [];
      const waiters: Array<(line: string) => void> = [];
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const waiter = waiters.shift();
          if (waiter !== undefined) waiter(line);
          else pending.push(line);
          index = buffer.indexOf('\n');
        }
      });
      const nextLine = (timeoutMs: number, label: string): Promise<string> => {
        const queued = pending.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
          waiters.push((line: string) => {
            clearTimeout(timer);
            resolve(line);
          });
        });
      };
      socket.on('error', () => undefined);
      socket.write(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          client: { type: 'cli', name: 'redaction-probe' },
        }) + '\n',
      );
      const welcome = JSON.parse(await nextLine(5000, 'no broker line')) as {
        type?: unknown;
      };
      expect(welcome.type).toBe('welcome');
      socket.write(
        JSON.stringify({
          type: 'request',
          id: 'redact-1',
          command: 'runs:get',
          payload: { runId: 'run_01K7777777777777777777A8W1' },
        }) + '\n',
      );
      const frame = JSON.parse(await nextLine(5000, 'no broker response')) as {
        ok?: unknown;
        error?: { code?: unknown };
      };
      expect(frame.ok).toBe(false);
      expect(frame.error?.code).toBe('PROVIDER_ERROR');
      expect(JSON.stringify(frame)).not.toContain(SECRET);
      socket.destroy();
    } finally {
      await server.stop();
    }
  });

  it('existing credential diagnostics stay presence-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-redact-'));
    roots.push(dir);
    const credentials = new ProviderCredentialService({
      userDataDir: dir,
      safeStorage: fakeSafeStorage(),
    });
    await credentials.load();
    await credentials.saveKey('DEEPSEEK_API_KEY', SECRET);
    const payload = JSON.stringify(credentials.statuses());
    expect(payload).not.toContain(SECRET);
    delete process.env['DEEPSEEK_API_KEY'];
  });
});

describe('Desktop error redaction fail-closed hardening', () => {
  it('a throwing redactor yields a fixed safe message without the secret', async () => {
    const throwing = () => {
      throw new Error('scrubber down');
    };
    const mapped = await safeError(coded('RUN_TIMEOUT', 'timed out with key ' + SECRET), {
      redactSecrets: throwing,
    });
    expect(mapped.code).toBe('RUN_TIMEOUT');
    expect(mapped.message).toBe('Desktop operation failed');
    expect(JSON.stringify(mapped)).not.toContain(SECRET);
  });

  it('a redactor returning an invalid value yields a fixed safe message', async () => {
    for (const bad of [undefined, 42, { redacted: true }]) {
      const mapped = await safeError(coded('RUN_TIMEOUT', 'timed out with key ' + SECRET), {
        redactSecrets: (() => bad) as never,
      });
      expect(mapped.code).toBe('RUN_TIMEOUT');
      expect(mapped.message).toBe('Desktop operation failed');
      expect(JSON.stringify(mapped)).not.toContain(SECRET);
    }
  });

  it('service sanitizes async rejections exactly like sync throws', async () => {
    const { DesktopApplicationService } =
      await import('../../src/main/services/desktop-service.js');
    const codedRejection = () => coded('PROVIDER_ERROR', 'upstream 500 with key ' + SECRET);
    const failingRuntime = {
      request: async () => {
        throw codedRejection();
      },
    };
    const throwingRuntime = {
      request: () => {
        throw codedRejection();
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'sentry-redact-'));
    roots.push(dir);
    const credentials = new ProviderCredentialService({
      userDataDir: dir,
      safeStorage: fakeSafeStorage(),
    });
    await credentials.load();
    await credentials.saveKey('DEEPSEEK_API_KEY', SECRET);
    const forAsync = new DesktopApplicationService({
      runtime: failingRuntime,
      host: {},
      agentStacks: [],
      credentials,
    } as never);
    await expect(forAsync.listProjects()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    try {
      await forAsync.listProjects();
      expect.unreachable();
    } catch (error) {
      // Error objects stringify to '{}': assert on the carried message.
      expect(error).toMatchObject({ code: 'PROVIDER_ERROR' });
      const text = error instanceof Error ? error.message : JSON.stringify(error);
      expect(text).not.toContain(SECRET);
    }
    const forSync = new DesktopApplicationService({
      runtime: throwingRuntime,
      host: {},
      agentStacks: [],
      credentials,
    } as never);
    let syncError: unknown;
    try {
      await forSync.listProjects();
      expect.unreachable();
    } catch (error) {
      syncError = error;
    }
    expect(syncError).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(JSON.stringify(syncError)).not.toContain(SECRET);
  });
});
