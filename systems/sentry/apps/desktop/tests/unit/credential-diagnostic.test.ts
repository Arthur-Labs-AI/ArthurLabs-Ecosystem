import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderCredentialService,
  SECRET_PROVIDER_KEYS,
} from '../../src/main/services/provider-credentials.js';

const fixture = vi.hoisted(() => ({
  profile: '',
  appData: '',
  explicit: '',
  packaged: false,
  lock: vi.fn<() => boolean>(),
  ready: vi.fn<() => Promise<void>>(),
  quit: vi.fn(),
  exit: vi.fn(),
  boot: vi.fn(),
  safe: {
    isEncryptionAvailable: vi.fn<() => boolean>(),
    encryptString: vi.fn<(value: string) => Buffer>(),
    decryptString: vi.fn<(value: Buffer) => string>(),
  },
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return fixture.packaged;
    },
    commandLine: { getSwitchValue: () => fixture.explicit },
    getPath: (name: string) => (name === 'userData' ? fixture.profile : fixture.appData),
    setPath: (_name: string, path: string) => {
      fixture.profile = path;
    },
    getAppPath: () => fixture.profile,
    on: vi.fn(),
    whenReady: fixture.ready,
    requestSingleInstanceLock: fixture.lock,
    quit: fixture.quit,
    exit: fixture.exit,
  },
  safeStorage: fixture.safe,
  BrowserWindow: vi.fn(),
  dialog: {},
  ipcMain: {},
}));
vi.mock('../../src/main/bootstrap.js', () => ({ bootstrapDesktop: fixture.boot }));
vi.mock('../../src/main/distribution.js', async (original) => ({
  ...(await original<typeof import('../../src/main/distribution.js')>()),
  readReleaseIdentity: () => ({}),
}));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let directory: string;
let secret: string;
let output: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
let completed: Promise<void>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'sentry-diagnostic-unit-'));
  fixture.profile = join(directory, 'explicit profile');
  fixture.appData = join(directory, 'appdata');
  fixture.explicit = fixture.profile;
  fixture.packaged = false;
  await mkdir(fixture.profile);
  secret = 'synthetic-nonproduction-' + randomUUID();
  const key = randomBytes(32);
  fixture.safe.isEncryptionAvailable.mockReturnValue(true);
  fixture.safe.encryptString.mockImplementation((value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  });
  fixture.safe.decryptString.mockImplementation((value) => {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  });
  fixture.lock.mockReturnValue(true);
  fixture.ready.mockResolvedValue(undefined);
  completed = new Promise<void>((resolve) => {
    fixture.quit.mockImplementation(resolve);
    fixture.exit.mockImplementation(resolve);
  });
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', '.', '--sentry-credential-status']);
  for (const name of SECRET_PROVIDER_KEYS) vi.stubEnv(name, undefined);
  // Never read the machine's legacy env file.
  vi.stubEnv(process.platform === 'win32' ? 'TEMP' : 'TMPDIR', directory);
  output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  expect(fixture.boot).not.toHaveBeenCalled();
  const text = JSON.stringify([...output.mock.calls, ...errors.mock.calls]);
  expect(text.includes(secret)).toBe(false);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function seed(name: string) {
  const service = new ProviderCredentialService({
    userDataDir: fixture.profile,
    safeStorage: fixture.safe,
    legacyEnvPath: join(directory, 'absent.env'),
  });
  await service.saveKey(name, secret);
  for (const key of SECRET_PROVIDER_KEYS) delete process.env[key];
  const fresh = new ProviderCredentialService({
    userDataDir: fixture.profile,
    safeStorage: fixture.safe,
    legacyEnvPath: join(directory, 'absent.env'),
  });
  await fresh.load();
  expect(fresh.statuses().find((status) => status.name === name)?.persistence).toBe('secure');
  expect((await readFile(fresh.path)).includes(Buffer.from(secret))).toBe(false);
  // Reload above must not accidentally mask the diagnostic's missing bridge.
  for (const key of SECRET_PROVIDER_KEYS) delete process.env[key];
}
async function diagnose() {
  await import('../../src/main/index.js');
  await completed;
}
function report() {
  expect(fixture.exit).not.toHaveBeenCalled();
  expect(fixture.quit).toHaveBeenCalledOnce();
  expect(errors).not.toHaveBeenCalled();
  const lines = output.mock.calls.map((call) => String(call[0]));
  expect(lines).toHaveLength(1);
  expect(lines[0]?.startsWith('SENTRY_CREDENTIAL_STATUS=')).toBe(true);
  return JSON.parse((lines[0] ?? '').slice('SENTRY_CREDENTIAL_STATUS='.length)) as Record<
    string,
    boolean
  >;
}
function unavailable() {
  expect(output).not.toHaveBeenCalled();
  expect(fixture.exit).toHaveBeenCalledWith(1);
  expect(/Settings.*Providers/.test(String(errors.mock.calls[0]?.[0]))).toBe(true);
}

describe('standalone credential diagnostic through Electron main', () => {
  for (const [key, provider] of [
    ['OPENROUTER_API_KEY', 'opencode'],
    ['OPENCODE_API_KEY', 'opencode'],
    ['DEEPSEEK_API_KEY', 'deepseek'],
    ['ANTHROPIC_AUTH_TOKEN', 'glm'],
  ]) {
    it('decrypts stored ' + provider + ' presence independently', async () => {
      await seed(key!);
      await diagnose();
      expect(report()).toEqual({
        opencode: provider === 'opencode',
        deepseek: provider === 'deepseek',
        glm: provider === 'glm',
      });
    });
  }
  it('reports a valid empty profile as missing', async () => {
    await diagnose();
    expect(report()).toEqual({ opencode: false, deepseek: false, glm: false });
  });
  it('combines stored and supported environment sources without exposing values', async () => {
    await seed('DEEPSEEK_API_KEY');
    vi.stubEnv('OPENROUTER_API_KEY', secret);
    await diagnose();
    expect(report()).toEqual({ opencode: true, deepseek: true, glm: false });
  });
  it('uses the explicit packaged profile instead of the default beta location', async () => {
    fixture.packaged = true;
    await seed('DEEPSEEK_API_KEY');
    await diagnose();
    expect(fixture.profile).toBe(fixture.explicit);
    expect(report().deepseek).toBe(true);
  });
  it('preserves the default packaged source-beta profile', async () => {
    fixture.packaged = true;
    fixture.explicit = '';
    fixture.profile = join(fixture.appData, '@qa', 'desktop');
    await seed('DEEPSEEK_API_KEY');
    await diagnose();
    expect(fixture.profile).toBe(join(fixture.appData, '@qa', 'desktop'));
    expect(report().deepseek).toBe(true);
  });
  it('waits for Electron readiness before secure access', async () => {
    let ready!: () => void;
    fixture.ready.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    await import('../../src/main/index.js');
    await flush();
    expect(fixture.safe.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    ready();
    await completed;
    expect(report()).toEqual({ opencode: false, deepseek: false, glm: false });
  });
  it('fails safely when secure storage is unavailable', async () => {
    await seed('DEEPSEEK_API_KEY');
    fixture.safe.isEncryptionAvailable.mockReturnValue(false);
    await diagnose();
    unavailable();
  });
  it('sanitizes backend errors, including sensitive error text', async () => {
    fixture.safe.isEncryptionAvailable.mockImplementation(() => {
      throw new Error(secret);
    });
    await diagnose();
    unavailable();
  });
  for (const corrupt of ['json', 'schema', 'entry', 'base64', 'decrypt', 'empty', 'read']) {
    it('does not mistake unreadable ' + corrupt + ' storage for missing credentials', async () => {
      await seed('DEEPSEEK_API_KEY');
      const path = join(fixture.profile, 'credentials', 'providers.json');
      if (corrupt === 'json') await writeFile(path, '{');
      if (corrupt === 'schema') await writeFile(path, JSON.stringify({ version: 2, secrets: [] }));
      if (corrupt === 'entry')
        await writeFile(path, JSON.stringify({ version: 1, secrets: { DEEPSEEK_API_KEY: 42 } }));
      if (corrupt === 'base64')
        await writeFile(path, JSON.stringify({ version: 1, secrets: { DEEPSEEK_API_KEY: '%%%' } }));
      if (corrupt === 'read') {
        await rm(path);
        await mkdir(path);
      }
      if (corrupt === 'decrypt')
        fixture.safe.decryptString.mockImplementation(() => {
          throw new Error(secret);
        });
      if (corrupt === 'empty') fixture.safe.decryptString.mockReturnValue('');
      await diagnose();
      unavailable();
    });
  }
  it('does not migrate or rewrite the legacy file during inspection', async () => {
    const legacy = join(directory, 'sentry-desktop-providers.env');
    await writeFile(legacy, 'DEEPSEEK_API_KEY=' + secret);
    await diagnose();
    expect(report()).toEqual({ opencode: false, deepseek: false, glm: false });
    expect((await readFile(legacy, 'utf8')).endsWith(secret)).toBe(true);
    await expect(
      readFile(join(fixture.profile, 'credentials', 'providers.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps normal Desktop loading tolerant of corrupt entries', async () => {
    await seed('DEEPSEEK_API_KEY');
    fixture.safe.decryptString.mockImplementation(() => {
      throw new Error(secret);
    });
    const service = new ProviderCredentialService({
      userDataDir: fixture.profile,
      safeStorage: fixture.safe,
      legacyEnvPath: join(directory, 'absent.env'),
    });
    await expect(service.load()).resolves.toBeUndefined();
    expect(
      service.statuses().find((status) => status.name === 'DEEPSEEK_API_KEY')?.configured,
    ).toBe(false);
  });
  it('refuses while another Desktop owns the lock without starting runtime or encryption', async () => {
    fixture.lock.mockReturnValue(false);
    await diagnose();
    unavailable();
    expect(fixture.safe.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
  });
});
