import { spawn } from 'node:child_process';
import { release } from 'node:os';
import { nowIsoTimestamp } from '@qa/shared';
import type { HarnessHealthResult } from '@qa/harness-protocol';
import { buildClaudeChildEnvironment } from './environment.js';
import { CLAUDE_CODE_TESTED_VERSION, classifyClaudeCodeVersion } from './sdk.js';
import { ClaudeCodeHarnessError } from './errors.js';
import { redactDiagnostic, secretValues } from './redaction.js';

export type GlmAgentReadiness =
  'unconfigured' | 'configured' | 'ready' | 'degraded' | 'unavailable';

export interface GlmReadinessSummary {
  readonly readiness: GlmAgentReadiness;
  readonly configured: boolean;
  readonly binaryAvailable: boolean;
  readonly runtimeVerified: boolean;
}

let runtimeVerifiedThisProcess = false;

export function markGlmRuntimeVerified(): void {
  runtimeVerifiedThisProcess = true;
}

export function glmReadinessFromChecks(input: {
  readonly modelOk: boolean;
  readonly binaryOk: boolean;
  readonly runtimeVerified?: boolean;
  readonly realWarning?: boolean;
}): GlmReadinessSummary {
  const verified = input.runtimeVerified ?? runtimeVerifiedThisProcess;
  if (!input.modelOk) {
    return {
      readiness: 'unconfigured',
      configured: false,
      binaryAvailable: input.binaryOk,
      runtimeVerified: false,
    };
  }
  if (!input.binaryOk) {
    return {
      readiness: 'unavailable',
      configured: false,
      binaryAvailable: false,
      runtimeVerified: false,
    };
  }
  if (input.realWarning === true) {
    return {
      readiness: 'degraded',
      configured: true,
      binaryAvailable: true,
      runtimeVerified: verified,
    };
  }
  if (verified) {
    return { readiness: 'ready', configured: true, binaryAvailable: true, runtimeVerified: true };
  }
  return {
    readiness: 'configured',
    configured: true,
    binaryAvailable: true,
    runtimeVerified: false,
  };
}

export interface GlmRuntimeConfiguration {
  readonly executable: string;
  readonly modelId: string;
  readonly provider: string;
  readonly discoverySource: 'explicit' | 'environment' | 'path';
}

/** A model ID alone cannot route Claude Code to Z.AI. Never use its default API. */
export function assertGlmEndpointConfigured(environment: NodeJS.ProcessEnv = process.env): void {
  const candidate = environment.ANTHROPIC_BASE_URL?.trim();
  let valid = false;
  if (candidate) {
    try {
      const endpoint = new URL(candidate);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
      valid =
        (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback)) &&
        endpoint.hostname !== 'api.anthropic.com' &&
        endpoint.username === '' &&
        endpoint.password === '';
    } catch {
      // An invalid URL cannot establish the intended provider route.
    }
  }
  if (!valid) {
    throw new ClaudeCodeHarnessError(
      'GLM_START_FAILED',
      'GLM provider endpoint is not configured. Set ANTHROPIC_BASE_URL to a trusted Z.AI Anthropic-compatible endpoint (for example https://api.z.ai/api/anthropic).',
    );
  }
}

/**
 * Non-throwing form of assertGlmEndpointConfigured for readiness/doctor
 * surfaces: identical policy (the assertion is the single source of truth),
 * safe reason string, no network, no secrets (hostnames only).
 */
export function validateGlmEndpoint(environment: NodeJS.ProcessEnv = process.env): {
  readonly valid: boolean;
  readonly reason?: string;
} {
  try {
    assertGlmEndpointConfigured(environment);
    return { valid: true };
  } catch (cause) {
    return {
      valid: false,
      reason:
        cause instanceof Error
          ? cause.message.slice(0, 300)
          : 'GLM provider endpoint is not configured',
    };
  }
}

/** Sentry uses an isolated Claude config directory, so host login state is not inherited. */
export function assertGlmAuthConfigured(environment: NodeJS.ProcessEnv = process.env): void {
  if (!environment.ANTHROPIC_AUTH_TOKEN?.trim()) {
    throw new ClaudeCodeHarnessError(
      'GLM_AUTH_FAILED',
      'GLM provider credential is not configured. Set ANTHROPIC_AUTH_TOKEN.',
    );
  }
}

export function resolveGlmRuntime(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): GlmRuntimeConfiguration {
  const environment = input.environment ?? process.env;
  const explicit = input.executable?.trim();
  const fromEnvironment = environment.SENTRY_CLAUDE_BINARY?.trim();
  const modelId = input.modelId?.trim() || environment.SENTRY_GLM_MODEL?.trim();
  if (modelId === undefined || modelId.length === 0) {
    throw new ClaudeCodeHarnessError(
      'GLM_MODEL_NOT_CONFIGURED',
      'GLM model is not configured. Set SENTRY_GLM_MODEL to an exact model id.',
    );
  }
  const provider =
    input.provider?.trim() || environment.SENTRY_GLM_PROVIDER?.trim() || 'zai-anthropic';
  return {
    executable: explicit || fromEnvironment || 'claude',
    modelId,
    provider,
    discoverySource: explicit ? 'explicit' : fromEnvironment ? 'environment' : 'path',
  };
}

export interface ClaudeExecutableIdentity {
  /** The executable string Sentry was configured to launch. */
  readonly configured: string;
  /** PATH-resolved executable path (where/from resolution when known). */
  readonly resolved: string;
  /** Filesystem realpath of the resolved executable, when resolvable. */
  readonly realpath: string | undefined;
  /** `claude --version` output (probed), when the binary runs. */
  readonly version: string | undefined;
  /** Runtime platform of the Sentry process. */
  readonly platform: NodeJS.Platform;
  /** True when running inside WSL (Linux + WSL markers). */
  readonly isWsl: boolean;
  /** True when the resolved executable lives under /mnt/* or is a Windows shim. */
  readonly isWindowsMounted: boolean;
}

/** Public WSL probe for launcher selection: true only on Linux under WSL. */
export function isWslEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return detectWsl(environment, platform);
}

function detectWsl(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  let kernel = '';
  try {
    kernel = release().toLowerCase();
  } catch {
    kernel = '';
  }
  if (kernel.includes('microsoft') || kernel.includes('wsl')) return true;
  const interop = environment['WSL_INTEROP'];
  const distro = environment['WSL_DISTRO_NAME'];
  return (
    (typeof interop === 'string' && interop.length > 0) ||
    (typeof distro === 'string' && distro.length > 0)
  );
}

/**
 * True only for PROVEN Windows execution: a path under /mnt/* (WSL
 * Windows mount) or a Windows script shim (.cmd/.bat/.ps1). A bare
 * `.exe` suffix is NOT proof: npm ships native Linux ELF binaries named
 * `claude.exe` (verified: `/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
 * is an x86-64 ELF). Extension alone must never block a run; when the
 * extension is the only signal, read the file magic instead of failing.
 */
function isWindowsMountedExecutable(resolved: string, realpath: string | undefined): boolean {
  const candidates = realpath === undefined ? [resolved] : [resolved, realpath];
  return candidates.some((candidate) => {
    const normalized = candidate.replace(/\\/g, '/');
    if (/^\/mnt\//i.test(normalized)) return true;
    return /\.(cmd|bat|ps1)$/i.test(normalized);
  });
}

/** First bytes of a file (for magic-byte inspection), or undefined. */
async function readFileMagic(path: string, length = 4): Promise<Buffer | undefined> {
  try {
    const { open } = await import('node:fs/promises');
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return bytesRead > 0 ? buffer.subarray(0, bytesRead) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** True for a Windows PE binary (`MZ` magic). Native Linux ELF (`\\x7fELF`) is NOT Windows. */
function isWindowsBinaryMagic(magic: Buffer | undefined): boolean {
  return magic !== undefined && magic.length >= 2 && magic[0] === 0x4d && magic[1] === 0x5a;
}

/** True for a Windows batch/powershell shim by content (never by name alone). */
async function isWindowsShimContent(path: string): Promise<boolean> {
  try {
    const { readFile } = await import('node:fs/promises');
    const head = (await readFile(path, 'utf8')).slice(0, 512).toLowerCase();
    return (
      head.includes('@echo off') ||
      head.includes('powershell') ||
      head.includes('cmd.exe') ||
      (head.startsWith('#!') === false && (head.includes('wine') || head.includes('c:\\windows')))
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the exact Claude executable Sentry will launch: configured
 * string, PATH-resolved path, filesystem realpath, probed version, and
 * platform/WSL facts. Persist only this metadata (never credentials).
 *
 * Throws GLM_CLAUDE_RUNTIME_MISMATCH when a Linux/WSL Sentry process
 * would launch a Windows-mounted executable or shim: mixed
 * Windows/Linux Claude execution is never allowed silently.
 */
export async function resolveClaudeExecutableIdentity(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeExecutableIdentity> {
  const { execFileSync } = await import('node:child_process');
  const { realpathSync } = await import('node:fs');
  let resolved = executable;
  try {
    // PATH resolution honors the caller environment: the binary Sentry
    // actually spawns is resolved the way the OS resolves it.
    const out = execFileSync(
      platform === 'win32' ? 'where' : 'sh',
      platform === 'win32' ? [executable] : ['-c', 'command -v ' + JSON.stringify(executable)],
      {
        env: environment as Record<string, string>,
        windowsHide: true,
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (out.length > 0 && out[0] !== undefined) resolved = out[0];
  } catch {
    // Resolution failure is non-fatal here: `resolved` stays the
    // configured string and the version probe below reports availability.
  }
  let realpath: string | undefined;
  try {
    realpath = realpathSync(resolved);
  } catch {
    realpath = undefined;
  }
  let version: string | undefined;
  try {
    version = await probeClaudeExecutable(executable, environment);
  } catch {
    version = undefined;
  }
  let windowsMounted = isWindowsMountedExecutable(resolved, realpath);
  // Ambiguous `.exe` suffix on Linux (npm's native ELF `claude.exe`):
  // inspect content instead of failing on the name. Block only proven
  // Windows execution (PE magic or Windows shim text); a native ELF or
  // shebang script passes regardless of suffix.
  if (windowsMounted === false && platform !== 'win32') {
    const inspectPath = realpath ?? resolved;
    if (/\.exe$/i.test(inspectPath)) {
      const magic = await readFileMagic(inspectPath);
      if (isWindowsBinaryMagic(magic)) {
        windowsMounted = true;
      } else if (magic !== undefined) {
        windowsMounted = false;
      } else {
        windowsMounted = await isWindowsShimContent(inspectPath);
      }
    }
  }
  const identity: ClaudeExecutableIdentity = {
    configured: executable,
    resolved,
    realpath,
    version,
    platform,
    isWsl: detectWsl(environment, platform),
    isWindowsMounted: windowsMounted,
  };
  if (platform !== 'win32' && identity.isWindowsMounted) {
    throw new ClaudeCodeHarnessError(
      'GLM_CLAUDE_RUNTIME_MISMATCH',
      'Claude Code executable resolves to Windows-mounted state (' +
        resolved +
        '); Sentry on Linux/WSL requires a native Linux Claude binary. ' +
        'Set SENTRY_CLAUDE_BINARY to the Linux binary.',
    );
  }
  return identity;
}

/**
 * Windows user profiles whose `.claude/ide` Claude Code unconditionally
 * binds into the bubblewrap sandbox on WSL (verified against the 2.1.270
 * binary: `RPe()` enumerates every dirent of `/mnt/c/Users` except
 * Public/Default/Default User/All Users, plus the USERPROFILE-derived
 * path, with no settings/env gate). A profile that exists but is not
 * readable+writable by the worker makes bwrap fail (`Can't mkdir ...
 * Permission denied`) before the shell starts — HOME isolation cannot
 * prevent this. Read-only detection only: never creates, modifies, or
 * repairs host state. Returns the blocking profile NAMES (never full
 * user data), empty when nothing blocks or when not on Linux/WSL.
 */
export async function probeWindowsProfileSandboxBlockers(
  input: {
    readonly platform?: NodeJS.Platform;
    readonly usersRoot?: string;
  } = {},
): Promise<readonly string[]> {
  const platform = input.platform ?? process.platform;
  if (platform !== 'linux') return [];
  const usersRoot = input.usersRoot ?? '/mnt/c/Users';
  const { readdir, access, constants } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(usersRoot, { withFileTypes: true });
  } catch {
    // Not a WSL mount layout (or unreadable root): nothing to report.
    // Detection failure must never block a run by itself.
    return [];
  }
  const skipped = new Set(['Public', 'Default', 'Default User', 'All Users']);
  const blockers: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (skipped.has(entry.name)) continue;
    // Mirror Claude's target: the profile must accept a `.claude`
    // mountpoint. A profile dir without read+write access guarantees the
    // bwrap failure observed live (traverse-only `d--x--x--x` still
    // lists in readdir but rejects every mkdir/stat inside).
    try {
      await access(
        entry.name === '' ? usersRoot : usersRoot + '/' + entry.name,
        constants.R_OK | constants.W_OK,
      );
    } catch {
      blockers.push(entry.name);
    }
  }
  return blockers;
}

export type ClaudeWslIsolationStatus = 'available' | 'unavailable' | 'not-required';

export interface ClaudeWslIsolationReport {
  readonly status: ClaudeWslIsolationStatus;
  /** Bounded human-readable reason (names/paths only, never secrets). */
  readonly reason: string;
  readonly backend?: 'systemd' | undefined;
  /** True when /mnt/c/Users was proven absent inside the probe unit. */
  readonly windowsMountsHidden?: boolean | undefined;
}

/**
 * Real mount-isolation preflight (no provider spend, no secrets).
 * Starts transient user units shadowing `/mnt/c` and proves:
 * systemd user units start here, `/mnt/c/Users` is absent inside,
 * the workspace stays visible, and the resolved Claude binary runs.
 * Non-WSL Linux returns `not-required`; any failure step returns
 * `unavailable` with the exact step named. Never throws.
 */
export async function probeClaudeWslMountIsolation(
  input: {
    readonly executable?: string;
    readonly workspaceDir?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly timeoutMs?: number;
  } = {},
): Promise<ClaudeWslIsolationReport> {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  if (platform !== 'linux' || !detectWsl(environment, platform)) {
    return { status: 'not-required', reason: 'mount isolation applies to WSL workers only' };
  }
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 30_000);
  const { access, constants } = await import('node:fs/promises');
  const findBinary = async (name: string): Promise<string | undefined> => {
    const pathValue = environment['PATH'] ?? process.env['PATH'] ?? '';
    for (const dir of pathValue.split(':').filter((d) => d.length > 0)) {
      try {
        await access(dir + '/' + name, constants.X_OK);
        return dir + '/' + name;
      } catch {
        // Keep searching.
      }
    }
    return undefined;
  };
  const systemdRun = await findBinary('systemd-run');
  const systemctl = await findBinary('systemctl');
  if (systemdRun === undefined || systemctl === undefined) {
    return {
      status: 'unavailable',
      reason: 'systemd user tools unavailable in worker PATH',
    };
  }
  const runProbeUnit = (
    unit: string,
    extraProps: readonly string[],
    executable: string,
    args: readonly string[],
  ): Promise<{ exit: number | undefined; stderr: string }> =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(
          systemdRun,
          [
            '--user',
            '--wait',
            '--pipe',
            '--collect',
            '--quiet',
            '--unit=' + unit,
            ...extraProps.flatMap((p) => ['-p', p]),
            '--',
            executable,
            ...args,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
      } catch {
        resolve({ exit: undefined, stderr: 'spawn_failed' });
        return;
      }
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 1024) stderr += chunk.toString('utf8').slice(0, 1024 - stderr.length);
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        resolve({ exit: undefined, stderr: 'probe_timeout' });
      }, timeoutMs);
      if (timer.unref !== undefined) timer.unref();
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ exit: undefined, stderr: 'spawn_failed' });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exit: code ?? undefined, stderr: stderr.trim().slice(0, 300) });
      });
    });
  const tag = 'sentry-glm-preflight-' + String(process.pid) + '-' + Date.now().toString(36);
  const bare = await runProbeUnit(tag + '-bare', [], '/usr/bin/true', []);
  if (bare.exit !== 0) {
    return {
      status: 'unavailable',
      reason:
        'systemd user units cannot start here (exit ' +
        String(bare.exit) +
        (bare.stderr.length > 0 ? ': ' + bare.stderr : '') +
        ')',
    };
  }
  const shadow = ['TemporaryFileSystem=/mnt/c'];
  const hidden = await runProbeUnit(tag + '-hide', shadow, '/usr/bin/test', [
    '!',
    '-e',
    '/mnt/c/Users',
  ]);
  if (hidden.exit !== 0) {
    return {
      status: 'unavailable',
      backend: 'systemd',
      reason:
        '/mnt/c/Users still visible inside the shadowed unit (exit ' +
        String(hidden.exit) +
        '); mount isolation cannot hide Windows profiles here',
    };
  }
  if (input.workspaceDir !== undefined) {
    const visible = await runProbeUnit(tag + '-work', shadow, '/usr/bin/test', [
      '-d',
      input.workspaceDir,
    ]);
    if (visible.exit !== 0) {
      return {
        status: 'unavailable',
        backend: 'systemd',
        reason: 'workspace not visible inside the shadowed unit; refusing an unsafe launch',
      };
    }
  }
  if (input.executable !== undefined) {
    const runnable = await runProbeUnit(tag + '-bin', shadow, input.executable, ['--version']);
    if (runnable.exit !== 0) {
      return {
        status: 'unavailable',
        backend: 'systemd',
        reason:
          'Claude binary does not execute inside the shadowed unit (exit ' +
          String(runnable.exit) +
          ')',
      };
    }
  }
  return {
    status: 'available',
    backend: 'systemd',
    windowsMountsHidden: true,
    reason: 'transient units start; /mnt/c/Users hidden; workspace and binary verified',
  };
}

export async function probeClaudeExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Narrow wrapper preserves the piped-stdio overload type (non-null
    // stdout/stderr) across the try/catch a bare ReturnType<typeof spawn>
    // would widen away.
    const spawnChild = () =>
      spawn(executable, ['--version'], {
        env: environment,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild();
    } catch (cause) {
      // spawn() itself throws synchronously for non-executable paths
      // (e.g. EFTYPE on Windows): wrap it so callers always see the typed
      // harness error, never a raw system error.
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      reject(
        new ClaudeCodeHarnessError(
          code === 'ENOENT' ? 'GLM_BINARY_NOT_FOUND' : 'GLM_START_FAILED',
          code === 'ENOENT'
            ? 'Claude Code executable was not found: ' + executable
            : redactDiagnostic(cause, secretValues(environment)),
          code !== 'ENOENT',
        ),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const boundedAppend = (current: string, chunk: Buffer) =>
      (current + chunk.toString('utf8')).slice(0, 4_096);
    child.stdout.on('data', (chunk: Buffer) => (stdout = boundedAppend(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = boundedAppend(stderr, chunk)));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new ClaudeCodeHarnessError(
          'GLM_START_FAILED',
          'Claude Code --version did not complete within 5 seconds.',
          true,
        ),
      );
    }, 5_000);
    child.once('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ClaudeCodeHarnessError(
          cause.code === 'ENOENT' ? 'GLM_BINARY_NOT_FOUND' : 'GLM_START_FAILED',
          cause.code === 'ENOENT'
            ? 'Claude Code executable was not found: ' + executable
            : redactDiagnostic(cause, secretValues(environment)),
          cause.code !== 'ENOENT',
        ),
      );
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new ClaudeCodeHarnessError(
            'GLM_START_FAILED',
            redactDiagnostic(
              stderr || 'Claude Code --version exited with code ' + String(code),
              secretValues(environment),
            ),
            true,
          ),
        );
        return;
      }
      resolve(
        redactDiagnostic(
          (stdout || stderr).trim().slice(0, 200) || 'unknown',
          secretValues(environment),
        ),
      );
    });
  });
}

export async function doctorGlm(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<
  HarnessHealthResult & {
    readonly executable?: string;
    readonly executableVersion?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly sdkVersion?: string;
    readonly readiness?: GlmAgentReadiness;
    readonly configured?: boolean;
    readonly binaryAvailable?: boolean;
    readonly runtimeVerified?: boolean;
  }
> {
  const environment = input.environment ?? process.env;
  const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message?: string }> = [];
  let runtime: GlmRuntimeConfiguration | undefined;
  try {
    runtime = resolveGlmRuntime({ ...input, environment });
    checks.push({ name: 'model', status: 'pass', message: runtime.modelId });
    checks.push({ name: 'provider', status: 'pass', message: runtime.provider });
  } catch (cause) {
    checks.push({ name: 'model', status: 'fail', message: redactDiagnostic(cause) });
  }
  try {
    assertGlmEndpointConfigured(environment);
    checks.push({
      name: 'endpoint',
      status: 'pass',
      message: 'ANTHROPIC_BASE_URL is configured; live routing remains unverified.',
    });
  } catch (cause) {
    checks.push({ name: 'endpoint', status: 'fail', message: redactDiagnostic(cause) });
  }
  try {
    assertGlmAuthConfigured(environment);
    checks.push({
      name: 'authentication',
      status: 'pass',
      message: 'ANTHROPIC_AUTH_TOKEN is set; validity remains unverified until a live session.',
    });
  } catch (cause) {
    checks.push({ name: 'authentication', status: 'fail', message: redactDiagnostic(cause) });
  }
  const executable =
    input.executable?.trim() || environment.SENTRY_CLAUDE_BINARY?.trim() || 'claude';
  let executableVersion: string | undefined;
  let executableIdentity: ClaudeExecutableIdentity | undefined;
  try {
    executableIdentity = await resolveClaudeExecutableIdentity(executable, environment);
    executableVersion = executableIdentity.version;
    if (executableVersion === undefined)
      executableVersion = await probeClaudeExecutable(executable, environment);
    checks.push({
      name: 'binary',
      status: 'pass',
      message:
        executableVersion +
        ' @ ' +
        executableIdentity.resolved +
        (executableIdentity.isWsl ? ' (WSL)' : ''),
    });
  } catch (cause) {
    if (cause instanceof ClaudeCodeHarnessError && cause.code === 'GLM_CLAUDE_RUNTIME_MISMATCH') {
      checks.push({ name: 'binary', status: 'fail', message: redactDiagnostic(cause) });
    } else {
      try {
        executableVersion = await probeClaudeExecutable(executable, environment);
        checks.push({ name: 'binary', status: 'pass', message: executableVersion });
      } catch (inner) {
        checks.push({ name: 'binary', status: 'fail', message: redactDiagnostic(inner) });
      }
    }
  }
  const child = buildClaudeChildEnvironment({ source: environment });
  // Safe isolation metadata (names only, never values): headless worker
  // must not inherit Windows profile or IDE-bridge state on Linux.
  const hostileProfile = child.blockedNames.filter((name) =>
    ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH'].some(
      (blocked) => blocked === name.toUpperCase(),
    ),
  );
  const hostileIde = child.blockedNames.filter(
    (name) =>
      /^VSCODE_/i.test(name) ||
      /^(ENABLE_IDE_INTEGRATION|CLAUDE_CODE_SSE_PORT|TERM_PROGRAM|IDEA_|JETBRAINS_)/i.test(name),
  );
  checks.push({
    name: 'environment',
    status: 'pass',
    message:
      'Child env allowlisted (' +
      child.allowedNames.length +
      ' allowed, ' +
      child.blockedNames.length +
      ' blocked); blocked names are never forwarded.' +
      (hostileProfile.length > 0
        ? ' Windows profile stripped: ' + hostileProfile.join(',') + '.'
        : '') +
      (hostileIde.length > 0 ? ' IDE bridge stripped: ' + hostileIde.join(',') + '.' : ''),
  });
  checks.push({
    name: 'sdk',
    status: 'pass',
    message:
      'Adapter validated against Claude Code ' +
      CLAUDE_CODE_TESTED_VERSION +
      ' (running ' +
      (executableVersion ?? 'unknown') +
      ')',
  });
  // Windows-profile sandbox blockers (Linux/WSL only, read-only): Claude
  // Code binds every enumerated `/mnt/c/Users/*/.claude/ide` into bwrap
  // unconditionally, so a traverse-only profile fails every Bash call.
  // Report names only (never profile contents); detection failure (~[])
  // never blocks the doctor by itself.
  let profileBlockers: readonly string[] = [];
  try {
    profileBlockers = await probeWindowsProfileSandboxBlockers();
  } catch {
    profileBlockers = [];
  }
  // Mount-isolation state decides what profile blockers MEAN. With a
  // healthy isolated launcher the blockers are invisible to Claude
  // (informational only — never repair host ACLs for them); without
  // isolation they explain why a direct launch must not proceed.
  let isolation: ClaudeWslIsolationReport;
  try {
    isolation = await probeClaudeWslMountIsolation({ executable, environment });
  } catch {
    isolation = { status: 'unavailable', reason: 'isolation preflight threw unexpectedly' };
  }
  if (isolation.status === 'available') {
    checks.push({
      name: 'wsl-isolation',
      status: 'pass',
      message:
        'Mount isolation healthy (systemd backend): /mnt/c hidden from the Claude worker namespace. ' +
        isolation.reason,
    });
    if (profileBlockers.length > 0) {
      checks.push({
        name: 'wsl-profiles',
        status: 'pass',
        message:
          'Host Windows profiles detected (' +
          profileBlockers.join(', ') +
          ') with zero impact — hidden from Claude by mount isolation; no host repair needed.',
      });
    }
  } else if (isolation.status === 'unavailable') {
    checks.push({
      name: 'wsl-isolation',
      status: 'fail',
      message: 'Mount isolation unavailable: ' + isolation.reason,
    });
    if (profileBlockers.length > 0) {
      checks.push({
        name: 'wsl-profiles',
        status: 'fail',
        message:
          'Inaccessible Windows profiles would fail the bubblewrap sandbox ' +
          '(`RPe()` binds every /mnt/c/Users/*/.claude/ide): ' +
          profileBlockers.join(', ') +
          '. Without mount isolation a direct launch must not proceed.',
      });
    }
  }
  // Honest version-gated sandbox readiness: a live-proven incompatible
  // binary is reported unavailable (not ready); otherwise the sandbox is
  // unverified until a real `printf` smoke succeeds inside Claude/bwrap.
  const versionPolicy =
    executableVersion === undefined ? 'unverified' : classifyClaudeCodeVersion(executableVersion);
  checks.push({
    name: 'sandbox',
    status:
      executableVersion === undefined || versionPolicy === 'blocked' ? 'fail' : ('warn' as const),
    message:
      executableVersion === undefined
        ? 'Sandbox startup probe cannot run until Claude Code is available.'
        : versionPolicy === 'blocked'
          ? 'Claude Code ' +
            executableVersion +
            ' is live-proven incompatible with the WSL/bubblewrap Bash sandbox; use ' +
            'the validated binary instead. Sandbox: unavailable.'
          : 'Sandbox: unverified. Run the real WSL Bash smoke (`printf sentry-bash-ok` inside Claude/bwrap) ' +
            'before trusting Bash; Sentry passes no sandbox-disable flags.',
  });
  if (!runtimeVerifiedThisProcess) {
    checks.push({
      name: 'runtime',
      status: 'warn',
      message: 'No live Claude Code session has succeeded in this process scope yet.',
    });
  }
  const modelOk = checks.some((check) => check.name === 'model' && check.status === 'pass');
  const endpointOk = checks.some((check) => check.name === 'endpoint' && check.status === 'pass');
  const authenticationOk = checks.some(
    (check) => check.name === 'authentication' && check.status === 'pass',
  );
  const binaryOk = checks.some((check) => check.name === 'binary' && check.status === 'pass');
  const readiness = glmReadinessFromChecks({
    modelOk: modelOk && endpointOk && authenticationOk,
    binaryOk,
  });
  const status = checks.some((check) => check.status === 'fail')
    ? 'unavailable'
    : checks.some((check) => check.status === 'warn')
      ? 'degraded'
      : 'healthy';
  return {
    status,
    checks,
    checkedAt: nowIsoTimestamp(),
    executable,
    ...(executableVersion === undefined ? {} : { executableVersion }),
    ...(runtime === undefined ? {} : { modelId: runtime.modelId, provider: runtime.provider }),
    sdkVersion: CLAUDE_CODE_TESTED_VERSION,
    readiness: readiness.readiness,
    configured: readiness.configured,
    binaryAvailable: readiness.binaryAvailable,
    runtimeVerified: readiness.runtimeVerified,
  };
}
