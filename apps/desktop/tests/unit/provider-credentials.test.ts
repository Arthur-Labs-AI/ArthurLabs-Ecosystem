import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
  delete process.env['DEEPSEEK_API_KEY'];
});

describe('provider credentials', () => {
  it('starts missing, sets session values, and never exposes them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({ filePath: join(dir, 'providers.json') });
    await service.load();
    const before = service.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(before?.configured).toBe(false);
    const updated = service.setKey('DEEPSEEK_API_KEY', 'sk-test-12345678');
    expect(updated.configured).toBe(true);
    expect(updated.source).toBe('session');
    expect(JSON.stringify(updated)).not.toContain('sk-test-12345678');
    // No secret hints: fixed display, never key material or fragments.
    expect(updated.hint).not.toContain('5678');
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-test-12345678');
  });

  it('rejects unsupported names and empty values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({ filePath: join(dir, 'providers.json') });
    expect(() => service.setKey('EVIL_KEY', 'x')).toThrow();
    expect(() => service.setKey('DEEPSEEK_API_KEY', '   ')).toThrow();
  });

  it('session values do not persist without secure storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const filePath = join(dir, 'providers.json');
    const service = new ProviderCredentialService({ filePath });
    service.setKey('DEEPSEEK_API_KEY', 'sk-session-abcdef');
    service.setKey('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-flash');
    // Without safeStorage there is no plaintext fallback: persist rejects.
    await expect(service.persist()).rejects.toThrow(/session only/);
    delete process.env['DEEPSEEK_API_KEY'];
    delete process.env['SENTRY_DEEPSEEK_MODEL'];
    const reloaded = new ProviderCredentialService({ filePath });
    await reloaded.load();
    const status = reloaded.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(status?.configured).toBe(false);
    expect(JSON.stringify(status)).not.toContain('sk-session-abcdef');
  });

  it('clears session values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({ filePath: join(dir, 'providers.json') });
    service.setKey('DEEPSEEK_API_KEY', 'sk-clear-me-123');
    const cleared = await service.clearKey('DEEPSEEK_API_KEY');
    expect(cleared.configured).toBe(false);
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
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
