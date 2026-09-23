/**
 * Sanitized environments for the OpenCode QA worker.
 *
 * The provider credential NEVER enters any child environment: OpenCode
 * authenticates from the Sentry-owned auth boundary file
 * (`writeOpenCodeAuthBoundary`, honored via `XDG_DATA_HOME`), so
 * `OPENROUTER_API_KEY` is blocked here by construction. OpenCode shell
 * tools inherit the host process environment, which therefore contains no
 * provider credential at all — isolation holds even if a tool escapes
 * workspace assumptions.
 *
 * Two constructors:
 *
 * 1. Host environment (`buildOpenCodeChildEnvironment`): the `opencode`
 *    child process env. Sentry passes `env` explicitly at spawn, so raw
 *    `process.env` is never forwarded. The allowlist covers OS process
 *    execution plus Sentry's own non-secret OpenCode configuration.
 *    `XDG_DATA_HOME` (Sentry-owned auth scope) is forwarded when set.
 *    Values stay in memory for the spawn call; only NAMES are reported.
 *
 * 2. Tool environment (`buildOpenCodeToolEnvironment`): the environment
 *    model-controlled tool/shell executions may observe. Secrets are NEVER
 *    present here (absent upstream already; this is the enforced second
 *    boundary, proven by sentinel tests).
 *
 * Secrets are never persisted outside the ephemeral auth boundary file:
 * only names and inclusion decisions leave this module. Never place
 * provider credentials in project `.env` files.
 */
export interface OpenCodeChildEnvironmentInput {
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
  'XDG_DATA_HOME',
  'SENTRY_OPENCODE_MODEL',
  'SENTRY_OPENCODE_PROVIDER',
  'SENTRY_OPENCODE_BINARY',
] as const;

/** Explicit OpenCode/provider configuration prefixes (non-secret). */
const OPENCODE_CONFIG_PREFIXES = ['OPENCODE_'] as const;

const EXPLICIT_OPENCODE_NAMES = ['OPENROUTER_BASE_URL'] as const;

const SECRET_NAME_PATTERN =
  /(token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key|credentials?|auth)/i;

/**
 * Exact secret-bearing names allowed into the OpenCode HOST process
 * environment. Intentionally EMPTY: the host authenticates from the
 * Sentry-owned auth boundary file, so no provider credential belongs in
 * ANY child environment. Kept as a named list so a future provider path
 * that genuinely requires host-env auth can extend it explicitly — with
 * sentinel tests proving the tool boundary still strips it.
 */
export const OPENCODE_ALLOWED_SECRET_ENV_NAMES: readonly string[] = [] as const;

export interface OpenCodeChildEnvironmentReport {
  readonly environment: NodeJS.ProcessEnv;
  /** Variable names forwarded (never values). */
  readonly allowedNames: readonly string[];
  /** Variable names from the source that were blocked (never values). */
  readonly blockedNames: readonly string[];
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

function isOpenCodeConfigName(name: string): boolean {
  const upper = name.toUpperCase();
  if ((EXPLICIT_OPENCODE_NAMES as readonly string[]).some((known) => known === upper)) return true;
  return OPENCODE_CONFIG_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function buildOpenCodeChildEnvironment(
  input: OpenCodeChildEnvironmentInput = {},
): OpenCodeChildEnvironmentReport {
  const source = input.source ?? process.env;
  const extra = new Set((input.extraAllowedNames ?? []).map((name) => name.toUpperCase()));
  const allowed = new Map<string, string>();
  const blockedNames: string[] = [];
  const seen = new Set<string>();
  const consider = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    const upper = name.toUpperCase();
    if (seen.has(upper)) return;
    seen.add(upper);
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
    if (isOpenCodeConfigName(name)) {
      if (isSecretName(name)) {
        if (
          (OPENCODE_ALLOWED_SECRET_ENV_NAMES as readonly string[]).some(
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
  };
}

/**
 * Tool-observable environment for model-controlled OpenCode tool/shell
 * executions. Starts from the host child environment and REMOVES every
 * secret-bearing variable (including OPENROUTER_API_KEY) plus Sentry's own
 * provider credentials. Only names are reported; values never leave.
 */
export function buildOpenCodeToolEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
): OpenCodeChildEnvironmentReport {
  const allowed = new Map<string, string>();
  const blockedNames: string[] = [];
  for (const [name, value] of Object.entries(hostEnvironment)) {
    if (value === undefined) continue;
    if (isSecretName(name)) {
      blockedNames.push(name);
      continue;
    }
    allowed.set(name, value);
  }
  return {
    environment: Object.fromEntries(allowed),
    allowedNames: [...allowed.keys()].sort(),
    blockedNames: blockedNames.sort(),
  };
}
