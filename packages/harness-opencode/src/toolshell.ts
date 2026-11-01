import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BINARY_DOWNLOAD_SKIP_ENVIRONMENT, NON_INTERACTIVE_ENVIRONMENT } from '@qa/shared';

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
 * Network (`--unshare-net`): every tool shell ALSO enters a fresh network
 * namespace with no routes, so model-controlled shell/project code cannot
 * reach the Sentry localhost auth proxy (127.0.0.1 ephemeral port), other
 * host-local services, or the public network — even though the OpenCode
 * PARENT keeps host networking and reaches the proxy normally (the parent
 * is spawned by the process launcher and never exec'd through this
 * wrapper). Same-namespace loopback still works, so a shell that starts
 * its own local server and probes it keeps functioning; only HOST network
 * access is removed. Network access for model-controlled shells is
 * deny-by-default and Sentry-owned.
 *
 * Package installs (always on): when `egress` is set the namespace keeps
 * `--unshare-net` and gains exactly one way out, a Unix socket bind-mounted
 * at /tmp/.sentry-egress.sock and bridged by `socat` to 127.0.0.1:<port>
 * inside the namespace. Proxy environment variables point package managers
 * at it, and the host-side proxy admits only package-registry hosts.
 * Without `egress` the wrapper is the fully offline one.
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
  /** Registry-only egress through a host-side proxy; omitted means fully offline. */
  readonly egress?: ToolShellEgress | undefined;
}

export interface ToolShellEgress {
  /** Absolute host path of the egress proxy Unix socket. */
  readonly socketPath: string;
  /** Absolute socat binary path (bridges the in-namespace loopback port to the socket). */
  readonly socat: string;
  /** Loopback port inside the tool namespace. */
  readonly port: number;
}

export const TOOL_SHELL_EGRESS_SOCKET = '/tmp/.sentry-egress.sock';
export const TOOL_SHELL_EGRESS_PORT = 39871;

/** Proxy environment for tool shells; only the in-namespace loopback bridge is reachable. */
export function toolShellProxyEnvironment(port: number): Record<string, string> {
  const proxy = 'http://127.0.0.1:' + port;
  return {
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    npm_config_https_proxy: proxy,
    npm_config_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
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
  const egress = spec.egress;
  const egressPrelude =
    egress === undefined
      ? []
      : [
          'SENTRY_EGRESS_SOCKET=' + q(egress.socketPath),
          'SENTRY_SOCAT=' + q(egress.socat),
          'export SENTRY_REAL_SHELL SENTRY_SOCAT',
          'SENTRY_PRELUDE=' +
            q(
              [
                'socat_pid=',
                '"$SENTRY_SOCAT" TCP-LISTEN:' +
                  egress.port +
                  ',bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:' +
                  TOOL_SHELL_EGRESS_SOCKET +
                  ' >/dev/null 2>&1 &',
                'socat_pid=$!',
                'n=0',
                'while [ "$n" -lt 40 ]; do',
                '  if (exec 3<>/dev/tcp/127.0.0.1/' + egress.port + ') 2>/dev/null; then break; fi',
                '  n=$((n+1)); sleep 0.05',
                'done',
                '"$SENTRY_REAL_SHELL" -o pipefail -c "$1"',
                'code=$?',
                'kill "$socat_pid" 2>/dev/null',
                'exit "$code"',
              ].join('\n'),
            ),
        ];
  const egressBinds =
    egress === undefined
      ? []
      : [
          '  --unshare-pid \\',
          '  --bind "$SENTRY_EGRESS_SOCKET" ' + TOOL_SHELL_EGRESS_SOCKET + ' \\',
          ...Object.entries({
            ...toolShellProxyEnvironment(egress.port),
            ...BINARY_DOWNLOAD_SKIP_ENVIRONMENT,
            ...NON_INTERACTIVE_ENVIRONMENT,
          }).map(([name, value]) => '  --setenv ' + name + ' ' + q(value) + ' \\'),
        ];
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
    ...egressPrelude,
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
    '  --unshare-net \\',
    '  --dev /dev \\',
    '  --proc /proc \\',
    '  --bind "$SENTRY_RUN_TMP" /tmp \\',
    ...hideArgs,
    '  --bind "$SENTRY_WORKSPACE" "$SENTRY_WORKSPACE" \\',
    '  --bind "$SENTRY_SCOPE_HOME" "$SENTRY_SCOPE_HOME" \\',
    ...egressBinds,
    egress === undefined
      ? '  -- "$SENTRY_REAL_SHELL" -o pipefail -c "$SCRIPT"'
      : '  -- "$SENTRY_REAL_SHELL" -o pipefail -c "$SENTRY_PRELUDE" sentry-egress "$SCRIPT"',
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
