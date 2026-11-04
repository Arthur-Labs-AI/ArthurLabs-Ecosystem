/**
 * Read-only native Linux host detection (Electron main).
 *
 * Native Desktop startup is supported on CachyOS only: ID=cachyos in
 * /etc/os-release. Every other Linux distribution fails closed with
 * LINUX_DISTRO_UNSUPPORTED — including Arch/Ubuntu/Fedora, even though
 * the runtime itself might technically execute there. GitHub Actions
 * ubuntu-latest jobs therefore prove only that generic Linux code
 * compiles and tests; they never imply Ubuntu support.
 */

export interface LinuxDistributionInfo {
  /** Lower-cased ID field (e.g. 'cachyos'). */
  readonly id: string;
  /** Lower-cased ID_LIKE field, when present. */
  readonly idLike?: string | undefined;
  /** Human-readable PRETTY_NAME (or NAME) for diagnostics. */
  readonly prettyName: string;
}

/** The only native Linux distribution Sentry Desktop supports. */
export const CACHYOS_DISTRIBUTION_ID = 'cachyos';

/** Parse /etc/os-release content (KEY=value, optionally quoted). */
export function parseOsRelease(content: string): LinuxDistributionInfo {
  const fields = new Map<string, string>();
  for (const line of content.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const raw = match[2].trim();
    const unquoted =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    fields.set(match[1], unquoted);
  }
  const id = (fields.get('ID') ?? '').toLowerCase();
  const idLike = fields.get('ID_LIKE')?.toLowerCase();
  const prettyName = fields.get('PRETTY_NAME') ?? fields.get('NAME') ?? id;
  return { id, ...(idLike === undefined ? {} : { idLike }), prettyName };
}

/** Read /etc/os-release; undefined when unreadable (not a Linux host). */
export async function readOsReleaseFile(): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile('/etc/os-release', 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Detect the native Linux distribution. Returns undefined when the host
 * facts cannot be read; callers fail closed (never assume CachyOS).
 */
export async function detectLinuxDistribution(
  readOsRelease: () => Promise<string | undefined> = readOsReleaseFile,
): Promise<LinuxDistributionInfo | undefined> {
  const content = await readOsRelease().catch(() => undefined);
  if (content === undefined || content.trim().length === 0) return undefined;
  const info = parseOsRelease(content);
  if (info.id.length === 0) return undefined;
  return info;
}

/** True only for CachyOS — the single supported native distribution. */
export function isCachyOs(info: LinuxDistributionInfo | undefined): boolean {
  return info?.id === CACHYOS_DISTRIBUTION_ID;
}

export function unsupportedDistroError(prettyName: string): Error {
  return Object.assign(
    new Error('Native Linux support currently targets CachyOS only. Detected: ' + prettyName + '.'),
    { code: 'LINUX_DISTRO_UNSUPPORTED' },
  );
}
