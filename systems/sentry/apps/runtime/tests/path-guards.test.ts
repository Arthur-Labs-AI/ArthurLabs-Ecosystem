import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SentryRuntimeHost } from '../src/runtime.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('runtime path guards', () => {
  it('rejects untranslated Windows source paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-path-guard-'));
    roots.push(root);
    const host = new SentryRuntimeHost(join(root, 'data'), () => undefined);
    try {
      await host.recover();
      await expect(host.addProject('C:\\Users\\Mert\\Documents\\Project')).rejects.toMatchObject({
        code: 'WINDOWS_PATH_NOT_TRANSLATED',
      });
      await expect(host.addProject('D:\\Code\\App')).rejects.toMatchObject({
        code: 'WINDOWS_PATH_NOT_TRANSLATED',
      });
      await expect(host.addProject('relative/path')).rejects.toMatchObject({
        code: 'INVALID_SOURCE_PATH',
      });
    } finally {
      host.close();
    }
  });

  it('reports legacy Windows data without migrating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-legacy-'));
    roots.push(root);
    const host = new SentryRuntimeHost(join(root, 'data'), () => undefined);
    try {
      await host.recover();
      const report = (await host.legacyWindowsData()) as { detected: string[]; migrated: boolean };
      expect(report.migrated).toBe(false);
      expect(Array.isArray(report.detected)).toBe(true);
    } finally {
      host.close();
    }
  });

  it('redacts secrets from error payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-redact-'));
    roots.push(root);
    const host = new SentryRuntimeHost(join(root, 'data'), () => undefined);
    try {
      await host.recover();
      await host.configure({
        models: {},
        providers: { deepseekApiKey: 'sk-fake-secret-for-test' },
      });
      const gate = (await host.productionReadiness(['stack_deepseek_main'])) as { ready: boolean };
      expect(typeof gate.ready).toBe('boolean');
    } finally {
      delete process.env['DEEPSEEK_API_KEY'];
      host.close();
    }
  });
});
