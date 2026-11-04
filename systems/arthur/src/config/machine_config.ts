/**
 * FRS-01: canonical machine configuration foundation.
 *
 * ARTHUR has outgrown repo-local `.env` as its production configuration
 * identity: two processes started from different working directories must
 * observe the same runtime configuration. This module is the ONE policy
 * implementation for the canonical machine config file:
 *
 *   <resolveAppDataRoot()>/config.env
 *
 * Design principle (FRS-01):
 *
 *   Defaults belong to code.
 *   Machine choices belong to machine config.
 *   Secrets eventually belong to credential storage.
 *   Setup configures.
 *   Doctor verifies.
 *
 * Precedence (highest wins, deterministic):
 *
 *   1. programmatic/test Settings overrides
 *   2. ambient process environment
 *   3. repo/CWD `.env` developer override
 *   4. canonical machine config.env
 *   5. code-owned defaults
 *
 * Loading machine config NEVER overwrites a variable already provided by
 * the operator's process environment, and locating the machine config
 * NEVER depends on process.cwd(). Parsing uses Node's standard
 * `util.parseEnv` grammar (the same grammar as `process.loadEnvFile`);
 * no incompatible second grammar is invented here.
 *
 * The machine file is NOT a generated copy of `.env.example`: it
 * contains only explicit machine/user choices. Code defaults are never
 * written merely because they exist, so a future code-default change
 * affects old installations unless the operator explicitly overrode it.
 *
 * Windows note: the file lives under LOCALAPPDATA as a normal user-owned
 * file. No POSIX permission semantics are invented here; OS credential
 * storage arrives later (SC-10).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';

import { ArthurError } from '../core/errors/errors';
import { resolveAppDataRoot } from '../runtime/app_data';

export const MACHINE_CONFIG_FILENAME = 'config.env';

/** Secret-like name fragments: values under these names are never printed. */
const SECRET_NAME_FRAGMENTS = ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL'] as const;

/** NUL sentinel without embedding a literal NUL byte in this source. */
const NUL = String.fromCharCode(0);

/**
 * Resolve the canonical machine config path. CWD-independent: it derives
 * from resolveAppDataRoot() only (explicit configured root ->
 * ARTHUR_DATA_DIR -> stable OS per-user directory). Never duplicates the
 * app-data-root resolution logic.
 */
export function resolveMachineConfigPath(): string {
  return path.join(resolveAppDataRoot(), MACHINE_CONFIG_FILENAME);
}

/**
 * Narrow injectable variant for deterministic tests: resolves the machine
 * config path against an explicit data root / env / platform seam without
 * touching process globals.
 */
export function resolveMachineConfigPathFor(args: {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathImpl?: Pick<typeof path, 'join' | 'resolve' | 'normalize' | 'sep'>;
} = {}): string {
  const root = resolveAppDataRoot({ configured: args.configured, env: args.env, platform: args.platform, pathImpl: args.pathImpl });
  if (args.pathImpl) return args.pathImpl.join(root, MACHINE_CONFIG_FILENAME);
  return path.join(root, MACHINE_CONFIG_FILENAME);
}

/** True when the name is secret-like (case-insensitive fragment match). */
export function isSecretLikeName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_NAME_FRAGMENTS.some((fragment) => upper.includes(fragment));
}

/** Validate a config key: strict shell-compatible identifier. */
function assertValidKey(key: string): void {
  if (key.length === 0 || key.length > 256 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new ArthurError('INVALID_CONFIG', 'invalid config key ' + JSON.stringify(key));
  }
}

/** Validate a config value: data, never executable syntax; reject NUL/control risks. */
function assertValidValue(key: string, value: string): void {
  if (value.indexOf(NUL) !== -1) {
    throw new ArthurError('INVALID_CONFIG', 'invalid config value for ' + JSON.stringify(key) + ': contains NUL');
  }
  if (value.length > 65536) {
    throw new ArthurError('INVALID_CONFIG', 'invalid config value for ' + JSON.stringify(key) + ': exceeds 64 KiB');
  }
  // Newlines would break the line-oriented .env grammar and enable entry
  // injection (a second KEY= line smuggled inside a value).
  if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
    throw new ArthurError('INVALID_CONFIG', 'invalid config value for ' + JSON.stringify(key) + ': newlines are not allowed');
  }
}

/**
 * Parse machine-config file text with Node's standard .env grammar
 * (util.parseEnv - the same grammar process.loadEnvFile uses). Malformed
 * content fails typed (INVALID_CONFIG) rather than being silently
 * half-applied. NUL bytes are rejected before parsing.
 */
export function parseMachineConfigText(text: string): Record<string, string> {
  if (text.indexOf(NUL) !== -1) {
    throw new ArthurError('INVALID_CONFIG', 'machine config contains NUL');
  }
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(text) as Record<string, string>;
  } catch (err) {
    throw new ArthurError('INVALID_CONFIG', 'machine config is malformed: ' + (err instanceof Error ? err.message.split('\n')[0] : String(err)));
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    assertValidKey(key);
    assertValidValue(key, value);
    out[key] = value;
  }
  return out;
}

/**
 * Read and parse the canonical machine config file. Missing file = no
 * machine overrides (empty record), never an error. Malformed content
 * fails typed (INVALID_CONFIG).
 */
export function readMachineConfig(configPath: string = resolveMachineConfigPath()): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ArthurError(
      'INVALID_CONFIG',
      'cannot read machine config ' + JSON.stringify(configPath) + ': ' + (err instanceof Error ? err.message : String(err)),
    );
  }
  return parseMachineConfigText(text);
}

/**
 * Serialize entries deterministically: keys sorted byte-wise, one KEY=value
 * line each, LF endings, trailing newline when non-empty. Values use the
 * minimal quoting that round-trips through Node's parseEnv grammar
 * (probed against util.parseEnv; no escapes are emitted, only wrapping):
 * bare when the text survives verbatim (no '#' truncation, no edge
 * whitespace trimming), else single-quoted verbatim when the value has no
 * single-quote, else double-quoted verbatim when it has no double-quote.
 * A value needing quotes that contains BOTH quote kinds has no
 * round-tripping representation in this grammar and is rejected typed
 * (INVALID_CONFIG) rather than written corrupt. Bare values containing
 * quotes/backslashes (e.g. audio engine commands) round-trip verbatim.
 */
export function serializeMachineConfig(entries: Record<string, string>): string {
  const keys = Object.keys(entries).sort();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const value = entries[key] as string;
    assertValidKey(key);
    assertValidValue(key, value);
    lines.push(key + '=' + serializeValue(value));
  }
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

/** Minimal quoting that round-trips through util.parseEnv (see above). */
function serializeValue(value: string): string {
  if (value === '') return '""';
  // Bare survives verbatim unless parseEnv would trim edge whitespace or
  // truncate at '#'. Everything else observed (quotes, backslashes,
  // semicolons, $/%/!/`, =) passes through bare unchanged.
  if (value.indexOf('#') === -1 && value.trim() === value) {
    return value;
  }
  if (value.indexOf("'") === -1) {
    return "'" + value + "'";
  }
  if (value.indexOf('"') === -1) {
    return '"' + value + '"';
  }
  throw new ArthurError(
    'INVALID_CONFIG',
    'config value needs quoting (contains # or edge whitespace) and contains both quote kinds; remove one quote kind',
  );
}

export interface MachineConfigUpdate {
  /** Key/value pairs to set (validated). */
  set?: Record<string, string>;
  /** Keys to remove so the lower-precedence source/default applies again. */
  remove?: string[];
}

/**
 * Atomic machine-config update: read existing entries (missing file =
 * empty), apply set/remove patch, serialize deterministically, write a
 * temp file in the SAME directory then rename over the target so an
 * interruption never leaves a partial/truncated config. Entries not in
 * the patch are preserved; output has no duplicate keys.
 *
 * Values are data, never executable syntax; NUL/malformed input fails
 * typed without touching the existing file. Never logs values - callers
 * must not log the returned entries either when secrets may be present.
 */
export function updateMachineConfig(
  update: MachineConfigUpdate,
  configPath: string = resolveMachineConfigPath(),
): Record<string, string> {
  const setEntries = update.set ?? {};
  const removeKeys = update.remove ?? [];
  for (const key of Object.keys(setEntries)) assertValidKey(key);
  for (const key of removeKeys) assertValidKey(key);
  for (const [key, value] of Object.entries(setEntries)) {
    if (typeof value !== 'string') {
      throw new ArthurError('INVALID_CONFIG', 'invalid config value for ' + JSON.stringify(key) + ': must be a string');
    }
    assertValidValue(key, value);
  }
  const removeSet = new Set(removeKeys);
  for (const key of Object.keys(setEntries)) {
    if (removeSet.has(key)) {
      throw new ArthurError('INVALID_CONFIG', 'config key ' + JSON.stringify(key) + ' cannot be both set and removed');
    }
  }

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Best effort: private user-data directory permissions.
    }
  }

  const current = readMachineConfig(configPath);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!removeSet.has(key)) next[key] = value;
  }
  for (const [key, value] of Object.entries(setEntries)) next[key] = value;

  const text = serializeMachineConfig(next);
  // Temp in the same directory: same-filesystem rename = atomic replace.
  // Random suffix avoids collisions between concurrent writers.
  const stamp = process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 0xffffffff).toString(16);
  const tmpPath = configPath + '.tmp-' + stamp;
  try {
    fs.writeFileSync(tmpPath, text, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        // Best effort: restrictive config file where POSIX applies.
      }
    }
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup of the temp file.
    }
    throw new ArthurError(
      'INVALID_CONFIG',
      'cannot write machine config ' + JSON.stringify(configPath) + ': ' + (err instanceof Error ? err.message : String(err)),
    );
  }
  return next;
}

export interface ConfigurationEnvironmentOptions {
  /** Explicit machine config path (default: canonical resolveMachineConfigPath()). */
  machineConfigPath?: string;
  /** Repo/CWD .env developer-override path (default: ".env" in cwd; null disables). */
  repoEnvPath?: string | null;
  /** Ambient environment snapshot (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * ONE configuration bootstrap policy for every real ARTHUR entrypoint
 * (CLI, HTTP/API, production runners) - plus the lazy model/setup path.
 *
 * Applies, in order, WITHOUT overwriting higher-precedence values:
 *
 *   ambient process env  (highest: never overwritten)
 *     > repo/CWD .env developer override
 *     > canonical machine config.env
 *
 * Code defaults stay in settings.ts / voice/config.ts (lowest); test
 * programmatic overrides stay highest inside loadSettings() and are
 * untouched here.
 *
 * Implementation: each layer is parsed with the platform-standard
 * util.parseEnv grammar into an explicit record, then only keys ABSENT
 * from process.env are assigned - never "load three files and hope
 * overwrite semantics match". Returns the machine config path used plus
 * which keys each file layer contributed (names only, never values).
 */
export function loadConfigurationEnvironment(options: ConfigurationEnvironmentOptions = {}): {
  machineConfigPath: string;
  machineKeys: string[];
  repoKeys: string[];
} {
  const env = options.env ?? process.env;
  const machineConfigPath = options.machineConfigPath ?? resolveMachineConfigPath();
  const repoEnvPath = options.repoEnvPath === undefined ? '.env' : options.repoEnvPath;

  const machineEntries = readMachineConfig(machineConfigPath);
  const machineKeys: string[] = [];
  for (const [key, value] of Object.entries(machineEntries)) {
    if (env[key] === undefined) {
      env[key] = value;
      machineKeys.push(key);
    }
  }

  const repoKeys: string[] = [];
  if (repoEnvPath !== null) {
    let repoText: string | null = null;
    try {
      repoText = fs.readFileSync(repoEnvPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ArthurError(
          'INVALID_CONFIG',
          'cannot read repo .env ' + JSON.stringify(repoEnvPath) + ': ' + (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    if (repoText !== null) {
      if (repoText.indexOf(NUL) !== -1) {
        throw new ArthurError('INVALID_CONFIG', 'repo .env contains NUL');
      }
      let parsed: Record<string, string>;
      try {
        parsed = parseEnv(repoText) as Record<string, string>;
      } catch (err) {
        throw new ArthurError('INVALID_CONFIG', 'repo .env is malformed: ' + (err instanceof Error ? err.message.split('\n')[0] : String(err)));
      }
      for (const [key, value] of Object.entries(parsed)) {
        // Repo .env outranks machine config but never the ambient process
        // environment. Keys already present (ambient OR just-applied
        // machine entries) keep their value - EXCEPT machine-applied keys
        // are demoted: an explicit repo override wins over machine config.
        if (env[key] === undefined || machineKeys.indexOf(key) !== -1) {
          const wasMachine = machineKeys.indexOf(key) !== -1;
          env[key] = value;
          if (repoKeys.indexOf(key) === -1) repoKeys.push(key);
          if (wasMachine) {
            const idx = machineKeys.indexOf(key);
            if (idx !== -1) machineKeys.splice(idx, 1);
          }
        }
      }
    }
  }

  return { machineConfigPath, machineKeys, repoKeys };
}

/**
 * Secret-safe inspection snapshot for `arthur config show`. Returns rows
 * of name/display where secret-like names render as
 * "configured"/"not configured" and never expose values - structurally
 * (the value is never interpolated into a string first). Non-secret
 * values render verbatim. JSON output uses the same rows so it cannot
 * leak either.
 */
export function describeConfigurationEnvironment(env: NodeJS.ProcessEnv = process.env): { name: string; display: string; configured: boolean; secret: boolean }[] {
  const names = new Set<string>();
  for (const key of Object.keys(env)) names.add(key);
  try {
    for (const key of Object.keys(readMachineConfig())) names.add(key);
  } catch {
    // Missing/unreadable machine config: report ambient names only.
  }
  const rows: { name: string; display: string; configured: boolean; secret: boolean }[] = [];
  const sorted = [...names].sort();
  for (const name of sorted) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    // Focus the surface on ARTHUR configuration plus known secret names;
    // ambient process noise (PATH, HOME, ...) is not ARTHUR configuration.
    if (name.indexOf('ARTHUR_') !== 0 && name !== 'DEEPSEEK_API_KEY' && name !== 'OPENAI_API_KEY' && !isSecretLikeName(name)) continue;
    const raw = env[name];
    const configured = raw !== undefined && raw !== '';
    const secret = isSecretLikeName(name);
    rows.push({ name, display: secret ? (configured ? 'configured' : 'not configured') : (raw ?? ''), configured, secret });
  }
  return rows;
}
