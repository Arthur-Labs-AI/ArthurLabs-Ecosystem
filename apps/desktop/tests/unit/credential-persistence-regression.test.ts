import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderCredentialService,
  MANAGED_PROVIDER_KEYS,
} from '../../src/main/services/provider-credentials.js';
import { DesktopApplicationService } from '../../src/main/services/desktop-service.js';
import type { RuntimeClient } from '../../src/main/runtime/runtime-client.js';
import type { HostPlatform } from '../../src/main/platform/host-platform.js';

const synthetic = 'synthetic-persistence-regression-not-a-provider-key';
let root: string;
function backend() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(buffer: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(-16));
      return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}
function make(storage = backend(), profile = root) {
  return new ProviderCredentialService({
    userDataDir: profile,
    safeStorage: storage,
    legacyEnvPath: join(root, 'absent-legacy.env'),
  });
}
function status(service: ProviderCredentialService, name = 'DEEPSEEK_API_KEY') {
  return service.statuses().find((s) => s.name === name);
}
function appService(credentials: ProviderCredentialService) {
  const runtime = {
    request: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    runtime,
    app: new DesktopApplicationService({
      credentials,
      runtime: runtime as unknown as RuntimeClient,
      host: {} as HostPlatform,
      agentStacks: [],
    }),
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sentry-persistence-regression-'));
  for (const name of MANAGED_PROVIDER_KEYS) vi.stubEnv(name, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('credential persistence through application service and restart', () => {
  it('does not publish a new secret while its write is still pending', async () => {
    const service = make();
    const pending = service.saveKey('DEEPSEEK_API_KEY', synthetic);
    const beforeCommit = status(service);
    await pending;
    expect(beforeCommit?.configured).toBe(false);
    expect(status(service)).toMatchObject({
      configured: true,
      persistence: 'secure',
      source: 'stored',
    });
  });
  it('saves, shuts down, and reloads the same explicit profile in a fresh context', async () => {
    const storage = backend(),
      first = make(storage),
      session = appService(first);
    await first.load();
    await expect(session.app.providerSaveKey('DEEPSEEK_API_KEY', synthetic)).resolves.toMatchObject(
      { configured: true, persistence: 'secure', source: 'stored' },
    );
    await session.runtime.stop();
    for (const name of MANAGED_PROVIDER_KEYS) delete process.env[name];
    const second = make(storage),
      restarted = appService(second);
    await second.load();
    expect(restarted.app.providerStatuses() as unknown[]).toContainEqual(
      expect.objectContaining({
        name: 'DEEPSEEK_API_KEY',
        configured: true,
        persistence: 'secure',
        source: 'stored',
      }),
    );
    expect(JSON.stringify(restarted.app.providerStatuses())).not.toContain(synthetic);
    expect(await readFile(second.path, 'utf8')).not.toContain(synthetic);
    await restarted.runtime.stop();
  });

  it('a rejected encrypted write cannot advertise a saved key before or after restart', async () => {
    const storage = backend(),
      first = make(storage),
      session = appService(first);
    await first.load();
    await mkdir(first.path, { recursive: true }); // rename cannot replace a directory
    await expect(session.app.providerSaveKey('DEEPSEEK_API_KEY', synthetic)).rejects.toThrow();
    expect(status(first)?.configured).toBe(false);
    expect(first.getValue('DEEPSEEK_API_KEY')).toBeUndefined();
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
    expect(session.runtime.request).not.toHaveBeenCalled();
    await session.runtime.stop();
    const fresh = make(storage);
    await fresh.load();
    expect(status(fresh)).toMatchObject({
      configured: false,
      persistence: 'unavailable',
      source: 'unavailable',
    });
  });

  it('failed replacement preserves the old durable key and sanitizes encryption exceptions', async () => {
    const storage = backend(),
      service = make(storage);
    await service.saveKey('DEEPSEEK_API_KEY', 'synthetic-original-stored-key');
    const original = await readFile(service.path);
    storage.encryptString = () => {
      throw new Error(synthetic);
    };
    const failure = await service.saveKey('DEEPSEEK_API_KEY', synthetic).catch((e) => e as Error);
    expect(failure).toMatchObject({ code: 'CREDENTIAL_WRITE_FAILED' });
    expect(String(failure)).not.toContain(synthetic);
    expect(service.getValue('DEEPSEEK_API_KEY')).toBe('synthetic-original-stored-key');
    expect(await readFile(service.path)).toEqual(original);
  });

  it('normal boot reports an unreadable entry, preserves its bytes while saving another key', async () => {
    const storage = backend(),
      service = make(storage);
    await mkdir(join(root, 'credentials'));
    await writeFile(
      service.path,
      JSON.stringify({ version: 1, secrets: { DEEPSEEK_API_KEY: '!!!' } }),
    );
    await service.load();
    expect(status(service)).toMatchObject({
      configured: false,
      persistence: 'unavailable',
      source: 'unavailable',
    });
    expect(JSON.stringify(service.statuses())).not.toContain('!!!');
    await service.saveKey('ANTHROPIC_AUTH_TOKEN', synthetic);
    expect(JSON.parse(await readFile(service.path, 'utf8')).secrets.DEEPSEEK_API_KEY).toBe('!!!');
    expect(status(service, 'ANTHROPIC_AUTH_TOKEN')).toMatchObject({
      configured: true,
      persistence: 'secure',
    });
  });

  it('normal boot preserves an unreadable store and refuses to overwrite it', async () => {
    const service = make();
    await mkdir(join(root, 'credentials'));
    await writeFile(service.path, '{broken');
    await service.load();
    expect(status(service)).toMatchObject({ configured: false, persistence: 'unavailable' });
    await expect(service.saveKey('DEEPSEEK_API_KEY', synthetic)).rejects.toThrow();
    expect(await readFile(service.path, 'utf8')).toBe('{broken');
  });

  it('reports unavailable crypto separately from missing, preserves store and model prefs', async () => {
    const storage = backend(),
      first = make(storage);
    await first.saveKey('DEEPSEEK_API_KEY', synthetic);
    await first.saveKey('SENTRY_DEEPSEEK_MODEL', 'unchanged-model');
    const bytes = await readFile(first.path);
    for (const name of MANAGED_PROVIDER_KEYS) delete process.env[name];
    const fresh = make({ ...storage, isEncryptionAvailable: () => false });
    await fresh.load();
    expect(status(fresh)).toMatchObject({
      configured: false,
      persistence: 'unavailable',
      source: 'unavailable',
    });
    expect(fresh.getValue('SENTRY_DEEPSEEK_MODEL')).toBe('unchanged-model');
    await expect(fresh.saveKey('DEEPSEEK_API_KEY', synthetic)).rejects.toMatchObject({
      code: 'SECURE_STORAGE_UNAVAILABLE',
    });
    expect(await readFile(fresh.path)).toEqual(bytes);
  });

  it('rejects missing profile instead of persisting in a shared temporary directory', async () => {
    const service = new ProviderCredentialService({
      safeStorage: backend(),
      legacyEnvPath: join(root, 'absent.env'),
    });
    expect(() => service.path).toThrow(/profile/i);
    expect(() => new ProviderCredentialService({ userDataDir: '' }).path).toThrow(/profile/i);
    await expect(service.saveKey('DEEPSEEK_API_KEY', synthetic)).rejects.toMatchObject({
      code: 'CREDENTIAL_PROFILE_UNAVAILABLE',
    });
    expect(service.getValue('DEEPSEEK_API_KEY')).toBeUndefined();
  });

  it('concurrent saves retain both keys when a fresh context reloads', async () => {
    const storage = backend(),
      service = make(storage);
    await Promise.all([
      service.saveKey('DEEPSEEK_API_KEY', synthetic),
      service.saveKey('ANTHROPIC_AUTH_TOKEN', synthetic + '-glm'),
    ]);
    for (const name of MANAGED_PROVIDER_KEYS) delete process.env[name];
    const fresh = make(storage);
    await fresh.load();
    expect(status(fresh)).toMatchObject({
      configured: true,
      persistence: 'secure',
      source: 'stored',
    });
    expect(status(fresh, 'ANTHROPIC_AUTH_TOKEN')).toMatchObject({
      configured: true,
      persistence: 'secure',
      source: 'stored',
    });
  });

  it('a rejected mutation does not poison the next queued save', async () => {
    const storage = backend(),
      service = make(storage);
    const encrypt = storage.encryptString;
    storage.encryptString = () => {
      throw new Error(synthetic);
    };
    await expect(service.saveKey('DEEPSEEK_API_KEY', synthetic)).rejects.toThrow();
    storage.encryptString = encrypt;
    await expect(service.saveKey('DEEPSEEK_API_KEY', synthetic)).resolves.toMatchObject({
      persistence: 'secure',
    });
  });

  it('failed clear and forget preserve the loaded key instead of claiming deletion', async () => {
    const service = make();
    await service.saveKey('DEEPSEEK_API_KEY', synthetic);
    const backup = join(root, 'preserved-ciphertext.json');
    await rename(service.path, backup);
    await mkdir(service.path);
    await expect(service.clearKey('DEEPSEEK_API_KEY')).rejects.toMatchObject({
      code: 'CREDENTIAL_WRITE_FAILED',
    });
    await expect(service.forgetAll()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITE_FAILED' });
    expect(service.getValue('DEEPSEEK_API_KEY')).toBe(synthetic);
    expect((await readFile(backup, 'utf8')).includes(synthetic)).toBe(false);
  });

  it('failed legacy migration retains input and does not claim secure persistence', async () => {
    const legacy = join(root, 'legacy.env');
    await writeFile(legacy, 'DEEPSEEK_API_KEY="' + synthetic + '"\n');
    await writeFile(join(root, 'credentials'), 'blocks directory creation');
    const service = new ProviderCredentialService({
      userDataDir: root,
      safeStorage: backend(),
      legacyEnvPath: legacy,
    });
    await service.load();
    expect(status(service)).toMatchObject({ configured: false, source: 'unavailable' });
    expect(service.getValue('DEEPSEEK_API_KEY')).toBeUndefined();
    expect((await readFile(legacy, 'utf8')).includes(synthetic)).toBe(true);
  });

  it('environment credentials remain explicitly environmental when a stored entry is unreadable', async () => {
    const service = make();
    await mkdir(join(root, 'credentials'));
    await writeFile(
      service.path,
      JSON.stringify({ version: 1, secrets: { DEEPSEEK_API_KEY: '!!!' } }),
    );
    vi.stubEnv('DEEPSEEK_API_KEY', synthetic);
    await service.load();
    expect(status(service)).toMatchObject({
      configured: true,
      persistence: 'environment',
      source: 'environment',
      storageError: 'entry-unreadable',
    });
    expect(JSON.stringify(service.statuses())).not.toContain(synthetic);
  });
});
