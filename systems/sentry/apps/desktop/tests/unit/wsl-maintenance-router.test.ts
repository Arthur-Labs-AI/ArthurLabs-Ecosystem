import { describe, expect, it, vi } from 'vitest';
import { dispatchDesktopCommand, isCliAllowed } from '../../src/main/desktop-command-router.js';
import type { DesktopApplicationService } from '../../src/main/services/desktop-service.js';

describe('Windows maintenance router boundary', () => {
  it('dispatches a parameterless renderer-only compaction request', async () => {
    const reclaimSpace = vi.fn(async () => ({ reconnected: true }));
    const service = {} as DesktopApplicationService;
    await expect(
      dispatchDesktopCommand(service, 'runtime:reclaim-space', {}, { reclaimSpace } as never),
    ).resolves.toEqual({ reconnected: true });
    expect(reclaimSpace).toHaveBeenCalledTimes(1);
    expect(isCliAllowed('runtime:reclaim-space')).toBe(false);
    await expect(
      dispatchDesktopCommand(service, 'runtime:reclaim-space', {}, { reclaimSpace } as never, {
        external: true,
      }),
    ).rejects.toMatchObject({ code: 'CLI_COMMAND_FORBIDDEN' });
    await expect(
      dispatchDesktopCommand(service, 'runtime:reclaim-space', { path: 'C:/another.vhdx' }, {
        reclaimSpace,
      } as never),
    ).rejects.toThrow();
    expect(reclaimSpace).toHaveBeenCalledTimes(1);
  });

  it('blocks both transports during maintenance but keeps status readable', async () => {
    const addProject = vi.fn();
    const runtimeStatus = vi.fn(() => ({ connected: false, maintenance: true }));
    const service = { addProject, runtimeStatus } as unknown as DesktopApplicationService;
    const hooks = { maintenanceActive: () => true };
    for (const external of [false, true]) {
      await expect(
        dispatchDesktopCommand(
          service,
          'projects:add',
          { sourcePath: 'C:/Nexus' },
          hooks as never,
          { external },
        ),
      ).rejects.toMatchObject({ code: 'RUNTIME_MAINTENANCE' });
    }
    expect(addProject).not.toHaveBeenCalled();
    await expect(
      dispatchDesktopCommand(service, 'runtime:status', {}, hooks as never),
    ).resolves.toMatchObject({ maintenance: true });
  });
});
