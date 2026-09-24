import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { removeOpenCodeAuthFile, writeOpenCodeAuthBoundary } from './auth.js';

/**
 * Disposable per-AgentRun OpenCode scope.
 *
 * Layout (sibling of the agent workspace, never inside it):
 *
 * ```text
 * .sentry-opencode-<run>/
 * ├── home/                  → HOME      (no user global state)
 * ├── config/opencode/       → XDG_CONFIG_HOME (no user global config)
 * ├── data/opencode/auth.json → XDG_DATA_HOME (provider key, 0600;
 * │                              fresh session storage per run)
 * ├── state/                 → XDG_STATE_HOME
 * └── cache/                 → XDG_CACHE_HOME
 * ```
 *
 * Properties (all verified against opencode-ai 1.18.32):
 * - Provider auth resolves from `<data>/opencode/auth.json`; the key is in
 *   NO environment.
 * - Session storage lives under the scope data dir: sessions never leak
 *   across AgentRuns, and removing the scope removes them.
 * - Redirected HOME/XDG keeps user global plugins, configs, instructions,
 *   and previous sessions out of Sentry runs (deterministic behavior).
 * - `OPENCODE_DISABLE_PROJECT_CONFIG=1` + `--pure` are passed as defense
 *   in depth, but project `.opencode` content is ALSO masked inside the
 *   disposable workspace (see below): suppression flags alone do not stop
 *   project plugin auto-discovery in 1.18.32 (proven by evil-plugin test).
 *
 * Cleanup removes the whole scope (auth file included). Best-effort, never
 * throws: callers record diagnostics on failure instead.
 */

export interface OpenCodeRunScope {
  readonly directory: string;
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
  readonly authFile: string;
}

export async function createOpenCodeRunScope(input: {
  /** Agent workspace path; the scope lands beside it. */
  readonly workspacePath: string;
  readonly runId: string;
  readonly apiKey: string;
}): Promise<OpenCodeRunScope> {
  const safeRunId = input.runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'run';
  const directory = join(dirname(input.workspacePath), '.sentry-opencode-' + safeRunId);
  const home = join(directory, 'home');
  const configHome = join(directory, 'config');
  const dataHome = join(directory, 'data');
  const stateHome = join(directory, 'state');
  const cacheHome = join(directory, 'cache');
  await mkdir(join(configHome, 'opencode'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  const boundary = await writeOpenCodeAuthBoundary({
    scopeDataHome: dataHome,
    apiKey: input.apiKey,
  });
  return {
    directory,
    home,
    configHome,
    dataHome,
    stateHome,
    cacheHome,
    authFile: boundary.authFile,
  };
}

export async function cleanupOpenCodeRunScope(scope: OpenCodeRunScope): Promise<void> {
  await removeOpenCodeAuthFile(scope.authFile).catch(() => undefined);
  // Retry against transient OS file locks (dying child watchers, AV/indexer
  // scans of the session database after process death). The auth file is
  // already gone on the first attempt; the directory must still go away.
  let lastCause: unknown;
  for (const delay of [0, 200, 500, 1000, 2000, 4000]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await rm(scope.directory, { recursive: true, force: true });
      return;
    } catch (cause) {
      lastCause = cause;
    }
  }
  throw lastCause;
}

/**
 * Mask project-controlled OpenCode configuration inside the DISPOSABLE
 * agent workspace (originals outside Sentry are never touched).
 *
 * Renames (never deletes, so QA can still inspect the content read-only):
 * - `<workspace>/.opencode` → `<workspace>/.opencode.sentry-masked`
 * - `<workspace>/opencode.json[c]` → `<workspace>/opencode.json[c].sentry-masked`
 *
 * Only the workspace root level is masked: that is exactly what OpenCode
 * discovers (config walk starts at the run cwd). Returns masked paths for
 * diagnostics. Symlinked `.opencode` entries rename the link itself.
 */
export async function maskProjectOpenCodeConfig(workspacePath: string): Promise<string[]> {
  const masked: string[] = [];
  const candidates = ['.opencode', 'opencode.json', 'opencode.jsonc'];
  let entries: string[];
  try {
    entries = await readdir(workspacePath);
  } catch {
    return masked;
  }
  const present = new Set(entries);
  for (const name of candidates) {
    if (!present.has(name)) continue;
    const from = join(workspacePath, name);
    const to = from + '.sentry-masked';
    try {
      const info = await stat(from);
      if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) continue;
      await rename(from, to);
      masked.push(name);
    } catch {
      // Best-effort per entry; the caller records what was masked.
    }
  }
  return masked;
}
