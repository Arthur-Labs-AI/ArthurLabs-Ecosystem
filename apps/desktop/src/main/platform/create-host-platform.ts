/**
 * Host-platform factory: process.platform in, HostPlatform out.
 *
 * Routing stays here so bootstrap.ts never accumulates platform branches.
 * Every seam (platform override, env, os-release reader) exists so tests
 * can prove routing without mutating the CI host.
 */
import type { HostPlatform } from './host-platform.js';
import { WindowsWslPlatform } from './windows/windows-wsl-platform.js';

export interface CreateHostPlatformOptions {
  /** Override for tests; defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Electron userData dir: persists the WSL distro preference (Windows). */
  readonly userDataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Absolute Linux data-root override forwarded as --data-root. */
  readonly dataRoot?: string;
  /** Explicit standalone Node binary (native Linux; SENTRY_NODE_BINARY). */
  readonly nodeExecutable?: string;
  /** Explicit runtime entry (SENTRY_RUNTIME_ENTRY). */
  readonly runtimeEntry?: string;
  /** Override for tests; defaults to reading /etc/os-release on Linux. */
  readonly readOsRelease?: () => Promise<string | undefined>;
}

function unsupportedPlatform(platform: string): Error {
  return Object.assign(
    new Error(
      'Unsupported host platform: ' +
        platform +
        '. Sentry Desktop supports Windows (WSL2) and CachyOS Linux.',
    ),
    { code: 'HOST_PLATFORM_UNSUPPORTED' },
  );
}

export async function createHostPlatform(
  options: CreateHostPlatformOptions = {},
): Promise<HostPlatform> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return new WindowsWslPlatform({
      ...(options.userDataDir === undefined ? {} : { userDataDir: options.userDataDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    });
  }
  throw unsupportedPlatform(platform);
}
