/**
 * Sanitized child environment for the autonomous DeepSeek worker.
 *
 * The DeepSeek SDK replaces the child environment wholesale when `env` is
 * given, so raw `process.env` is never forwarded. The allowlist covers OS
 * process execution plus documented DeepSeek Harness / provider variables.
 * Only variable NAMES are ever reported; values stay in memory for spawn.
 */
export interface DeepSeekChildEnvironmentInput {
  readonly source?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly extraAllowedNames?: readonly string[];
}

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
  'SENTRY_DEEPSEEK_MODEL',
  'SENTRY_DEEPSEEK_BINARY',
] as const;

/** Explicit DeepSeek Harness / provider configuration names (non-secret). */
const DEEPSEEK_CONFIG_PREFIXES = ['DEEPSEEK_', 'DSH_'] as const;

const EXPLICIT_DEEPSEEK_NAMES = ['DEEPSEEK_BASE_URL'] as const;

const SECRET_NAME_PATTERN =
  /(token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key|credentials?|auth)/i;

/**
 * Exact secret-bearing names allowed into the DeepSeek HOST process memory.
 * The host needs its provider credential to call the model; the runtime's
 * own subprocess scrub (`scrubbedParentEnv` seam) must keep it out of
 * model-controlled shell/file tooling (verified by sentinel tests against
 * the pinned version). Values are never persisted anywhere by Sentry.
 */
export const DEEPSEEK_ALLOWED_SECRET_ENV_NAMES: readonly string[] = ['DEEPSEEK_API_KEY'] as const;

export interface DeepSeekChildEnvironmentReport {
  readonly environment: NodeJS.ProcessEnv;
  readonly allowedNames: readonly string[];
  readonly blockedNames: readonly string[];
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

function isDeepSeekConfigName(name: string): boolean {
  const upper = name.toUpperCase();
  if ((EXPLICIT_DEEPSEEK_NAMES as readonly string[]).some((known) => known === upper)) return true;
  return DEEPSEEK_CONFIG_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function buildDeepSeekChildEnvironment(
  input: DeepSeekChildEnvironmentInput = {},
): DeepSeekChildEnvironmentReport {
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
    if (isDeepSeekConfigName(name)) {
      if (isSecretName(name)) {
        if (
          (DEEPSEEK_ALLOWED_SECRET_ENV_NAMES as readonly string[]).some(
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
