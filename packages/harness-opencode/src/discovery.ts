import { spawn } from 'node:child_process';
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

export interface OpenCodeRuntimeConfiguration {
  readonly executable: string;
  /** Configured model id as entered (e.g. `anthropic/claude-x`). */
  readonly modelId: string;
  /** Provider id for the OpenCode session (initial production path: 'openrouter'). */
  readonly provider: string;
  /** Effective `--model` identifier (`provider/model`, e.g. `openrouter/anthropic/claude-x`). */
  readonly effectiveModelId: string;
  readonly discoverySource: 'explicit' | 'environment' | 'path';
}

export function resolveOpenCodeRuntime(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): OpenCodeRuntimeConfiguration {
  const environment = input.environment ?? process.env;
  const explicit = input.executable?.trim();
  const fromEnvironment = environment.SENTRY_OPENCODE_BINARY?.trim();
  const identity = buildOpenCodeModelId(
    input.provider ?? environment.SENTRY_OPENCODE_PROVIDER,
    input.modelId ?? environment.SENTRY_OPENCODE_MODEL,
  );
  return {
    executable: explicit || fromEnvironment || 'opencode',
    modelId: identity.configuredModel,
    provider: identity.provider,
    effectiveModelId: identity.effectiveModelId,
    discoverySource: explicit ? 'explicit' : fromEnvironment ? 'environment' : 'path',
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
            ? 'OpenCode executable was not found: ' + executable
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
            ? 'OpenCode executable was not found: ' + executable
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
  } = {},
): Promise<
  HarnessHealthResult & {
    readonly executable?: string;
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
    try {
      binaryVersion = await probeOpenCodeExecutable(runtime.executable, environment);
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
