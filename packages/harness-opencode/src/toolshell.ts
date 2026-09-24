import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Sentry-owned tool shell wrapper: OS-enforced filesystem view for
 * model-controlled shell executions.
 *
 * OpenCode runs its `bash` tool through the configured `shell` binary. By
 * pointing `shell` at this wrapper (generated per AgentRun inside the
 * Sentry-owned scope), every tool shell enters a bubblewrap mount
 * namespace before the real shell starts:
 *
 * - hide paths (scope dir, workspace parent incl. Sentry data root and
 *   sibling workspaces, developer HOME) â†’ empty tmpfs mounts.
 * - AgentRun workspace â†’ re-bound read-write on top.
 * - scope home â†’ re-bound writable (tools need a HOME).
 * - per-run private tmp â†’ bound at /tmp.
 * - everything else (toolchain, libraries) â†’ read-only bind of `/`.
 *
 * In-process file tools (`read`/`edit`) do NOT pass through here; they are
 * contained by explicit deny rules plus upstream ask-to-reject, and they
 * can only ever observe the dummy proxy credential (never the real key).
 *
 * The wrapper accepts exactly `[-l] -c <script>` (the shapes OpenCode
 * 1.18.32 uses) and refuses anything else closed (exit 126) so version
 * drift fails loud instead of executing outside the namespace.
 */

export interface ToolShellSpec {
  /** Absolute path of the real shell (resolved at generation time). */
  readonly realShell: string;
  /** Absolute bwrap binary path. */
  readonly bwrap: string;
  /** Absolute paths hidden with empty tmpfs mounts. */
  readonly hidePaths: readonly string[];
  /** Absolute per-run private tmp (bound at /tmp). */
  readonly runTmp: string;
  /** Absolute scope home (re-bound writable: tools need a HOME). */
  readonly scopeHome: string;
  /** Absolute agent workspace (re-bound read-write). */
  readonly workspace: string;
}

/** Normalize a hide candidate; undefined means never hide (root/empty/drive-root). */
export function normalizeHidePath(raw: string): string | undefined {
  const normalized = raw.split('\\').join('/').replace(/\/+$/, '');
  if (normalized.length === 0) return undefined;
  if (normalized === '/') return undefined;
  if (/^[A-Za-z]:$/.test(normalized)) return undefined;
  return normalized;
}

/**
 * Compute the tool-namespace hide list. Hiding the workspace PARENT covers
 * sibling workspaces and everything above it (including the Sentry data
 * root) regardless of layout depth; the workspace itself is re-bound
 * read-write afterwards. Roots, empty paths, duplicates, and paths that
 * must stay visible are dropped.
 */
export function computeToolHiddenPaths(input: {
  readonly scopeDir: string;
  readonly workspace: string;
  readonly realHome?: string;
}): readonly string[] {
  const workspace = normalizeHidePath(input.workspace);
  const scopeDir = normalizeHidePath(input.scopeDir);
  if (workspace === undefined || scopeDir === undefined) return [];
  const slash = workspace.lastIndexOf('/');
  const parent = slash > 0 ? workspace.slice(0, slash) : undefined;
  const candidates: Array<string | undefined> = [scopeDir, parent];
  const home =
    input.realHome === undefined || input.realHome.length === 0
      ? undefined
      : normalizeHidePath(input.realHome);
  if (home !== undefined) candidates.push(home);
  const keep = new Set([workspace]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (keep.has(candidate)) continue;
    const lower = candidate.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(candidate);
  }
  return out;
}

export function renderToolShellWrapper(spec: ToolShellSpec): string {
  const SQ = String.fromCharCode(39);
  const BS = String.fromCharCode(92);
  const q = (value: string): string => SQ + value.split(SQ).join(SQ + BS + SQ + SQ) + SQ;
  const hideArgs: string[] = [];
  spec.hidePaths.forEach((p) => {
    hideArgs.push(`  --tmpfs ${q(p)} \\`);
  });
  return [
    '#!/bin/sh',
    '# Sentry-owned OpenCode tool shell wrapper (generated per AgentRun).',
    '# Usage: sentry-bash [-l] -c <script>. Anything else is refused.',
    'set -eu',
    `SENTRY_REAL_SHELL=${q(spec.realShell)}`,
    `SENTRY_BWRAP=${q(spec.bwrap)}`,
    `SENTRY_RUN_TMP=${q(spec.runTmp)}`,
    `SENTRY_WORKSPACE=${q(spec.workspace)}`,
    `SENTRY_SCOPE_HOME=${q(spec.scopeHome)}`,
    'if [ "$SENTRY_SCOPE_HOME" != "$HOME" ]; then',
    '  echo "sentry-tool-shell: HOME mismatch" >&2',
    '  exit 126',
    'fi',
    'if [ "${1:-}" = "-l" ]; then shift; fi',
    'if [ "${1:-}" != "-c" ]; then',
    '  echo "sentry-tool-shell: refusing unexpected invocation" >&2',
    '  exit 126',
    'fi',
    'shift',
    'SCRIPT="${1:-}"',
    'if [ -z "$SCRIPT" ]; then',
    '  echo "sentry-tool-shell: empty command" >&2',
    '  exit 126',
    'fi',
    'exec "$SENTRY_BWRAP" \\',
    '  --ro-bind / / \\',
    '  --dev /dev \\',
    '  --proc /proc \\',
    '  --bind "$SENTRY_RUN_TMP" /tmp \\',
    ...hideArgs,
    '  --bind "$SENTRY_WORKSPACE" "$SENTRY_WORKSPACE" \\',
    '  --bind "$SENTRY_SCOPE_HOME" "$SENTRY_SCOPE_HOME" \\',
    '  -- "$SENTRY_REAL_SHELL" -c "$SCRIPT"',
    '',
  ].join('\n');
}

export async function writeToolShellWrapper(input: {
  readonly scopeBinDir: string;
  readonly spec: ToolShellSpec;
}): Promise<string> {
  const wrapperPath = join(input.scopeBinDir, 'sentry-bash');
  await mkdir(dirname(wrapperPath), { recursive: true });
  await writeFile(wrapperPath, renderToolShellWrapper(input.spec), { mode: 0o700 });
  try {
    await chmod(wrapperPath, 0o700);
  } catch {
    // Windows: best-effort (production boundary is Linux).
  }
  return wrapperPath;
}
