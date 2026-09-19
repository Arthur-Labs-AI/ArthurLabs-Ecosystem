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
    const service = new ProviderCredentialService({ filePath: join(dir, 'providers.env') });
    await service.load();
    const before = service.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(before?.configured).toBe(false);
    const updated = service.setKey('DEEPSEEK_API_KEY', 'sk-test-12345678');
    expect(updated.configured).toBe(true);
    expect(updated.source).toBe('desktop');
    expect(JSON.stringify(updated)).not.toContain('sk-test-12345678');
    expect(updated.hint).toContain('5678');
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-test-12345678');
  });

  it('rejects unsupported names and empty values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({ filePath: join(dir, 'providers.env') });
    expect(() => service.setKey('EVIL_KEY', 'x')).toThrow();
    expect(() => service.setKey('DEEPSEEK_API_KEY', '   ')).toThrow();
  });

  it('persists to a user-level file and reloads without leaking values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const filePath = join(dir, 'providers.env');
    const service = new ProviderCredentialService({ filePath });
    service.setKey('DEEPSEEK_API_KEY', 'sk-persist-abcdef');
    service.setKey('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-flash');
    const persisted = await service.persist();
    expect(persisted.keys).toBe(2);
    const raw = await readFile(filePath, 'utf8');
    // Values ARE in the file (that is its purpose) but keyed per-line; statuses still redact.
    expect(raw).toContain('DEEPSEEK_API_KEY=');
    delete process.env['DEEPSEEK_API_KEY'];
    const reloaded = new ProviderCredentialService({ filePath });
    await reloaded.load();
    const status = reloaded.statuses().find((s) => s.name === 'DEEPSEEK_API_KEY');
    expect(status?.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-persist-abcdef');
    expect(process.env['DEEPSEEK_API_KEY']).toBe('sk-persist-abcdef');
    await reloaded.forgetFile();
    await reloaded.load();
  });

  it('clears session values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-prov-'));
    roots.push(dir);
    const service = new ProviderCredentialService({ filePath: join(dir, 'providers.env') });
    service.setKey('DEEPSEEK_API_KEY', 'sk-clear-me-123');
    const cleared = service.clearKey('DEEPSEEK_API_KEY');
    expect(cleared.configured).toBe(false);
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
  });
});
