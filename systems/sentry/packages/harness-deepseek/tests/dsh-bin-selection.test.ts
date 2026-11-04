import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seenOptions: unknown[] = [];

vi.mock('@deepseek-ai/dsh-sdk-client', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    DeepSeekHarness: class {
      constructor(options: unknown) {
        seenOptions.push(options);
      }
      async start() {}
      async run() {
        return { sessionId: 's', finalResponse: '', events: [] };
      }
      async close() {}
    },
  };
});

import { createProductionDeepSeekClient } from '../src/sdk.js';

function factoryInput(executable?: string) {
  return {
    ...(executable === undefined ? {} : { executable }),
    cwd: '/tmp/sentry-ds-test',
    dshHome: '/tmp/sentry-ds-test-home',
    environment: {},
    modelId: 'deepseek-v4-flash',
    provider: 'deepseek-official',
    profilePatches: [],
    initializeTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
  };
}

function lastDshBin(): string | undefined {
  const last = seenOptions[seenOptions.length - 1] as { dshBin?: unknown } | undefined;
  return typeof last?.dshBin === 'string' ? last.dshBin : undefined;
}

describe('production DeepSeek client dshBin selection', () => {
  beforeEach(() => {
    seenOptions.length = 0;
  });

  it('A: never passes a shell wrapper path as dshBin', async () => {
    await createProductionDeepSeekClient(
      factoryInput('/home/user/.local/share/sentry/tools/deepseek/bin/dsh'),
    );
    expect(lastDshBin()).toBeUndefined();
  });

  it('B: never forces a bare executable name as dshBin', async () => {
    await createProductionDeepSeekClient(factoryInput('dsh'));
    expect(lastDshBin()).toBeUndefined();
  });

  it('C: passes a real JS runtime entrypoint through as dshBin', async () => {
    const entry =
      '/home/user/.local/share/sentry/runtime/current/apps/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
    await createProductionDeepSeekClient(factoryInput(entry));
    expect(lastDshBin()).toBe(entry);
  });

  it('D: a Bash fixture is never Node-launched via dshBin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentry-dsh-fixture-'));
    try {
      const fixture = join(dir, 'dsh');
      await writeFile(fixture, '#!/usr/bin/env bash\necho "0.1.5-rc.2"\n');
      try {
        await chmod(fixture, 0o700);
      } catch {
        // Windows: best-effort.
      }
      await createProductionDeepSeekClient(factoryInput(fixture));
      expect(lastDshBin()).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
