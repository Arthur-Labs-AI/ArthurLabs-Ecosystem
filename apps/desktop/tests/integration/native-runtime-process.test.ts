import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeLinuxRuntimeClient } from '../../src/main/platform/linux/native-linux-runtime-client.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeEntry = join(desktopRoot, '..', 'runtime', 'dist', 'host.js');
const entryExists = existsSync(runtimeEntry);

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Real native runtime process boundary (generic-Linux transport
 * acceptance, NOT a product-support claim): spawns standalone Node on the
 * built runtime entry with piped stdio — no spawn mock, no CachyOS host
 * detection (GitHub CI runs Ubuntu), no providers, no keys, no paid calls.
 * Requires the built runtime (`turbo test` builds first); skipped when the
 * entry is absent so direct vitest runs without a build stay green.
 */
describe.runIf(process.platform === 'linux' && entryExists)('native runtime child process', () => {
  it('handshakes, serves RPC, and shuts down gracefully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sentry-native-spawn-'));
    roots.push(root);
    const dataRoot = await realpath(root);
    const client = new NativeLinuxRuntimeClient({
      // Acceptable here because this test runs under standalone Node,
      // never Electron. Production resolution never uses execPath.
      nodeExecutable: process.execPath,
      runtimeEntry,
      dataRoot,
    });
    const hello = await client.start();
    try {
      expect(hello.platform).toBe('linux');
      expect(hello.isWsl).toBe(false);
      expect(hello.isElectron).toBe(false);
      expect(hello.processExecPath.toLowerCase()).not.toContain('electron');
      expect(client.status.connected).toBe(true);
      expect(client.status).toMatchObject({
        hostPlatform: 'linux',
        executionMode: 'native-linux',
      });
      const info = (await client.request('system.info', {}, 30000)) as {
        dataRoot: string;
        versions: Record<string, string>;
      };
      expect(await realpath(info.dataRoot)).toBe(dataRoot);
      expect(typeof info.versions).toBe('object');
    } finally {
      await client.stop();
    }
    // stop() resolves only after the child exits (or the bounded kill
    // fallback fires): offline here proves the real process is gone.
    expect(client.status.connected).toBe(false);
    // And the transport restarts cleanly against a fresh child.
    const second = await client.start();
    expect(second.platform).toBe('linux');
    await client.stop();
    expect(client.status.connected).toBe(false);
  }, 120000);
});

describe.runIf(process.platform !== 'linux' || !entryExists)('native runtime child process', () => {
  it('skips outside generic-Linux CI with a built runtime', () => {
    expect(process.platform === 'linux' && entryExists).toBe(false);
  });
});
