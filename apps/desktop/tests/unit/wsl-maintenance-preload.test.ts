import { describe, expect, it, vi } from 'vitest';
import type { SentryDesktopApi } from '../../src/shared/ipc-contract.js';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() },
}));

describe('Windows maintenance preload', () => {
  it('exposes only parameterless reclaim and propagates cancellation', async () => {
    await import('../../src/preload/preload.js');
    const api = bridge.expose.mock.calls.find(
      (call) => call[0] === 'sentry',
    )?.[1] as SentryDesktopApi;
    bridge.invoke.mockResolvedValueOnce({ ok: true, result: { reconnected: true } });
    await expect(api.runtime.reclaimSpace()).resolves.toEqual({ reconnected: true });
    expect(bridge.invoke).toHaveBeenLastCalledWith('runtime:reclaim-space', {});
    bridge.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'RUNTIME_BUSY', message: 'QA is active' },
    });
    await expect(api.runtime.reclaimSpace()).rejects.toMatchObject({ code: 'RUNTIME_BUSY' });
  });
});
