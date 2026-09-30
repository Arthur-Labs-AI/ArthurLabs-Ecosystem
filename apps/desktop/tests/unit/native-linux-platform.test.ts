import { describe, expect, it } from 'vitest';
import { createHostPlatform } from '../../src/main/platform/create-host-platform.js';
import {
  detectLinuxDistribution,
  isCachyOs,
  parseOsRelease,
} from '../../src/main/platform/linux/linux-host-info.js';
import { NativeLinuxPlatform } from '../../src/main/platform/linux/native-linux-platform.js';
import {
  parseNodeMajor,
  resolveNativeNodeExecutable,
  resolveNativeRuntimeEntry,
} from '../../src/main/platform/linux/native-linux-platform.js';

const CACHYOS_RELEASE = [
  'NAME="CachyOS Linux"',
  'PRETTY_NAME="CachyOS"',
  'ID=cachyos',
  'ID_LIKE=arch',
  'VERSION="251210"',
].join('\n');

const UBUNTU_RELEASE = [
  'NAME="Ubuntu"',
  'PRETTY_NAME="Ubuntu 24.04 LTS"',
  'ID=ubuntu',
  'ID_LIKE=debian',
].join('\n');

const ARCH_RELEASE = [
  'NAME="Arch Linux"',
  'PRETTY_NAME="Arch Linux"',
  'ID=arch',
  'BUILD_ID=rolling',
].join('\n');

const CACHYOS_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/test',
  SENTRY_RUNTIME_ENTRY: '/home/test/runtime/host.js',
};

function cachyOsPlatform(extra: Record<string, string> = {}): NativeLinuxPlatform {
  return new NativeLinuxPlatform({
    env: { ...CACHYOS_ENV, ...extra },
    nodeExecutable: process.execPath,
    readOsRelease: () => Promise.resolve(CACHYOS_RELEASE),
  });
}

describe('linux host detection', () => {
  it('parses CachyOS os-release facts', () => {
    const info = parseOsRelease(CACHYOS_RELEASE);
    expect(info.id).toBe('cachyos');
    expect(info.idLike).toBe('arch');
    expect(info.prettyName).toBe('CachyOS');
    expect(isCachyOs(info)).toBe(true);
  });

  it('rejects Ubuntu and generic Arch as non-CachyOS', () => {
    expect(isCachyOs(parseOsRelease(UBUNTU_RELEASE))).toBe(false);
    expect(isCachyOs(parseOsRelease(ARCH_RELEASE))).toBe(false);
    expect(isCachyOs(undefined)).toBe(false);
  });

  it('returns undefined when os-release is unreadable or empty', async () => {
    await expect(
      detectLinuxDistribution(() => Promise.resolve(undefined)),
    ).resolves.toBeUndefined();
    await expect(detectLinuxDistribution(() => Promise.resolve('   \n'))).resolves.toBeUndefined();
    await expect(
      detectLinuxDistribution(() => Promise.resolve(CACHYOS_RELEASE)),
    ).resolves.toMatchObject({ id: 'cachyos' });
  });
});

describe('native node resolution', () => {
  it('parses node version output into majors', () => {
    expect(parseNodeMajor('v22.4.0\n')).toBe(22);
    expect(parseNodeMajor('v20.19.0')).toBe(20);
    expect(parseNodeMajor('not-node')).toBeUndefined();
  });

  it('accepts the current standalone node binary', () => {
    const resolved = resolveNativeNodeExecutable({ executable: process.execPath });
    expect(resolved.major).toBeGreaterThanOrEqual(22);
  });

  it('fails closed when no node executable exists', () => {
    expect(() =>
      resolveNativeNodeExecutable({ executable: '/nonexistent/sentry-test-node' }),
    ).toThrowError(expect.objectContaining({ code: 'LINUX_NODE_UNAVAILABLE' }));
  });

  it('resolves the native runtime entry from override or HOME layout', () => {
    expect(resolveNativeRuntimeEntry({ SENTRY_RUNTIME_ENTRY: '/custom/host.js' })).toBe(
      '/custom/host.js',
    );
    expect(resolveNativeRuntimeEntry({ HOME: '/home/test' })).toBe(
      '/home/test/.local/share/sentry/runtime/current/apps/runtime/dist/host.js',
    );
    expect(() => resolveNativeRuntimeEntry({})).toThrowError(
      expect.objectContaining({ code: 'LINUX_HOME_UNRESOLVED' }),
    );
  });
});

describe('native linux platform', () => {
  it('routes linux + CachyOS to the native platform', async () => {
    const host = await createHostPlatform({
      platform: 'linux',
      readOsRelease: () => Promise.resolve(CACHYOS_RELEASE),
    });
    expect(host).toBeInstanceOf(NativeLinuxPlatform);
    expect(host.hostKind).toBe('linux');
    expect(host.executionMode).toBe('native-linux');
  });

  it('rejects Ubuntu with LINUX_DISTRO_UNSUPPORTED', async () => {
    await expect(
      createHostPlatform({
        platform: 'linux',
        readOsRelease: () => Promise.resolve(UBUNTU_RELEASE),
      }),
    ).rejects.toMatchObject({ code: 'LINUX_DISTRO_UNSUPPORTED' });
  });

  it('rejects generic Arch with LINUX_DISTRO_UNSUPPORTED', async () => {
    await expect(
      createHostPlatform({ platform: 'linux', readOsRelease: () => Promise.resolve(ARCH_RELEASE) }),
    ).rejects.toMatchObject({ code: 'LINUX_DISTRO_UNSUPPORTED' });
  });

  it('rejects unreadable host facts without claiming a distro', async () => {
    const failure = await createHostPlatform({
      platform: 'linux',
      readOsRelease: () => Promise.resolve(undefined),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'LINUX_DISTRO_UNSUPPORTED' });
    if (!(failure instanceof Error)) throw new Error('expected an Error');
    expect(failure.message).toContain('CachyOS only');
  });

  it('passes native source paths through, including /mnt', async () => {
    const host = cachyOsPlatform();
    await expect(host.prepareSourcePath('/home/test/repo')).resolves.toBe('/home/test/repo');
    await expect(host.prepareSourcePath('/mnt/storage/repo')).resolves.toBe('/mnt/storage/repo');
  });

  it('fails closed on Windows-style and relative source paths', async () => {
    const host = cachyOsPlatform();
    await expect(host.prepareSourcePath('C:\\repo')).rejects.toMatchObject({
      code: 'INVALID_SOURCE_PATH',
    });
    await expect(host.prepareSourcePath('relative/path')).rejects.toMatchObject({
      code: 'INVALID_SOURCE_PATH',
    });
  });

  it('reports normalized native host info instead of distros', async () => {
    const host = cachyOsPlatform();
    await expect(host.runtimeDistros()).resolves.toMatchObject({
      distros: [],
      preferred: null,
      selected: null,
      hostPlatform: 'linux',
      executionMode: 'native-linux',
      distribution: { id: 'cachyos', prettyName: 'CachyOS' },
    });
    const info = await host.runtimeEnvironmentInfo();
    expect(info.distribution).toEqual({ id: 'cachyos', prettyName: 'CachyOS' });
    expect(info.runtimeEntry).toBe('/home/test/runtime/host.js');
  });

  it('rejects distro selection as a typed unsupported operation', async () => {
    const host = cachyOsPlatform();
    await expect(host.runtimeSelectDistro('Ubuntu')).rejects.toMatchObject({
      code: 'DISTRO_SELECTION_UNSUPPORTED',
    });
  });

  it('creates a native client bound to the resolved node and entry', async () => {
    const host = cachyOsPlatform();
    const client = await host.createRuntimeClient();
    expect(client.status).toMatchObject({ hostPlatform: 'linux', executionMode: 'native-linux' });
    expect(client.status.distribution).toEqual({ id: 'cachyos', prettyName: 'CachyOS' });
    await client.stop();
  });
});
