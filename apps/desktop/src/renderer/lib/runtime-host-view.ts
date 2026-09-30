/**
 * Pure host-view derivation for the Runtime Settings page (no React).
 *
 * Windows keeps the WSL distro selector; native Linux shows host facts
 * and never distro/WSL guidance. Unknown (legacy runtimes without host
 * fields, which predate native support and are therefore Windows) keeps
 * the historical WSL UI so nothing silently disappears on old runtimes.
 */

export type RuntimeHostViewKind = 'windows' | 'linux' | 'unknown';

export interface RuntimeHostFacts {
  readonly hostPlatform?: string | undefined;
  readonly executionMode?: string | undefined;
  readonly distro?: string | null | undefined;
  readonly distribution?: { id?: string; prettyName?: string } | null | undefined;
  readonly selected?: string | null | undefined;
  readonly preferred?: string | null | undefined;
}

export interface RuntimeHostView {
  readonly kind: RuntimeHostViewKind;
  /** WSL distro selector + save button. Never shown on native Linux. */
  readonly showDistroSelector: boolean;
  readonly hostLabel: string | undefined;
  readonly executionLabel: string | undefined;
  /** Selected WSL distro, or the native distribution pretty name. */
  readonly distroLabel: string | undefined;
}

function factsOf(value: unknown): RuntimeHostFacts {
  if (typeof value !== 'object' || value === null) return {};
  return value as RuntimeHostFacts;
}

/** Derive the settings view from runtime status + distros payloads. */
export function deriveRuntimeHostView(status: unknown, distros: unknown): RuntimeHostView {
  const primary = factsOf(status);
  const secondary = factsOf(distros);
  const executionMode = primary.executionMode ?? secondary.executionMode;
  const hostPlatform = primary.hostPlatform ?? secondary.hostPlatform;
  if (executionMode === 'native-linux' || hostPlatform === 'linux') {
    const distribution = primary.distribution ?? secondary.distribution ?? undefined;
    const prettyName = distribution?.prettyName;
    return {
      kind: 'linux',
      showDistroSelector: false,
      hostLabel: prettyName ?? 'Linux',
      executionLabel: 'Native Linux',
      distroLabel: prettyName,
    };
  }
  if (executionMode === 'wsl2' || hostPlatform === 'windows') {
    const distro =
      primary.distro ?? secondary.selected ?? secondary.preferred ?? secondary.distro ?? undefined;
    return {
      kind: 'windows',
      showDistroSelector: true,
      hostLabel: 'Windows',
      executionLabel: 'WSL2',
      distroLabel: distro ?? undefined,
    };
  }
  const legacyDistro = primary.distro ?? secondary.selected ?? secondary.preferred ?? undefined;
  return {
    kind: 'unknown',
    showDistroSelector: true,
    hostLabel: legacyDistro === undefined ? undefined : 'Windows',
    executionLabel: legacyDistro === undefined ? undefined : 'WSL2',
    distroLabel: legacyDistro ?? undefined,
  };
}
