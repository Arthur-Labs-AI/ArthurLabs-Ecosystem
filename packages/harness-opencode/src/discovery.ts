import { spawn } from 'node:child_process';
import { nowIsoTimestamp } from '@qa/shared';
import type { HarnessHealthResult } from '@qa/harness-protocol';
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
  readonly modelId: string;
  /** Provider id for the OpenCode session (initial production path: 'openrouter'). */
  readonly provider: string;
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
  const modelId = input.modelId?.trim() || environment.SENTRY_OPENCODE_MODEL?.trim();
  if (modelId === undefined || modelId.length === 0) {
    throw new OpenCodeHarnessError(
      'OPENCODE_MODEL_NOT_CONFIGURED',
      'OpenCode model is not configured. Set SENTRY_OPENCODE_MODEL to an exact OpenRouter model id.',
    );
  }
  const provider =
    input.provider?.trim() || environment.SENTRY_OPENCODE_PROVIDER?.trim() || 'openrouter';
  return {
    executable: explicit || fromEnvironment || 'opencode',
    modelId,
    provider,
    discoverySource: explicit ? 'explicit' : fromEnvironment ? 'environment' : 'path',
  };
}

export function openRouterCredentialPresent(environment: NodeJS.ProcessEnv = process.env): boolean {
  return (environment.OPENROUTER_API_KEY ?? '').trim().length > 0;
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
    checks.push({ name: 'model', status: 'pass', message: runtime.modelId });
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
      if (!binaryVersion.includes(OPENCODE_TESTED_VERSION)) {
        checks.push({
          name: 'version',
          status: 'warn',
          message: 'OpenCode ' + binaryVersion + ' differs from tested ' + OPENCODE_TESTED_VERSION,
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
  const summary = openCodeReadinessFromChecks({
    modelOk: runtime !== undefined,
    credentialOk,
    binaryOk,
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
          modelId: runtime.modelId,
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
