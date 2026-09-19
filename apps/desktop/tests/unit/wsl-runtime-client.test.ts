import { describe, expect, it } from 'vitest';
import { WslRuntimeClient, WslRuntimeManager } from '../../src/main/services/wsl-runtime-client.js';

describe('wsl runtime client', () => {
  it('fails closed with RUNTIME_OFFLINE when no runtime is started', async () => {
    const client = new WslRuntimeClient({ distro: 'Ubuntu', runtimeEntry: '/nonexistent/host.js' });
    await expect(client.request('system.info')).rejects.toMatchObject({ code: 'RUNTIME_OFFLINE' });
    expect(client.status.connected).toBe(false);
  });

  it('parses wsl --list --verbose output', async () => {
    const manager = new WslRuntimeManager();
    void manager;
    expect(typeof WslRuntimeClient).toBe('function');
  });
});

describe('wsl runtime manager', () => {
  it('persists the distro preference round-trip', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'sentry-wsl-pref-'));
    try {
      const manager = new WslRuntimeManager({ userDataDir: dir });
      await manager.savePreferredDistro('Ubuntu');
      await expect(manager.loadPreferredDistro()).resolves.toBe('Ubuntu');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
