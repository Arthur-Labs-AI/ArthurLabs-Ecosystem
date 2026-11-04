import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostPlatform } from '../../src/main/platform/create-host-platform.js';
import {
  detectLinuxDistribution,
  isCachyOs,
  parseOsRelease,
} from '../../src/main/platform/linux/linux-host-info.js';
import { NativeLinuxPlatform } from '../../src/main/platform/linux/native-linux-platform.js';
import {
  assertSupportedNodeVersion,
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

/**
 * spawnSync is mocked so version validation is hermetic on every host: the
 * PATH search itself still hits the real filesystem (a temp dir holding a
 * `node` placeholder), while `--version` answers a fixed modern version.
 * Real spawnSync ENOENT/status semantics belong to Node stdlib, not to the
 * resolution decisions under test here.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[]) => {
      if (command.includes('nonexistent') || command.includes('no-such-binary')) {
        return { error: new Error('spawnSync ENOENT'), status: null, stdout: '' };
      }
      if (args.includes('--version')) {
        return { status: 0, stdout: 'v22.4.0\n' };
      }
      throw new Error('unexpected spawnSync in test: ' + command);
    },
  };
});

const pathProbeRoots: string[] = [];
afterEach(async () => {
  while (pathProbeRoots.length > 0) {
    const root = pathProbeRoots.pop();
    if (root === undefined) break;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Temp dir containing an executable placeholder named `node`. */
async function fakeNodeDir(): Promise<string> {
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'sentry-path-node-'));
  pathProbeRoots.push(dir);
  await writeFile(join(dir, 'node'), 'placeholder');
  await chmod(join(dir, 'node'), 0o755);
  return dir;
}

describe('native node resolution', () => {
  it('parses node version output into majors', () => {
    expect(parseNodeMajor('v22.4.0\n')).toBe(22);
    expect(parseNodeMajor('v20.19.0')).toBe(20);
    expect(parseNodeMajor('not-node')).toBeUndefined();
  });

  it('accepts the current standalone node binary', async () => {
    const resolved = await resolveNativeNodeExecutable({ executable: process.execPath });
    expect(resolved.executable).toBe(process.execPath);
    expect(resolved.major).toBeGreaterThanOrEqual(22);
  });

  it('resolves PATH node to an absolute validated executable', async () => {
    const dir = await fakeNodeDir();
    const resolved = await resolveNativeNodeExecutable({
      executable: 'node',
      env: { PATH: dir },
    });
    expect(resolved.executable).toBe(posix.join(dir, 'node'));
    // Platform-aware: posix-absolute on Linux, drive-absolute on Windows.
    expect(isAbsolute(resolved.executable)).toBe(true);
    expect(resolved.major).toBe(22);
  });

  it('fails closed when no node executable exists', async () => {
    await expect(
      resolveNativeNodeExecutable({
        executable: 'sentry-test-no-such-binary',
        env: { PATH: '' },
      }),
    ).rejects.toMatchObject({ code: 'LINUX_NODE_UNAVAILABLE' });
    await expect(
      resolveNativeNodeExecutable({ executable: '/nonexistent/sentry-test-node' }),
    ).rejects.toMatchObject({ code: 'LINUX_NODE_UNAVAILABLE' });
  });

  it('rejects old or unparsable node versions', () => {
    expect(assertSupportedNodeVersion('v22.4.0\n', 'node')).toMatchObject({
      version: 'v22.4.0',
      major: 22,
    });
    expect(() => assertSupportedNodeVersion('v20.19.0', 'node')).toThrowError(
      expect.objectContaining({ code: 'LINUX_NODE_UNSUPPORTED' }),
    );
    expect(() => assertSupportedNodeVersion('not-node', 'node')).toThrowError(
      expect.objectContaining({ code: 'LINUX_NODE_UNSUPPORTED' }),
    );
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
