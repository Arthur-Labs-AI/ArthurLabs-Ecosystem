/**
 * Boot-failure classification for the fatal startup screen (Electron main).
 *
 * A runtime startup failure must never show WSL guidance on CachyOS (or
 * vice versa). Classification prefers structured host identity attached
 * to the error (hostPlatform/executionMode) and only falls back to
 * message matching for legacy unstructured errors — never the reverse.
 */
import type { ExecutionMode, HostKind } from './runtime/runtime-client.js';
import { toSafeError, type SafeErrorOptions } from './desktop-command-router.js';

export type FatalScreenKind = 'wsl-runtime-offline' | 'native-runtime-offline' | 'data-store';

export interface BootFailureClassification {
  readonly kind: FatalScreenKind;
  readonly code: string;
  readonly message: string;
}

function errorField(error: unknown, field: 'hostPlatform' | 'executionMode'): string | undefined {
  try {
    if (typeof error === 'object' && error !== null && field in error) {
      const value = (error as Record<string, unknown>)[field];
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    // Unreadable metadata cannot override the generic failure classification.
  }
  return undefined;
}

/** Classify a bootstrap failure into the fatal screen it must show. */
export function classifyBootFailure(
  error: unknown,
  options: SafeErrorOptions = {},
): BootFailureClassification {
  const { code, message } = toSafeError(error, options);
  const hostPlatform = errorField(error, 'hostPlatform') as HostKind | undefined;
  const executionMode = errorField(error, 'executionMode') as ExecutionMode | undefined;
  const nativeByStructure = hostPlatform === 'linux' || executionMode === 'native-linux';
  const wslByStructure = hostPlatform === 'windows' || executionMode === 'wsl2';
  let kind: FatalScreenKind;
  if (
    code === 'LINUX_DISTRO_UNSUPPORTED' ||
    code === 'LINUX_NODE_UNAVAILABLE' ||
    code === 'LINUX_NODE_UNSUPPORTED' ||
    code === 'LINUX_HOME_UNRESOLVED' ||
    code === 'HOST_PLATFORM_UNSUPPORTED'
  ) {
    kind = 'native-runtime-offline';
  } else if (code === 'WSL_UNAVAILABLE' || code === 'WSL_NO_DISTRO') {
    kind = 'wsl-runtime-offline';
  } else if (code === 'RUNTIME_OFFLINE' || code === 'RUNTIME_TIMEOUT') {
    if (nativeByStructure) kind = 'native-runtime-offline';
    else if (wslByStructure) kind = 'wsl-runtime-offline';
    else if (/cachyos|native[ -]linux/i.test(message)) kind = 'native-runtime-offline';
    else if (/runtime|wsl|handshake/i.test(message)) kind = 'wsl-runtime-offline';
    else kind = 'data-store';
  } else if (/cachyos|native[ -]linux/i.test(message)) {
    kind = 'native-runtime-offline';
  } else if (/runtime|wsl|handshake/i.test(message)) {
    kind = 'wsl-runtime-offline';
  } else {
    kind = 'data-store';
  }
  return { kind, code, message };
}

export interface FatalScreenCopy {
  readonly title: string;
  readonly heading: string;
  readonly intro: string;
  readonly help: string;
}

/** Fatal screen copy per kind. The native path never mentions WSL/Ubuntu. */
export function fatalScreenCopy(kind: FatalScreenKind): FatalScreenCopy {
  if (kind === 'native-runtime-offline') {
    return {
      title: 'Sentry — runtime offline',
      heading: 'Sentry Runtime Offline',
      intro: 'Sentry Desktop is running, but the native Linux execution runtime could not start.',
      help: 'QA execution is disabled. Native Linux support currently targets CachyOS only.',
    };
  }
  if (kind === 'wsl-runtime-offline') {
    return {
      title: 'Sentry — runtime offline',
      heading: 'Sentry Runtime Offline',
      intro: 'Sentry Desktop is running, but the WSL2 execution runtime could not start.',
      help: 'QA execution is disabled. See docs/setup/wsl-runtime.md for setup instructions.',
    };
  }
  return {
    title: 'Sentry — data store unavailable',
    heading: 'Sentry could not open its data store.',
    intro: '',
    help: 'Fix the data root (SENTRY_DATA_ROOT) and retry.',
  };
}
