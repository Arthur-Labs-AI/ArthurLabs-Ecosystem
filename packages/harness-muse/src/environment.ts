/**
 * Sanitized child environment for the autonomous Muse worker (Phase 3.1).
 *
 * The Muse host process REPLACES its environment with what Sentry passes
 * (SDK `env` semantics), so passing raw `process.env` would hand unrelated
 * host secrets (GITHUB_TOKEN, DATABASE_URL, ...) to the autonomous worker.
 * This module builds the smallest reliable environment instead:
 *
 * - OS process execution / PATH resolution / temp dirs / locale where needed
 * - Sentry's own Muse configuration inputs (binary/model selectors are read
 *   by Sentry, not Muse, but harmless and useful for nested probes)
 * - Explicitly allowed Muse authentication variables only
 *
 * Muse authentication: the supported posture is the user's existing local
 * authenticated state (device login / `muse login` credential store outside
 * the workspace). No Muse-specific secret env var names are documented in the
 * installed SDK surface or official setup guides, so this module allowlists
 * only `MUSE_*` / `META_*` prefixed values that look like non-secret
 * configuration (no TOKEN/SECRET/KEY/PASSWORD/AUTH names) plus an explicit
 * opt-in list. Unknown secret-bearing variables are NEVER forwarded.
 *
 * Secrets are never persisted: only variable NAMES and inclusion decisions
 * are reported; values stay in memory for the spawn call.
 */
export interface MuseChildEnvironmentInput {
  readonly source?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Extra exact variable names the operator explicitly allows (non-secret config only). */
  readonly extraAllowedNames?: readonly string[];
}

/** Exact variable names always forwarded when present (runtime, not secrets). */
const BASE_RUNTIME_NAMES = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'NODE_PATH',
  'SENTRY_MUSE_BINARY',
  'SENTRY_MUSE_MODEL',
] as const;

/** Prefix allowlist for Muse/Meta configuration (non-secret names only). */
const MUSE_CONFIG_PREFIXES = ['MUSE_', 'META_MUSE_', 'META_'] as const;

/** Name fragments that mark a variable as secret-bearing: never forwarded. */
const SECRET_NAME_PATTERN =
  /(token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key|credentials?|auth)/i;

/** Exact Muse/Meta names that are explicitly allowed even though secret-adjacent. Keep empty: no official secret env names documented. */
export const MUSE_ALLOWED_SECRET_ENV_NAMES: readonly string[] = [] as const;

export interface MuseChildEnvironmentReport {
  readonly environment: NodeJS.ProcessEnv;
  /** Variable names forwarded (never values). */
  readonly allowedNames: readonly string[];
  /** Variable names from the source that were blocked (never values). */
  readonly blockedNames: readonly string[];
  /** Auth-relevant names detected in the source, forwarded or not (never values). */
  readonly authNamesDetected: readonly string[];
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

function isMuseConfigName(name: string): boolean {
  const upper = name.toUpperCase();
  return MUSE_CONFIG_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function buildMuseChildEnvironment(
  input: MuseChildEnvironmentInput = {},
): MuseChildEnvironmentReport {
  const source = input.source ?? process.env;
  const extra = new Set((input.extraAllowedNames ?? []).map((name) => name.toUpperCase()));
  const allowed = new Map<string, string>();
  const blockedNames: string[] = [];
  const authDetected: string[] = [];
  // Case-insensitive lookup on Windows semantics: track seen upper-cased names.
  const seen = new Set<string>();

  const consider = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    const upper = name.toUpperCase();
    if (seen.has(upper)) return;
    seen.add(upper);
    if (isMuseConfigName(name)) authDetected.push(name);
    const exactBase = (BASE_RUNTIME_NAMES as readonly string[]).some(
      (allowedName) => allowedName.toUpperCase() === upper,
    );
    if (exactBase) {
      if (isSecretName(name)) {
        blockedNames.push(name);
        return;
      }
      allowed.set(name, value);
      return;
    }
    if (isMuseConfigName(name)) {
      if (isSecretName(name)) {
        if (
          (MUSE_ALLOWED_SECRET_ENV_NAMES as readonly string[]).some(
            (n) => n.toUpperCase() === upper,
          )
        ) {
          allowed.set(name, value);
        } else {
          blockedNames.push(name);
        }
        return;
      }
      allowed.set(name, value);
      return;
    }
    if (extra.has(upper)) {
      if (isSecretName(name)) {
        blockedNames.push(name);
        return;
      }
      allowed.set(name, value);
      return;
    }
    blockedNames.push(name);
  };

  for (const [name, value] of Object.entries(source)) consider(name, value);

  // Guarantee minimal PATH resolution even when the source lacks PATH.
  if (![...allowed.keys()].some((name) => name.toUpperCase() === 'PATH')) {
    const fallbackPath =
      input.platform === 'win32' || process.platform === 'win32'
        ? 'C:\\Windows\\System32;C:\\Windows'
        : '/usr/local/bin:/usr/bin:/bin';
    allowed.set('PATH', fallbackPath);
  }

  return {
    environment: Object.fromEntries(allowed),
    allowedNames: [...allowed.keys()].sort(),
    blockedNames: blockedNames.sort(),
    authNamesDetected: authDetected.sort(),
  };
}
