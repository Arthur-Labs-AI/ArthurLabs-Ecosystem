import type { OpenCodeRunScope } from './scope.js';

/**
 * Sanitized environments for the OpenCode QA worker.
 *
 * The provider credential NEVER enters any child environment: OpenCode
 * authenticates from the Sentry-owned scope auth file, so
 * `OPENROUTER_API_KEY` is blocked here by construction. OpenCode shell
 * tools inherit the host process environment, which therefore contains no
 * provider credential at all.
 *
 * Three layers:
 *
 * 1. `buildOpenCodeChildEnvironment`: allowlisted base (OS runtime +
 *    Sentry non-secret config). HOME/XDG and OpenCode CONTROL variables
 *    are NEVER taken from the source environment (see blocklists below).
 * 2. `applyOpenCodeScopeEnvironment`: Sentry-owned scope values (HOME,
 *    XDG_* pointing at the disposable run scope) layered on top.
 * 3. `applyOpenCodeTurnEnvironment`: per-turn Sentry-owned OpenCode
 *    controls (`OPENCODE_CONFIG_CONTENT` with provider + permission
 *    rules, `OPENCODE_DISABLE_PROJECT_CONFIG=1`, download guards).
 *    Reporting turns additionally get a tool-denying permission ruleset.
 *
 * `buildOpenCodeToolEnvironment` remains the enforced second boundary for
 * anything model-controlled tools may observe (proven by sentinel tests).
 *
 * Only variable NAMES are ever reported; values stay in spawn memory.
 * Never place provider credentials in project `.env` files.
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
  'SENTRY_OPENCODE_MODEL',
  'SENTRY_OPENCODE_PROVIDER',
  'SENTRY_OPENCODE_BINARY',
] as const;

/**
 * OpenCode CONTROL variables: Sentry-owned, never inherited from the
 * surrounding environment. A developer's own OpenCode configuration must
 * never steer Sentry runs (config file/content paths, auth content,
 * permission rulesets, plugin metadata, purity/project-config toggles).
 */
const OPENCODE_CONTROLLED_NAMES = [
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_TUI_CONFIG',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_PERMISSION',
  'OPENCODE_PURE',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'OPENCODE_PLUGIN_META_FILE',
] as const;

/** HOME/XDG scope: always Sentry-owned per AgentRun, never inherited. */
const SCOPE_OWNED_NAMES = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const;

/** Explicit non-secret OpenCode/provider tunables that may pass through. */
const OPENCODE_CONFIG_PREFIXES = ['OPENCODE_'] as const;

const EXPLICIT_OPENCODE_NAMES = ['OPENROUTER_BASE_URL'] as const;

const SECRET_NAME_PATTERN =
  /(token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key|credentials?|auth)/i;

/**
 * Exact secret-bearing names allowed into the OpenCode HOST process
 * environment. Intentionally EMPTY: the host authenticates from the
 * Sentry-owned scope auth file, so no provider credential belongs in
 * ANY child environment.
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

function isControlledName(upper: string): boolean {
  return (OPENCODE_CONTROLLED_NAMES as readonly string[]).some((known) => known === upper);
}

function isScopeOwnedName(upper: string): boolean {
  return (SCOPE_OWNED_NAMES as readonly string[]).some((known) => known === upper);
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
    // Controlled and scope-owned names are never inherited: Sentry sets
    // exactly the values its own boundary requires.
    if (isControlledName(upper) || isScopeOwnedName(upper)) {
      blockedNames.push(name);
      return;
    }
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

/** Layer the disposable run scope (HOME/XDG) over the child environment. */
export function applyOpenCodeScopeEnvironment(
  environment: NodeJS.ProcessEnv,
  scope: OpenCodeRunScope,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    HOME: scope.home,
    XDG_CONFIG_HOME: scope.configHome,
    XDG_DATA_HOME: scope.dataHome,
    XDG_STATE_HOME: scope.stateHome,
    XDG_CACHE_HOME: scope.cacheHome,
  };
}

/**
 * Sentry-owned per-turn OpenCode controls. `configContent` carries the
 * provider (and optional extra config) for THIS turn; reporting turns
 * pass a tool-denying permission ruleset instead of the default allow.
 */
export function applyOpenCodeTurnEnvironment(
  environment: NodeJS.ProcessEnv,
  input: {
    readonly configContent: string;
    readonly forbidTools?: boolean;
  },
): NodeJS.ProcessEnv {
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: input.configContent,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    ...(input.forbidTools === true ? { OPENCODE_PERMISSION: '{"*":"deny"}' } : {}),
  };
}

/**
 * Turn config content (no secrets — the only credential-adjacent value is
 * the dummy proxy key). Carries the provider endpoint (localhost proxy in
 * production, stub/direct endpoint in tests), the tool shell wrapper path
 * where applicable, and nothing else.
 */
export function buildOpenCodeProviderConfig(input: {
  readonly provider: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** SDK loader override (test stub path only; production uses bundled providers). */
  readonly npm?: string;
  readonly models?: Readonly<Record<string, Record<string, unknown>>>;
  /** Sentry-owned tool shell wrapper (Linux production; undefined elsewhere). */
  readonly shell?: string;
}): string {
  return JSON.stringify({
    ...(input.shell === undefined ? {} : { shell: input.shell }),
    provider: {
      [input.provider]: {
        ...(input.npm === undefined ? {} : { npm: input.npm }),
        ...(input.baseUrl === undefined && input.apiKey === undefined
          ? {}
          : {
              options: {
                ...(input.baseUrl === undefined ? {} : { baseURL: input.baseUrl }),
                ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
              },
            }),
        ...(input.models === undefined ? {} : { models: { ...input.models } }),
      },
    },
  });
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
