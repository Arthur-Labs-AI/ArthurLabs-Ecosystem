import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { nowIsoTimestamp } from '@qa/shared';
import type { HarnessHealthResult } from '@qa/harness-protocol';
import { buildOpenCodeModelId } from './model.js';
import { OpenCodeHarnessError } from './errors.js';
import { redactDiagnostic, secretValues } from './redaction.js';

/** OpenCode release this adapter was designed and tested against. */
export const OPENCODE_TESTED_VERSION = '1.18.32' as const;

export type OpenCodeAgentReadiness =
  'unconfigured' | 'configured' | 'ready' | 'degraded' | 'unavailable';

export interface OpenCodeReadinessSummary {
  readonly readiness: OpenCodeAgentReadiness;
  readonly configured: boolean;
  readonly binaryAvailable: boolean;
  readonly runtimeVerified: boolean;
}

let runtimeVerifiedThisProcess = false;

export function markOpenCodeRuntimeVerified(): void {
  runtimeVerifiedThisProcess = true;
}

export function openCodeReadinessFromChecks(input: {
  readonly modelOk: boolean;
  readonly credentialOk: boolean;
  readonly binaryOk: boolean;
  /** Masking primitive works; false means OpenCode must not launch. */
  readonly sandboxOk?: boolean;
  readonly runtimeVerified?: boolean;
  readonly realWarning?: boolean;
}): OpenCodeReadinessSummary {
  const verified = input.runtimeVerified ?? runtimeVerifiedThisProcess;
  if (!input.modelOk || !input.credentialOk) {
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
  if (input.sandboxOk === false) {
    return {
      readiness: 'unavailable',
      configured: false,
      binaryAvailable: true,
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

export type OpenCodeExecutableSource = 'explicit' | 'environment' | 'managed' | 'path';

/** Sentry-managed OpenCode layout under a data root (never hardcode a home directory). */
export const MANAGED_OPENCODE_TOOL_SEGMENTS = [
  'tools',
  'opencode',
  'node_modules',
  '.bin',
  'opencode',
] as const;

/** Derive the managed OpenCode executable from a Sentry data root. */
export function managedOpenCodeExecutable(dataRoot: string): string {
  return join(dataRoot, ...MANAGED_OPENCODE_TOOL_SEGMENTS);
}

export interface OpenCodeExecutableResolution {
  readonly executable: string;
  readonly source: OpenCodeExecutableSource;
  /** Managed candidate that was considered (for diagnostics, even when unused). */
  readonly managedCandidate?: string | undefined;
}

/** True iff the path exists, is a file (or link to one), and is executable. */
export function isExecutableFileSync(candidate: string): boolean {
  try {
    const info = statSync(candidate);
    if (!info.isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Executable discovery order (no silent fallback past an explicit source):
 * explicit argument > SENTRY_OPENCODE_BINARY > verified managed
 * installation > PATH lookup. Explicit/environment values win
 * unconditionally — a broken explicit override fails closed at the probe
 * instead of silently falling through to managed/PATH.
 */
export function resolveOpenCodeExecutable(
  input: {
    readonly executable?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly managedExecutable?: string;
  } = {},
): OpenCodeExecutableResolution {
  const environment = input.environment ?? process.env;
  const explicit = input.executable?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return {
      executable: explicit,
      source: 'explicit',
      ...(input.managedExecutable === undefined
        ? {}
        : { managedCandidate: input.managedExecutable }),
    };
  }
  const fromEnvironment = environment.SENTRY_OPENCODE_BINARY?.trim();
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return {
      executable: fromEnvironment,
      source: 'environment',
      ...(input.managedExecutable === undefined
        ? {}
        : { managedCandidate: input.managedExecutable }),
    };
  }
  const managed = input.managedExecutable?.trim();
  if (managed !== undefined && managed.length > 0 && isExecutableFileSync(managed)) {
    return { executable: managed, source: 'managed', managedCandidate: managed };
  }
  return {
    executable: 'opencode',
    source: 'path',
    ...(input.managedExecutable === undefined ? {} : { managedCandidate: input.managedExecutable }),
  };
}

/** Actionable diagnosis when every candidate failed (no secrets included). */
export function describeOpenCodeExecutableFailure(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly managedCandidate?: string;
}): string {
  const environment = input.environment ?? process.env;
  const override = environment.SENTRY_OPENCODE_BINARY?.trim();
  const lines = [
    'OpenCode executable was not found.',
    'Checked:',
    '- SENTRY_OPENCODE_BINARY: ' +
      (override !== undefined && override.length > 0 ? override : 'not configured'),
  ];
  const managed = input.managedCandidate?.trim();
  if (managed !== undefined && managed.length > 0) {
    lines.push(
      '- Sentry-managed installation: ' +
        managed +
        (isExecutableFileSync(managed) ? ' (present)' : ' (not found/not executable)'),
    );
  } else {
    lines.push('- Sentry-managed installation: no candidate (data root unknown)');
  }
  lines.push('- PATH: `opencode` not found');
  lines.push(
    'Install OpenCode inside the selected WSL distro or configure an absolute Linux executable path.',
  );
  return lines.join('\n').slice(0, 2000);
}

export interface OpenCodeRuntimeConfiguration {
  readonly executable: string;
  /** Configured model id as entered (e.g. `anthropic/claude-x`). */
  readonly modelId: string;
  /** Provider id for the OpenCode session (initial production path: 'openrouter'). */
  readonly provider: string;
  /** Effective `--model` identifier (`provider/model`, e.g. `openrouter/anthropic/claude-x`). */
  readonly effectiveModelId: string;
  readonly discoverySource: OpenCodeExecutableSource;
  /** Managed candidate considered (diagnostics even when unused). */
  readonly managedCandidate?: string | undefined;
}

export function resolveOpenCodeRuntime(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly environment?: NodeJS.ProcessEnv;
    /** Sentry-managed candidate (derived from the runtime data root). */
    readonly managedExecutable?: string;
  } = {},
): OpenCodeRuntimeConfiguration {
  const environment = input.environment ?? process.env;
  const resolved = resolveOpenCodeExecutable({
    ...(input.executable === undefined ? {} : { executable: input.executable }),
    environment,
    ...(input.managedExecutable === undefined
      ? {}
      : { managedExecutable: input.managedExecutable }),
  });
  const identity = buildOpenCodeModelId(
    input.provider ?? environment.SENTRY_OPENCODE_PROVIDER,
    input.modelId ?? environment.SENTRY_OPENCODE_MODEL,
  );
  return {
    executable: resolved.executable,
    modelId: identity.configuredModel,
    provider: identity.provider,
    effectiveModelId: identity.effectiveModelId,
    discoverySource: resolved.source,
    ...(resolved.managedCandidate === undefined
      ? {}
      : { managedCandidate: resolved.managedCandidate }),
  };
}

export function openRouterCredentialPresent(environment: NodeJS.ProcessEnv = process.env): boolean {
  return (environment.OPENROUTER_API_KEY ?? '').trim().length > 0;
}

/** Dev/test opt-outs from fail-closed production sandbox enforcement. */
export function openCodeSandboxBypassed(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment['SENTRY_OPENCODE_ALLOW_DIRECT'] === '1';
}

export function openCodeUntestedVersionAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment['SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION'] === '1';
}

/**
 * Version policy: the wire parser and security assumptions are verified
 * against OPENCODE_TESTED_VERSION. Anything else fails closed unless
 * explicitly allowed for development.
 */
export function assertTestedOpenCodeVersion(
  versionText: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (versionText.includes(OPENCODE_TESTED_VERSION)) return;
  if (openCodeUntestedVersionAllowed(environment)) return;
  throw new OpenCodeHarnessError(
    'OPENCODE_VERSION_MISMATCH',
    'OpenCode ' +
      versionText.slice(0, 100) +
      ' differs from tested ' +
      OPENCODE_TESTED_VERSION +
      '; refusing to run an unverified wire/security contract.',
  );
}

/** Cheap local probe helper: run argv, true iff it exits 0 within budget. */
async function probeCommand(
  executable: string,
  argv: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...argv], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignored.
        }
        resolve(false);
      },
      Math.max(1, timeoutMs),
    );
    if (timer.unref !== undefined) timer.unref();
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** Non-billable containment prerequisite probes (all local, no provider use). */
export async function probeOpenCodeSandbox(
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): Promise<{
  readonly systemdUser: boolean;
  readonly bubblewrap: boolean;
  readonly masking: boolean;
}> {
  const timeoutMs = input.timeoutMs ?? 8_000;
  const [systemdUser, bubblewrap, masking] = await Promise.all([
    probeCommand('systemd-run', ['--user', '--version'], timeoutMs),
    // Functional probe (not just presence): userns + mount must actually work.
    probeCommand(
      'bwrap',
      ['--ro-bind', '/', '/', '--tmpfs', '/tmp', '--proc', '/proc', 'true'],
      timeoutMs,
    ),
    (async () => {
      const { mkdtemp, rename, rm, stat } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = await mkdtemp(join(tmpdir(), 'sentry-mask-probe-'));
      try {
        const from = join(root, '.opencode');
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(from, { recursive: true });
        await writeFile(join(from, 'probe'), 'x');
        const to = join(root, '.masked-probe');
        await rename(from, to);
        await stat(to);
        try {
          await stat(from);
          return false;
        } catch {
          return true;
        }
      } catch {
        return false;
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
    })(),
  ]);
  return { systemdUser, bubblewrap, masking };
}

export async function probeOpenCodeExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  /** Precomputed candidate diagnosis, used for actionable NOT_FOUND errors. */
  detail?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
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
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      reject(
        new OpenCodeHarnessError(
          code === 'ENOENT' ? 'OPENCODE_BINARY_NOT_FOUND' : 'OPENCODE_START_FAILED',
          code === 'ENOENT'
            ? (detail ?? 'OpenCode executable was not found: ' + executable)
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
        new OpenCodeHarnessError(
          'OPENCODE_START_FAILED',
          'OpenCode --version did not complete within 5 seconds.',
          true,
        ),
      );
    }, 5_000);
    child.once('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new OpenCodeHarnessError(
          cause.code === 'ENOENT' ? 'OPENCODE_BINARY_NOT_FOUND' : 'OPENCODE_START_FAILED',
          cause.code === 'ENOENT'
            ? (detail ?? 'OpenCode executable was not found: ' + executable)
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
          new OpenCodeHarnessError(
            'OPENCODE_START_FAILED',
            redactDiagnostic(
              stderr || 'OpenCode --version exited with code ' + String(code),
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

export async function doctorOpenCode(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly managedExecutable?: string;
  } = {},
): Promise<
  HarnessHealthResult & {
    readonly executable?: string;
    readonly executableSource?: OpenCodeExecutableSource;
    readonly executableVersion?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly testedVersion?: string;
    readonly credentialConfigured?: boolean;
    readonly readiness?: OpenCodeAgentReadiness;
    readonly configured?: boolean;
    readonly binaryAvailable?: boolean;
    readonly runtimeVerified?: boolean;
  }
> {
  const environment = input.environment ?? process.env;
  const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message?: string }> = [];
  let runtime: OpenCodeRuntimeConfiguration | undefined;
  try {
    runtime = resolveOpenCodeRuntime({ ...input, environment });
    checks.push({
      name: 'model',
      status: 'pass',
      message: runtime.modelId + ' => ' + runtime.effectiveModelId,
    });
    checks.push({ name: 'provider', status: 'pass', message: runtime.provider });
  } catch (cause) {
    checks.push({
      name: 'model',
      status: 'fail',
      message: cause instanceof Error ? cause.message : 'Model not configured',
    });
  }
  // Credential presence only (never values, never a live probe): opening
  // Settings/Environment must not spend provider credit.
  const credentialOk = openRouterCredentialPresent(environment);
  checks.push({
    name: 'credential',
    status: credentialOk ? 'pass' : 'fail',
    message: credentialOk ? 'OPENROUTER_API_KEY present' : 'OPENROUTER_API_KEY missing',
  });
  let binaryVersion: string | undefined;
  let binaryOk = false;
  if (runtime !== undefined) {
    // Effective discovery truth: path + source (managed/PATH/override).
    checks.push({
      name: 'executable',
      status: 'pass',
      message:
        runtime.executable +
        ' (source: ' +
        runtime.discoverySource +
        (runtime.discoverySource === 'managed' ? ', Sentry-managed installation' : '') +
        ')',
    });
    try {
      binaryVersion = await probeOpenCodeExecutable(
        runtime.executable,
        environment,
        describeOpenCodeExecutableFailure({
          environment,
          ...(runtime.managedCandidate === undefined
            ? {}
            : { managedCandidate: runtime.managedCandidate }),
        }),
      );
      binaryOk = true;
      checks.push({ name: 'binary', status: 'pass', message: binaryVersion });
      // Wire-format policy: the JSONL parser is built for the tested
      // release. An exact match is ready; anything else is degraded —
      // never silently run an untested wire format as healthy.
      if (!binaryVersion.includes(OPENCODE_TESTED_VERSION)) {
        checks.push({
          name: 'version',
          status: 'warn',
          message:
            'OpenCode ' +
            binaryVersion +
            ' differs from tested ' +
            OPENCODE_TESTED_VERSION +
            '; wire format may differ',
        });
      } else {
        checks.push({ name: 'version', status: 'pass', message: binaryVersion });
      }
    } catch (cause) {
      checks.push({
        name: 'binary',
        status: 'fail',
        message: cause instanceof Error ? cause.message : 'OpenCode binary unavailable',
      });
    }
  } else {
    checks.push({ name: 'binary', status: 'fail', message: 'Skipped: model not configured' });
  }
  // Containment prerequisites (all local, non-billable): the production
  // security boundary needs a working mount namespace, an owned process
  // boundary, and a working masking primitive. Missing pieces degrade
  // readiness; the adapter preflight blocks execution regardless.
  try {
    const sandbox = await probeOpenCodeSandbox({ environment });
    checks.push({
      name: 'tool-namespace',
      status: sandbox.bubblewrap ? 'pass' : 'warn',
      message: sandbox.bubblewrap
        ? 'bubblewrap mount namespace functional'
        : 'bubblewrap unavailable: tool filesystem isolation missing',
    });
    checks.push({
      name: 'process-boundary',
      status: sandbox.systemdUser ? 'pass' : 'warn',
      message: sandbox.systemdUser
        ? 'systemd user transient units available'
        : 'systemd user unavailable: cgroup ownership falls back to process groups',
    });
    checks.push({
      name: 'config-masking',
      status: sandbox.masking ? 'pass' : 'fail',
      message: sandbox.masking
        ? 'project-config masking primitive works'
        : 'project-config masking primitive broken: OpenCode must not launch',
    });
  } catch {
    checks.push({
      name: 'sandbox',
      status: 'warn',
      message: 'Containment probes could not run; assuming weakest boundary.',
    });
  }
  const maskingCheck = checks.find((check) => check.name === 'config-masking');
  const summary = openCodeReadinessFromChecks({
    modelOk: runtime !== undefined,
    credentialOk,
    binaryOk,
    ...(maskingCheck === undefined ? {} : { sandboxOk: maskingCheck.status === 'pass' }),
    realWarning: checks.some((check) => check.status === 'warn'),
  });
  const failed = checks.some((check) => check.status === 'fail');
  const warned = checks.some((check) => check.status === 'warn');
  return {
    status: failed ? 'unavailable' : warned ? 'degraded' : 'healthy',
    checks,
    checkedAt: nowIsoTimestamp(),
    ...(runtime === undefined
      ? {}
      : {
          executable: runtime.executable,
          executableSource: runtime.discoverySource,
          modelId: runtime.effectiveModelId,
          provider: runtime.provider,
        }),
    ...(binaryVersion === undefined ? {} : { executableVersion: binaryVersion }),
    testedVersion: OPENCODE_TESTED_VERSION,
    credentialConfigured: credentialOk,
    readiness: summary.readiness,
    configured: summary.configured,
    binaryAvailable: summary.binaryAvailable,
    runtimeVerified: summary.runtimeVerified,
  };
}
