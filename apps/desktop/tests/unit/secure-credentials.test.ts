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
async function rmRoot(value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(value, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rmRoot(value)));
  delete process.env['DEEPSEEK_API_KEY'];
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
});

describe('secure persistent provider credentials', () => {
  it('save persists encrypted and restores across service restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-secure-'));
    roots.push(dir);
    const storage = fakeSafeStorage();
    const first = new ProviderCredentialService({ userDataDir: dir, safeStorage: storage });
    await first.load();
    await first.saveKey('DEEPSEEK_API_KEY', 'sk-live-secret-value');
    const status = first.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(status?.configured).toBe(true);
    expect(status?.persistence).toBe('secure');
    expect(status?.source).toBe('stored');
    expect(JSON.stringify(status)).not.toContain('sk-live-secret-value');
    const raw = await readFile(join(dir, 'credentials', 'providers.json'), 'utf8');
    expect(raw).not.toContain('sk-live-secret-value');
    delete process.env['DEEPSEEK_API_KEY'];
    const second = new ProviderCredentialService({ userDataDir: dir, safeStorage: storage });
    await second.load();
    const restored = second.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(restored?.configured).toBe(true);
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-live-secret-value');
  });

  it('renderer status never contains the secret value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-secure-'));
    roots.push(dir);
    const service = new ProviderCredentialService({
      userDataDir: dir,
      safeStorage: fakeSafeStorage(),
    });
    await service.load();
    await service.saveKey('DEEPSEEK_API_KEY', 'sk-topsecret-9999');
    const payload = JSON.stringify(service.statuses());
    expect(payload).not.toContain('sk-topsecret-9999');
    expect(payload).not.toContain('9999');
  });

  it('clear removes persisted secret, memory, and process.env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-secure-'));
    roots.push(dir);
    const storage = fakeSafeStorage();
    const service = new ProviderCredentialService({ userDataDir: dir, safeStorage: storage });
    await service.load();
    await service.saveKey('DEEPSEEK_API_KEY', 'sk-clear-me');
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-clear-me');
    await service.clearKey('DEEPSEEK_API_KEY');
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
    const raw = await readFile(join(dir, 'credentials', 'providers.json'), 'utf8');
    expect(raw).not.toContain('sk-clear-me');
    const reloaded = new ProviderCredentialService({ userDataDir: dir, safeStorage: storage });
    await reloaded.load();
    expect(reloaded.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY')?.configured).toBe(false);
  });

  it('secure storage unavailable never falls back to plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-secure-'));
    roots.push(dir);
    const service = new ProviderCredentialService({
      userDataDir: dir,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from('x'),
        decryptString: () => '',
      },
    });
    await service.load();
    await service.saveKey('DEEPSEEK_API_KEY', 'sk-session-only');
    const status = service.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(status?.persistence).toBe('session');
    await expect(service.persist()).rejects.toThrow(/session only/);
  });

  it('migrates the legacy plaintext file then deletes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-secure-'));
    roots.push(dir);
    const { writeFile } = await import('node:fs/promises');
    const legacy = join(dir, 'legacy.env');
    await writeFile(legacy, 'DEEPSEEK_API_KEY="sk-legacy-value"\nSENTRY_DEEPSEEK_MODEL="m1"\n');
    const storage = fakeSafeStorage();
    const service = new ProviderCredentialService({
      userDataDir: dir,
      safeStorage: storage,
      legacyEnvPath: legacy,
    });
    await service.load();
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-legacy-value');
    const { access } = await import('node:fs/promises');
    await expect(access(legacy)).rejects.toThrow();
    const raw = await readFile(join(dir, 'credentials', 'providers.json'), 'utf8');
    expect(raw).not.toContain('sk-legacy-value');
  });
});
