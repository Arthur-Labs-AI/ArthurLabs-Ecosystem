import { describe, expect, it } from 'vitest';
import { createHostPlatform } from '../../src/main/platform/create-host-platform.js';
import {
  runtimeEntryForDistro,
  WindowsWslPlatform,
} from '../../src/main/platform/windows/windows-wsl-platform.js';

describe('host platform routing', () => {
  it('routes win32 to the Windows/WSL platform', async () => {
    const host = await createHostPlatform({ platform: 'win32' });
    expect(host).toBeInstanceOf(WindowsWslPlatform);
    expect(host.hostKind).toBe('windows');
    expect(host.executionMode).toBe('wsl2');
  });

  it('rejects unsupported hosts with a typed error', async () => {
    await expect(createHostPlatform({ platform: 'darwin' })).rejects.toMatchObject({
      code: 'HOST_PLATFORM_UNSUPPORTED',
    });
  });

  it('passes non-Windows source paths through unchanged (no wslpath spawn)', async () => {
    const host = new WindowsWslPlatform();
    await expect(host.prepareSourcePath('/home/test/project')).resolves.toBe('/home/test/project');
    await expect(host.prepareSourcePath('relative/path')).resolves.toBe('relative/path');
  });

  it('honors SENTRY_RUNTIME_ENTRY without probing WSL', async () => {
    await expect(
      runtimeEntryForDistro('Ubuntu', { SENTRY_RUNTIME_ENTRY: '/custom/host.js' }),
    ).resolves.toBe('/custom/host.js');
  });
});
