import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';

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
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
  delete process.env['DEEPSEEK_API_KEY'];
  delete process.env['SENTRY_DEEPSEEK_MODEL'];
});

describe('provider credentials', () => {
  it('starts missing, saves persisted values, and never exposes them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({
      filePath: join(dir, 'providers.json'),
      safeStorage: fakeSafeStorage(),
    });
    await service.load();
    const before = service.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(before?.configured).toBe(false);
    const updated = await service.saveKey('DEEPSEEK_API_KEY', 'sk-test-12345678');
    expect(updated.configured).toBe(true);
    expect(updated.persistence).toBe('secure');
    expect(updated.source).toBe('stored');
    expect(JSON.stringify(updated)).not.toContain('sk-test-12345678');
    // No secret hints: fixed display, never key material or fragments.
    expect(updated.hint).not.toContain('5678');
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-test-12345678');
  });

  it('rejects unsupported names and empty values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({
      filePath: join(dir, 'providers.json'),
      safeStorage: fakeSafeStorage(),
    });
    await expect(service.saveKey('EVIL_KEY', 'x')).rejects.toThrow();
    await expect(service.saveKey('DEEPSEEK_API_KEY', '   ')).rejects.toThrow();
  });

  it('refuses secret saves without secure storage instead of session fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const filePath = join(dir, 'providers.json');
    const service = new ProviderCredentialService({ filePath });
    await expect(service.saveKey('DEEPSEEK_API_KEY', 'sk-no-store')).rejects.toThrow(
      /Secure persistent storage unavailable/,
    );
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
    // Without safeStorage there is no plaintext fallback: persist rejects.
    await expect(service.persist()).rejects.toThrow(/Secure persistent storage unavailable/);
    const reloaded = new ProviderCredentialService({ filePath });
    await reloaded.load();
    const status = reloaded.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(status?.configured).toBe(false);
  });

  it('persists model ids without secure storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({ userDataDir: dir });
    const updated = await service.saveKey('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-flash');
    expect(updated.configured).toBe(true);
    expect(updated.persistence).toBe('persisted');
    delete process.env['SENTRY_DEEPSEEK_MODEL'];
    const reloaded = new ProviderCredentialService({ userDataDir: dir });
    await reloaded.load();
    expect(reloaded.getValue('SENTRY_DEEPSEEK_MODEL')).toBe('deepseek-v4-flash');
  });

  it('clears persisted values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({
      filePath: join(dir, 'providers.json'),
      safeStorage: fakeSafeStorage(),
    });
    await service.saveKey('DEEPSEEK_API_KEY', 'sk-clear-me-123');
    const cleared = await service.clearKey('DEEPSEEK_API_KEY');
    expect(cleared.configured).toBe(false);
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
  });

  it('stores the OpenRouter key persisted, never displayed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({
      filePath: join(dir, 'providers.json'),
      safeStorage: fakeSafeStorage(),
    });
    const updated = await service.saveKey('OPENROUTER_API_KEY', 'sk-or-test-12345678');
    expect(updated.configured).toBe(true);
    expect(updated.persistence).toBe('secure');
    expect(JSON.stringify(updated)).not.toContain('sk-or-test-12345678');
    expect(updated.hint).not.toContain('5678');
    expect(process.env['OPENROUTER_API_KEY']).toBe('sk-or-test-12345678');
    delete process.env['OPENROUTER_API_KEY'];
  });

  it('rejects legacy Muse keys as unsupported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({
      filePath: join(dir, 'providers.json'),
      safeStorage: fakeSafeStorage(),
    });
    await expect(service.saveKey('SENTRY_MUSE_MODEL', 'x')).rejects.toThrow();
    await expect(service.saveKey('SENTRY_MUSE_BINARY', 'x')).rejects.toThrow();
  });

  it('persists non-secret model ids as plain JSON prefs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({ userDataDir: dir });
    await service.saveKey('SENTRY_DEEPSEEK_MODEL', 'model-x');
    const raw = await readFile(join(dir, 'preferences', 'models.json'), 'utf8');
    expect(raw).toContain('model-x');
  });
});
