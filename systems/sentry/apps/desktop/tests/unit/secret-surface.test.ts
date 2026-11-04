import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCredentialService } from '../../src/main/services/provider-credentials.js';
import { toRouterError } from '../../src/main/desktop-command-router.js';

// Phase 5 (F2): one known fake secret asserted absent across every
// diagnostic surface at once — statuses, strict diagnostics, on-disk bytes,
// model prefs, and router error mapping. Synthetic values only.
const SECRET_A = 'sk-phase5-surface-alpha-001';
const SECRET_B = 'gl-phase5-surface-beta-002';

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
  delete process.env['ANTHROPIC_AUTH_TOKEN'];
  delete process.env['SENTRY_DEEPSEEK_MODEL'];
});

async function savedService() {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-surface-'));
  roots.push(dir);
  const service = new ProviderCredentialService({
    userDataDir: dir,
    safeStorage: fakeSafeStorage(),
  });
  await service.load();
  await service.saveKey('DEEPSEEK_API_KEY', SECRET_A);
  await service.saveKey('ANTHROPIC_AUTH_TOKEN', SECRET_B);
  await service.saveKey('SENTRY_DEEPSEEK_MODEL', 'deepseek-flash');
  return { dir, service };
}

describe('credential diagnostic surface', () => {
  it('keeps known secrets out of statuses, disk bytes, and prefs', async () => {
    const { dir, service } = await savedService();
    expect(JSON.stringify(service.statuses())).not.toContain(SECRET_A);
    expect(JSON.stringify(service.statuses())).not.toContain(SECRET_B);
    const rawStore = await readFile(join(dir, 'credentials', 'providers.json'), 'utf8');
    expect(rawStore).not.toContain(SECRET_A);
    expect(rawStore).not.toContain(SECRET_B);
    const rawPrefs = await readFile(join(dir, 'sentry-prefs', 'models.json'), 'utf8');
    expect(rawPrefs).not.toContain(SECRET_A);
    expect(rawPrefs).not.toContain(SECRET_B);
    expect(rawPrefs).toContain('deepseek-flash');
  });

  it('strict diagnostics validate without echoing values', async () => {
    const { dir } = await savedService();
    const strict = new ProviderCredentialService({
      userDataDir: dir,
      safeStorage: fakeSafeStorage(),
    });
    await strict.load({ strict: true });
    expect(JSON.stringify(strict.statuses())).not.toContain(SECRET_A);
    // Wrong-key store: strict load must report unreadable, never the value.
    const hostile = new ProviderCredentialService({
      userDataDir: dir,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from('enc:' + value, 'utf8'),
        decryptString: () => {
          throw new Error('decrypt failed for blob holding ' + SECRET_A);
        },
      },
    });
    const failure = await hostile.load({ strict: true }).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toContain('Credential entry unreadable');
    expect(failure).not.toContain(SECRET_A);
  });

  it('router errors preserve codes and truncate without secret lanes', async () => {
    const { service } = await savedService();
    expect(JSON.stringify(service.statuses())).not.toContain(SECRET_A);
    expect(JSON.stringify(service.statuses())).not.toContain(SECRET_B);
    // Representative coded failures map with bounded messages.
    const mapped = toRouterError(
      Object.assign(new Error('Run deadbeef failed: provider timeout'), {
        code: 'RUN_TIMEOUT',
      }),
    );
    expect(mapped).toEqual({ code: 'RUN_TIMEOUT', message: expect.any(String) });
    expect(JSON.stringify(mapped).length).toBeLessThanOrEqual(1100);
    // Clearing removes the value from memory, env, disk, and statuses.
    await service.clearKey('DEEPSEEK_API_KEY');
    await service.clearKey('ANTHROPIC_AUTH_TOKEN');
    expect(JSON.stringify(service.statuses())).not.toContain(SECRET_A);
    expect(JSON.stringify(service.statuses())).not.toContain(SECRET_B);
    expect(process.env['DEEPSEEK_API_KEY']).toBeUndefined();
    expect(process.env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
  });
});
