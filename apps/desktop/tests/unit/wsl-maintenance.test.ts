import { describe, expect, it, vi } from 'vitest';
import { WslMaintenance } from '../../src/main/wsl-maintenance.js';
import type { RuntimeClient } from '../../src/main/runtime/runtime-client.js';

function fixture() {
  const calls: string[] = [];
  const status = { connected: true };
  const request = vi.fn(async (method: string) => {
    calls.push(method);
    return method === 'runtime.shutdown' ? { shuttingDown: true } : [];
  });
  const stop = vi.fn(async () => {
    calls.push('stop');
    status.connected = false;
  });
  const deps = {
    runtime: { request, stop, status } as unknown as RuntimeClient,
    hostKind: 'windows',
    distro: vi.fn(async () => {
      calls.push('distro');
      return 'Ubuntu';
    }),
    inspect: vi.fn(async () => {
      calls.push('inspect');
    }),
    reclaim: vi.fn(async () => {
      calls.push('compact');
      return {
        distro: 'Ubuntu',
        diskBytesBefore: 100,
        diskBytesAfter: 40,
        windowsFreeBytesBefore: 20,
        windowsFreeBytesAfter: 80,
      };
    }),
    reconnect: vi.fn(async () => {
      calls.push('reconnect');
      status.connected = true;
    }),
    pause: vi.fn(() => {
      calls.push('pause');
    }),
    resume: vi.fn(() => {
      calls.push('resume');
    }),
  };
  return { calls, status, request, stop, deps, controller: new WslMaintenance(deps) };
}

describe('WSL maintenance lifecycle', () => {
  it('requires confirmed shutdown before OS maintenance and reconnects before releasing its gate', async () => {
    const f = fixture();
    f.deps.reclaim.mockImplementation(async () => {
      expect(f.controller.active).toBe(true);
      expect(f.status.connected).toBe(false);
      f.calls.push('compact');
      return {
        distro: 'Ubuntu',
        diskBytesBefore: 100,
        diskBytesAfter: 40,
        windowsFreeBytesBefore: 20,
        windowsFreeBytesAfter: 80,
      };
    });
    await expect(f.controller.reclaimSpace()).resolves.toMatchObject({
      reconnected: true,
      diskBytesAfter: 40,
    });
    expect(f.calls).toEqual([
      'pause',
      'system.activeRuns',
      'distro',
      'inspect',
      'runtime.shutdown',
      'stop',
      'compact',
      'reconnect',
      'resume',
    ]);
    expect(f.controller.active).toBe(false);
  });

  it('takes the gate synchronously and rejects concurrent requests', async () => {
    const f = fixture();
    const first = f.controller.reclaimSpace();
    expect(f.controller.active).toBe(true);
    await expect(f.controller.reclaimSpace()).rejects.toMatchObject({
      code: 'RUNTIME_MAINTENANCE',
    });
    await first;
    expect(f.deps.reclaim).toHaveBeenCalledTimes(1);
  });

  it('does not stop or compact while QA is active', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce([{ runId: 'run_live' }] as never);
    await expect(f.controller.reclaimSpace()).rejects.toMatchObject({ code: 'RUNTIME_BUSY' });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.reclaim).not.toHaveBeenCalled();
    expect(f.status.connected).toBe(true);
    expect(f.controller.active).toBe(false);
  });

  it.each(['RUNTIME_BUSY', 'RUNTIME_REQUESTS_BUSY', 'RUNTIME_TIMEOUT', 'RUNTIME_OFFLINE'])(
    'never compacts when authoritative shutdown refuses or is uncertain: %s',
    async (code) => {
      const f = fixture();
      f.request.mockImplementation(async (method) => {
        if (method === 'runtime.shutdown')
          throw Object.assign(new Error('Shutdown refused'), { code });
        return [];
      });
      await expect(f.controller.reclaimSpace()).rejects.toMatchObject({ code });
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.deps.reclaim).not.toHaveBeenCalled();
      expect(f.deps.reconnect).not.toHaveBeenCalled();
      expect(f.controller.active).toBe(false);
    },
  );

  it.each([undefined, {}, { shuttingDown: false }])(
    'rejects an invalid shutdown acknowledgement: %j',
    async (value) => {
      const f = fixture();
      f.request.mockResolvedValueOnce([]).mockResolvedValueOnce(value as never);
      await expect(f.controller.reclaimSpace()).rejects.toMatchObject({
        code: 'RUNTIME_INVALID_RESULT',
      });
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.deps.reclaim).not.toHaveBeenCalled();
    },
  );

  it('fails before shutdown when the disk registration is unsupported', async () => {
    const f = fixture();
    f.deps.inspect.mockRejectedValue(new Error('Disk registration ambiguous'));
    await expect(f.controller.reclaimSpace()).rejects.toThrow('Disk registration ambiguous');
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.deps.reclaim).not.toHaveBeenCalled();
  });

  it('reconnects after cancelled UAC or native failure and permits a retry', async () => {
    const f = fixture();
    f.deps.reclaim.mockRejectedValueOnce(new Error('Administrator approval was cancelled'));
    await expect(f.controller.reclaimSpace()).rejects.toThrow('cancelled');
    expect(f.deps.reconnect).toHaveBeenCalledTimes(1);
    expect(f.status.connected).toBe(true);
    expect(f.controller.active).toBe(false);
    await expect(f.controller.reclaimSpace()).resolves.toMatchObject({ reconnected: true });
  });

  it('reports successful compaction independently of reconnect failure', async () => {
    const f = fixture();
    f.deps.reconnect.mockRejectedValue(new Error('Release identity mismatch'));
    await expect(f.controller.reclaimSpace()).resolves.toMatchObject({
      reconnected: false,
      diskBytesAfter: 40,
    });
    expect(f.controller.active).toBe(false);
    expect(f.deps.resume).not.toHaveBeenCalled();
  });

  it('reports failure to recover after a compaction error', async () => {
    const f = fixture();
    f.deps.reclaim.mockRejectedValue(new Error('Disk in use'));
    f.deps.reconnect.mockRejectedValue(new Error('Cannot restart'));
    await expect(f.controller.reclaimSpace()).rejects.toMatchObject({
      code: 'MAINTENANCE_RECOVERY_FAILED',
    });
    expect(f.controller.active).toBe(false);
  });

  it('reconnects if transport cleanup fails after accepted shutdown', async () => {
    const f = fixture();
    f.stop.mockRejectedValue(new Error('Transport cleanup failed'));
    await expect(f.controller.reclaimSpace()).rejects.toThrow('Transport cleanup failed');
    expect(f.deps.reclaim).not.toHaveBeenCalled();
    expect(f.deps.reconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['linux', 'offline'])(
    'rejects unsupported/offline hosts before touching the OS: %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'linux') f.deps.hostKind = 'linux';
      else f.status.connected = false;
      await expect(f.controller.reclaimSpace()).rejects.toThrow();
      expect(f.deps.pause).not.toHaveBeenCalled();
      expect(f.deps.inspect).not.toHaveBeenCalled();
      expect(f.deps.reclaim).not.toHaveBeenCalled();
    },
  );
});
