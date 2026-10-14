import { describe, expect, it, vi } from 'vitest';
import type { SentryDesktopApi } from '../../src/shared/ipc-contract.js';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() },
}));

describe('project removal preload bridge', () => {
  it('exposes removal only through the project ID contract and propagates errors', async () => {
    await import('../../src/preload/preload.js');
    const api = bridge.expose.mock.calls.find(
      (call) => call[0] === 'sentry',
    )?.[1] as SentryDesktopApi;
    bridge.invoke.mockResolvedValueOnce({
      ok: true,
      result: { projectId: 'proj_fixture', deleted: true },
    });
    await expect(api.projects.remove('proj_fixture')).resolves.toEqual({
      projectId: 'proj_fixture',
      deleted: true,
    });
    expect(bridge.invoke).toHaveBeenLastCalledWith('projects:delete', {
      projectId: 'proj_fixture',
    });
    bridge.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'PROJECT_LOCKED', message: 'Project is active' },
    });
    await expect(api.projects.remove('proj_fixture')).rejects.toMatchObject({
      code: 'PROJECT_LOCKED',
      message: 'Project is active',
    });
  });
});
