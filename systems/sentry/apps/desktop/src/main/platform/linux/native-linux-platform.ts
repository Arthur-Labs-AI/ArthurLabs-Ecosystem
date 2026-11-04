/**
 * Native Linux host platform: Electron Desktop -> native Node.js child
 * -> Sentry Linux Runtime. CachyOS only.
 *
 * The runtime uses the SAME Linux data layout as WSL (no second
 * filesystem layout): $HOME/.local/share/sentry/runtime/current/….
 * No shell is ever involved in the launch; Node is a standalone binary
 * validated at >= 22 — never process.execPath, which may point at
 * Electron once packaged. Nothing is installed here; setup stages own that.
 */
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import type { RuntimeClient } from '../../runtime/runtime-client.js';
import type { HostPlatform, HostRuntimeInfo } from '../host-platform.js';
import {
  detectLinuxDistribution,
  isCachyOs,
  unsupportedDistroError,
  type LinuxDistributionInfo,
} from './linux-host-info.js';
import { NativeLinuxRuntimeClient } from './native-linux-runtime-client.js';

export interface NativeLinuxPlatformOptions {
  readonly dataRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit standalone Node binary (SENTRY_NODE_BINARY); else PATH `node`. */
  readonly nodeExecutable?: string;
  /** Explicit runtime entry (SENTRY_RUNTIME_ENTRY); else $HOME layout. */
  readonly runtimeEntry?: string;
  readonly readOsRelease?: () => Promise<string | undefined>;
  /** Injected distribution facts (tests); otherwise detected from the host. */
  readonly distribution?: LinuxDistributionInfo;
}

export interface NativeNodeResolution {
  readonly executable: string;
  readonly version: string;
  readonly major: number;
}

/** Minimum standalone Node major version for the native runtime. */
export const NATIVE_NODE_MIN_MAJOR = 22;

/** Parse `v22.1.0` (or `22.1.0`) into a major version; undefined when unparsable. */
export function parseNodeMajor(versionOutput: string): number | undefined {
  const match = /^v?(\d+)\./.exec(versionOutput.trim());
  if (match?.[1] === undefined) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

/**
 * Enforce the supported Node major on `--version` output (pure, unit-tested).
 */
export function assertSupportedNodeVersion(
  versionOutput: string,
  executable: string,
): { version: string; major: number } {
  const version = versionOutput.trim();
  const major = parseNodeMajor(version);
  if (major === undefined || major < NATIVE_NODE_MIN_MAJOR) {
    throw Object.assign(
      new Error(
        'Standalone Node.js ' +
          version.slice(0, 50) +
          ' is too old: Sentry requires Node >= ' +
          String(NATIVE_NODE_MIN_MAJOR) +
          '. ' +
          executable,
      ),
      { code: 'LINUX_NODE_UNSUPPORTED' },
    );
  }
  return { version, major };
}

/**
 * Direct PATH search (colon-separated, executable bit) — no shell, no
 * `command -v`. Returns undefined when the command resolves nowhere.
 */
/**
 * Split a PATH value on colons, keeping a Windows drive prefix (`C:`)
 * attached to the segment it introduces. Plain POSIX entries never take
 * that shape, so native Linux lists are unaffected.
 */
function splitPathList(pathValue: string): string[] {
  const raw = pathValue.split(':');
  const dirs: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const segment = raw[index];
    const next = raw[index + 1];
    if (
      segment !== undefined &&
      /^[A-Za-z]$/.test(segment) &&
      next !== undefined &&
      (next.startsWith('/') || next.startsWith('\\'))
    ) {
      dirs.push(segment + ':' + next);
      index += 1;
    } else if (segment !== undefined && segment.length > 0) {
      dirs.push(segment);
    }
  }
  return dirs;
}

async function findExecutableOnPath(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string | undefined> {
  const pathValue = env?.['PATH'] ?? process.env['PATH'] ?? '';
  const { access, constants } = await import('node:fs/promises');
  for (const dir of splitPathList(pathValue)) {
    // POSIX join deliberately: this resolves native Linux executables even
    // when its tests execute on a Windows dev machine.
    const candidate = posix.join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable here — keep searching.
    }
  }
  return undefined;
}

/**
 * Resolve the standalone Node executable to an absolute validated path:
 * explicit override first (absolute overrides stay absolute), else a PATH
 * search for `node`. No shell is ever executed; the launcher spawns the
 * resolved path directly. Fails closed when Node is missing or too old.
 */
export async function resolveNativeNodeExecutable(options: {
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<NativeNodeResolution> {
  const configured = (options.executable ?? options.env?.['SENTRY_NODE_BINARY'] ?? 'node').trim();
  if (configured.length === 0) {
    throw Object.assign(new Error('No standalone Node.js executable configured.'), {
      code: 'LINUX_NODE_UNAVAILABLE',
    });
  }
  // Either slash marks an explicit path (POSIX or Windows spelling); only
  // bare names go through the PATH search.
  const executable =
    configured.includes('/') || configured.includes('\\')
      ? configured
      : await findExecutableOnPath(configured, options.env);
  if (executable === undefined) {
    throw Object.assign(
      new Error('No standalone Node.js executable found on PATH (' + configured + ').'),
      { code: 'LINUX_NODE_UNAVAILABLE' },
    );
  }
  let output: string;
  try {
    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(String(result.error ?? 'exit ' + String(result.status)));
    }
    output = String(result.stdout ?? '');
  } catch (error) {
    throw Object.assign(
      new Error(
        'No standalone Node.js executable found (' +
          executable +
          '): ' +
          (error instanceof Error ? error.message : String(error)).slice(0, 200),
      ),
      { code: 'LINUX_NODE_UNAVAILABLE' },
    );
  }
  const { version, major } = assertSupportedNodeVersion(output, executable);
  return { executable, version, major };
}

/**
 * Native runtime entry: SENTRY_RUNTIME_ENTRY override, else the shared
 * Linux data layout under the real user HOME (never Electron userData).
 */
export function resolveNativeRuntimeEntry(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['SENTRY_RUNTIME_ENTRY'];
  if (override !== undefined && override.length > 0) return override;
  const home = env['HOME'];
  if (home === undefined || home.length === 0) {
    throw Object.assign(new Error('Cannot resolve the native runtime entry: $HOME is not set.'), {
      code: 'LINUX_HOME_UNRESOLVED',
    });
  }
  return home.replace(/\/$/, '') + '/.local/share/sentry/runtime/current/apps/runtime/dist/host.js';
}

function toError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class NativeLinuxPlatform implements HostPlatform {
  readonly hostKind = 'linux' as const;
  readonly executionMode = 'native-linux' as const;
  private readonly dataRoot: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nodeExecutable: string | undefined;
  private readonly runtimeEntryOverride: string | undefined;
  private readonly readOsRelease: (() => Promise<string | undefined>) | undefined;
  private readonly distributionOverride: LinuxDistributionInfo | undefined;
  private distributionCache: LinuxDistributionInfo | undefined;
  private nodeCache: NativeNodeResolution | undefined;
  private runtimeEntryCache: string | undefined;

  constructor(options: NativeLinuxPlatformOptions = {}) {
    this.dataRoot = options.dataRoot;
    this.env = options.env ?? process.env;
    this.nodeExecutable = options.nodeExecutable;
    this.runtimeEntryOverride = options.runtimeEntry;
    this.readOsRelease = options.readOsRelease;
    this.distributionOverride = options.distribution;
  }

  async createRuntimeClient(): Promise<RuntimeClient> {
    const distribution = await this.requireCachyOs();
    const node = await this.nodeResolution();
    const runtimeEntry = this.entryResolution();
    return new NativeLinuxRuntimeClient({
      nodeExecutable: node.executable,
      runtimeEntry,
      ...(this.dataRoot === undefined ? {} : { dataRoot: this.dataRoot }),
      distribution: { id: distribution.id, prettyName: distribution.prettyName },
    });
  }

  /**
   * Native paths pass through (normalized): absolute Linux paths only,
   * including /mnt/* — a normal location on native Linux. Windows drive
   * paths and relative paths fail closed; nothing is translated.
   */
  async prepareSourcePath(path: string): Promise<string> {
    if (!path.startsWith('/')) {
      throw toError(
        'INVALID_SOURCE_PATH',
        'Native Linux source paths must be absolute: ' + path.slice(0, 120),
      );
    }
    // POSIX semantics explicitly: this code prepares native Linux paths even
    // when its tests execute on a Windows dev machine (win32 normalize
    // would emit backslashes).
    return posix.normalize(path);
  }

  async runtimeEnvironmentInfo(): Promise<HostRuntimeInfo> {
    const distribution = await this.requireCachyOs();
    const node = await this.nodeResolution();
    return {
      hostPlatform: 'linux',
      executionMode: 'native-linux',
      distribution: { id: distribution.id, prettyName: distribution.prettyName },
      runtimeEntry: this.entryResolution(),
      node: { executable: node.executable, version: node.version },
    };
  }

  /** Normalized native host info: there is no distro to choose on Linux. */
  async runtimeDistros(): Promise<unknown> {
    const info = await this.runtimeEnvironmentInfo();
    return {
      distros: [],
      preferred: null,
      selected: null,
      hostPlatform: info.hostPlatform,
      executionMode: info.executionMode,
      distribution: info.distribution,
    };
  }

  async runtimeSelectDistro(distro: string): Promise<unknown> {
    void distro;
    throw toError(
      'DISTRO_SELECTION_UNSUPPORTED',
      'Distribution selection applies to Windows (WSL) only; native Linux uses the current CachyOS host.',
    );
  }

  private async requireCachyOs(): Promise<LinuxDistributionInfo> {
    if (this.distributionCache === undefined) {
      const detected =
        this.distributionOverride ??
        (await (this.readOsRelease === undefined
          ? detectLinuxDistribution()
          : detectLinuxDistribution(this.readOsRelease)));
      if (detected === undefined) {
        throw unsupportedDistroError('unknown');
      }
      if (!isCachyOs(detected)) {
        throw unsupportedDistroError(detected.prettyName);
      }
      this.distributionCache = detected;
    }
    return this.distributionCache;
  }

  private async nodeResolution(): Promise<NativeNodeResolution> {
    if (this.nodeCache === undefined) {
      this.nodeCache = await resolveNativeNodeExecutable({
        ...(this.nodeExecutable === undefined ? {} : { executable: this.nodeExecutable }),
        env: this.env,
      });
    }
    return this.nodeCache;
  }

  private entryResolution(): string {
    if (this.runtimeEntryCache === undefined) {
      if (this.runtimeEntryOverride !== undefined && this.runtimeEntryOverride.length > 0) {
        this.runtimeEntryCache = this.runtimeEntryOverride;
      } else {
        this.runtimeEntryCache = resolveNativeRuntimeEntry(this.env);
      }
    }
    return this.runtimeEntryCache;
  }
}
