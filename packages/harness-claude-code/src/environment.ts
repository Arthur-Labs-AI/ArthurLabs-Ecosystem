/**
 * Sanitized child environment for the Claude Code worker process.
 *
 * Raw `process.env` is never forwarded. The allowlist covers OS process
 * execution plus documented Claude Code / Z.AI provider variables.
 * Only variable NAMES are ever reported; values stay in memory for spawn.
 *
 * Credential model (verified against Claude Code 2.1.270 on the host):
 * - The Z.AI authorization credential enters the Claude PARENT process env
 *   (exact name allowlisted below) so the provider call can authenticate.
 * - Model-controlled Bash/hooks/MCP children must not inherit it: Sentry
 *   sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and verifies absence with a
 *   test-only sentinel (never the real credential).
 */
export interface ClaudeChildEnvironmentInput {
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
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'NODE_PATH',
  'SENTRY_GLM_MODEL',
  'SENTRY_CLAUDE_BINARY',
] as const;

/** Explicit Claude Code / Z.AI configuration names (non-secret). */
const CLAUDE_CONFIG_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_'] as const;

const EXPLICIT_CLAUDE_NAMES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  'CLAUDE_CODE_DISABLE_BUILTIN_AGENTS',
  'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS',
] as const;

const SECRET_NAME_PATTERN =
  /(token|secret|password|api[_-]?key|authorization|cookie|private[_-]?key|credentials?|auth)/i;

/**
 * Exact secret-bearing names allowed into the Claude PARENT process memory.
 * The parent needs its provider credential to call Z.AI; the subprocess
 * scrub must keep it out of model-controlled Bash (verified by sentinel
 * tests against the pinned version). Values are never persisted by Sentry.
 */
export const CLAUDE_ALLOWED_SECRET_ENV_NAMES: readonly string[] = ['ANTHROPIC_AUTH_TOKEN'] as const;

export interface ClaudeChildEnvironmentReport {
  readonly environment: NodeJS.ProcessEnv;
  readonly allowedNames: readonly string[];
  readonly blockedNames: readonly string[];
}

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

function isClaudeConfigName(name: string): boolean {
  const upper = name.toUpperCase();
  if ((EXPLICIT_CLAUDE_NAMES as readonly string[]).some((known) => known === upper)) return true;
  return CLAUDE_CONFIG_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Windows profile variables that must never reach a Linux Claude worker:
 * they reintroduce Windows-mounted host state ($HOME/.claude resolution,
 * IDE/policy discovery) that bwrap then chokes on. On win32 (native
 * Windows Claude execution) they stay allowed; on Linux they are blocked
 * and reported as such. Verified live: an inherited Windows HOME breaks
 * every Bash call before the command runs (run_01M33YXNW80W2Q7H1HK5EA5K7Q).
 */
export const LINUX_BLOCKED_WINDOWS_PROFILE_NAMES: readonly string[] = [
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
] as const;

/**
 * Windows profile variables stay allowed for native Windows Claude
 * execution (removed from the shared base list so Linux blocks them).
 */
const WIN32_PROFILE_NAMES: readonly string[] = [
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
] as const;

export function buildClaudeChildEnvironment(
  input: ClaudeChildEnvironmentInput = {},
): ClaudeChildEnvironmentReport {
  const source = input.source ?? process.env;
  const platform = input.platform ?? process.platform;
  const blockedProfile =
    platform === 'win32'
      ? new Set<string>()
      : new Set<string>(LINUX_BLOCKED_WINDOWS_PROFILE_NAMES.map((name) => name.toUpperCase()));
  const extra = new Set((input.extraAllowedNames ?? []).map((name) => name.toUpperCase()));
  const allowed = new Map<string, string>();
  const blockedNames: string[] = [];
  const seen = new Set<string>();
  const win32Profile =
    platform === 'win32'
      ? new Set<string>(WIN32_PROFILE_NAMES.map((entry) => entry.toUpperCase()))
      : new Set<string>();
  const consider = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    const upper = name.toUpperCase();
    if (seen.has(upper)) return;
    seen.add(upper);
    // Platform boundary: Windows profile state never enters Linux workers.
    if (blockedProfile.has(upper)) {
      blockedNames.push(name);
      return;
    }
    if (win32Profile.has(upper)) {
      if (isSecretName(name)) {
        blockedNames.push(name);
        return;
      }
      allowed.set(name, value);
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
    if (isClaudeConfigName(name)) {
      if (isSecretName(name)) {
        if (
          (CLAUDE_ALLOWED_SECRET_ENV_NAMES as readonly string[]).some(
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
