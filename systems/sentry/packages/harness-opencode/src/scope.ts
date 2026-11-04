import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { OpenCodeHarnessError } from './errors.js';

/**
 * Disposable per-AgentRun OpenCode scope.
 *
 * Layout (sibling of the agent workspace, never inside it):
 *
 * ```text
 * .sentry-opencode-<run>/
 * ├── home/            → HOME      (no user global state)
 * ├── config/opencode/ → XDG_CONFIG_HOME (no user global config)
 * ├── data/            → XDG_DATA_HOME (fresh session storage per run)
 * ├── state/           → XDG_STATE_HOME
 * ├── cache/           → XDG_CACHE_HOME
 * ├── bin/             → Sentry-owned tool shell wrapper
 * └── run-tmp/         → per-run private /tmp for tool shells
 * ```
 *
 * Properties (all verified against opencode-ai 1.18.32):
 * - Provider auth does NOT live here: the real key stays in Sentry
 *   runtime/proxy memory; OpenCode receives a localhost proxy endpoint
 *   plus a dummy key. Nothing in this scope is credential material.
 * - Session storage lives under the scope data dir: sessions never leak
 *   across AgentRuns, and removing the scope removes them.
 * - Redirected HOME/XDG keeps user global plugins, configs, instructions,
 *   and previous sessions out of Sentry runs (deterministic behavior).
 *
 * Cleanup removes the whole scope with retry. Best-effort, never throws
 * silently: callers record diagnostics on failure instead.
 */

export interface OpenCodeRunScope {
  readonly directory: string;
  readonly home: string;
  readonly configHome: string;
  readonly dataHome: string;
  readonly stateHome: string;
  readonly cacheHome: string;
  readonly binDir: string;
  readonly runTmp: string;
}

export async function createOpenCodeRunScope(input: {
  /** Agent workspace path; the scope lands beside it. */
  readonly workspacePath: string;
  readonly runId: string;
}): Promise<OpenCodeRunScope> {
  const safeRunId = input.runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'run';
  const directory = join(dirname(input.workspacePath), '.sentry-opencode-' + safeRunId);
  const home = join(directory, 'home');
  const configHome = join(directory, 'config');
  const dataHome = join(directory, 'data');
  const stateHome = join(directory, 'state');
  const cacheHome = join(directory, 'cache');
  const binDir = join(directory, 'bin');
  const runTmp = join(directory, 'run-tmp');
  await mkdir(join(configHome, 'opencode'), { recursive: true });
  await mkdir(join(dataHome, 'opencode'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(runTmp, { recursive: true });
  return { directory, home, configHome, dataHome, stateHome, cacheHome, binDir, runTmp };
}

export async function cleanupOpenCodeRunScope(scope: OpenCodeRunScope): Promise<void> {
  // Retry against transient OS file locks (dying child watchers, AV/indexer
  // scans of the session database after process death).
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

/** Project-controlled OpenCode configuration names OpenCode discovers. */
const MASK_CANDIDATES = ['.opencode', 'opencode.json', 'opencode.jsonc'] as const;

/**
 * Mask project-controlled OpenCode configuration inside the DISPOSABLE
 * agent workspace (originals outside Sentry are never touched). FAIL-CLOSED:
 * any failure aborts execution before OpenCode launches.
 *
 * Each present entry is renamed to a randomized Sentry-owned destination
 * (`.sentry-masked-project-config/<random>/`) so a malicious repository
 * cannot pre-occupy the destination (collision → retry → abort), and the
 * masked content stays readable for QA inspection but undiscoverable by
 * OpenCode's fixed-name lookup. Only the workspace root level is masked:
 * that is exactly what OpenCode discovers (config walk starts at run cwd).
 *
 * Verification (lstat, symlink-aware): after every rename the source must
 * be gone (lstat throws) and the destination must exist with the expected
 * kind. Symlinks rename the LINK itself; broken symlinks are handled.
 *
 * Throws OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED on any failure.
 */
export async function maskProjectOpenCodeConfig(workspacePath: string): Promise<readonly string[]> {
  const masked: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(workspacePath);
  } catch {
    throw new OpenCodeHarnessError(
      'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
      'Cannot inspect the disposable workspace for project OpenCode configuration.',
    );
  }
  const present = new Set(entries);
  const staging = join(workspacePath, '.sentry-masked-project-config');
  const wanted = MASK_CANDIDATES.filter((name) => present.has(name));
  if (wanted.length === 0) return masked;
  try {
    await mkdir(staging, { recursive: true });
  } catch {
    throw new OpenCodeHarnessError(
      'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
      'Cannot stage masked project OpenCode configuration.',
    );
  }
  for (const name of wanted) {
    const from = join(workspacePath, name);
    let source;
    try {
      source = await lstat(from);
    } catch {
      throw new OpenCodeHarnessError(
        'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
        'Project OpenCode configuration vanished mid-masking: ' + name,
      );
    }
    if (!source.isDirectory() && !source.isFile() && !source.isSymbolicLink()) {
      throw new OpenCodeHarnessError(
        'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
        'Unexpected project OpenCode configuration kind: ' + name,
      );
    }
    const kind = source.isDirectory() ? 'dir' : source.isFile() ? 'file' : 'link';
    // Randomized destination: unguessable, collision-checked.
    let destination: string | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = join(staging, randomUUID().replace(/-/g, ''), name);
      try {
        await lstat(candidate);
        continue;
      } catch {
        destination = candidate;
        break;
      }
    }
    if (destination === undefined) {
      throw new OpenCodeHarnessError(
        'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
        'Cannot find a free masking destination for: ' + name,
      );
    }
    try {
      await mkdir(dirname(destination), { recursive: true });
      await rename(from, destination);
    } catch {
      throw new OpenCodeHarnessError(
        'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
        'Cannot mask project OpenCode configuration: ' + name,
      );
    }
    // Verify: source gone, destination present with the same kind.
    try {
      await lstat(from);
      throw new OpenCodeHarnessError(
        'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
        'Masked source still present: ' + name,
      );
    } catch (cause) {
      if (cause instanceof OpenCodeHarnessError) throw cause;
    }
    let moved;
    try {
      moved = await lstat(destination);
    } catch {
      throw new OpenCodeHarnessError(
        'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
        'Masked destination missing: ' + name,
      );
    }
    const movedKind = moved.isDirectory() ? 'dir' : moved.isFile() ? 'file' : 'link';
    if (movedKind !== kind && !(kind === 'link' && moved.isSymbolicLink())) {
      throw new OpenCodeHarnessError(
        'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
        'Masked destination kind changed: ' + name,
      );
    }
    masked.push(name);
  }
  return masked;
}
