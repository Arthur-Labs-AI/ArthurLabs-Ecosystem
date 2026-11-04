import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentryRuntimeHost } from '../src/runtime.js';

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  vi.restoreAllMocks();
});

const isWindows = process.platform === 'win32';

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

async function fakePathDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sentry-oc-path-'));
  roots.push(dir);
  if (isWindows) {
    await copyFile(process.execPath, join(dir, 'opencode.exe'));
  } else {
    const target = join(dir, 'opencode');
    await writeFile(
      target,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode version 1.18.32"; fi\nexit 0\n',
    );
    await chmod(target, 0o700);
  }
  return dir;
}

async function tempDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sentry-rt-path-'));
  roots.push(root);
  return join(root, 'data');
}

function credentialEnv(): void {
  saveEnv(
    'SENTRY_OPENCODE_MODEL',
    'SENTRY_OPENCODE_PROVIDER',
    'OPENCODE_API_KEY',
    'SENTRY_OPENCODE_BINARY',
    'SENTRY_OPENCODE_ALLOW_DIRECT',
    'PATH',
  );
  process.env['SENTRY_OPENCODE_MODEL'] = 'opencode-test-model';
  process.env['SENTRY_OPENCODE_PROVIDER'] = 'opencode';
  process.env['OPENCODE_API_KEY'] = 'zen-test-key';
  delete process.env['SENTRY_OPENCODE_BINARY'];
  delete process.env['SENTRY_OPENCODE_ALLOW_DIRECT'];
}

describe('PATH-only OpenCode readiness orchestration (no binary mocks)', () => {
  it('PATH opencode is not blocked for executable-not-found', async () => {
    const fakeDir = await fakePathDir();
    credentialEnv();
    process.env['PATH'] = fakeDir + delimiter + (process.env['PATH'] ?? '');
    const host = new SentryRuntimeHost(await tempDataRoot(), () => undefined);
    try {
      await host.recover();
      const gate = (await host.productionReadiness(['stack_opencode_main'])) as {
        ready: boolean;
        stacks: Array<{ reasons: string[]; warnings: string[] }>;
      };
      const text = JSON.stringify(gate.stacks);
      // The old filesystem-only probe blocked here with
      // 'OpenCode executable not found'; the shared spawn-based probe must not.
      expect(text).not.toContain('OpenCode executable not found');
      expect(text).not.toContain('did not answer its version probe');
    } finally {
      host.close();
    }
  });

  it('explicit bad override fails closed without PATH fallback', async () => {
    const fakeDir = await fakePathDir();
    credentialEnv();
    process.env['PATH'] = fakeDir + delimiter + (process.env['PATH'] ?? '');
    process.env['SENTRY_OPENCODE_BINARY'] = join('no-such-dir', 'opencode-broken');
    const host = new SentryRuntimeHost(await tempDataRoot(), () => undefined);
    try {
      await host.recover();
      const gate = (await host.productionReadiness(['stack_opencode_main'])) as {
        ready: boolean;
        stacks: Array<{ reasons: string[] }>;
      };
      expect(gate.ready).toBe(false);
      expect(JSON.stringify(gate.stacks)).toContain('opencode-broken');
    } finally {
      host.close();
    }
  });
});
