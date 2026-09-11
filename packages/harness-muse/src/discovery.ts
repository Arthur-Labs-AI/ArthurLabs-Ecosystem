import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { nowIsoTimestamp } from '@qa/shared';
import type { HarnessHealthResult } from '@qa/harness-protocol';
import { buildMuseChildEnvironment } from './environment.js';
import { MUSE_SDK_VERSION } from './sdk.js';
import { MuseHarnessError } from './errors.js';
import { redactDiagnostic, secretValues } from './redaction.js';

export type MuseAgentReadiness =
  'unconfigured' | 'configured' | 'ready' | 'degraded' | 'unavailable';

export interface MuseReadinessSummary {
  readonly readiness: MuseAgentReadiness;
  /** True only when model + binary are present (NOT proof of live auth). */
  readonly configured: boolean;
  readonly binaryAvailable: boolean;
  /** True only after a real session startup succeeded in this process scope. */
  readonly runtimeVerified: boolean;
}

/** Ephemeral in-process verification: a real session startup set it, nothing persists it. */
let runtimeVerifiedThisProcess = false;

export function markMuseRuntimeVerified(): void {
  runtimeVerifiedThisProcess = true;
}

export function museReadinessFromChecks(input: {
  readonly modelOk: boolean;
  readonly binaryOk: boolean;
  readonly runtimeVerified?: boolean;
  readonly degraded?: boolean;
}): MuseReadinessSummary {
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
  if (verified && !input.degraded) {
    return { readiness: 'ready', configured: true, binaryAvailable: true, runtimeVerified: true };
  }
  if (input.degraded || verified) {
    return {
      readiness: 'degraded',
      configured: true,
      binaryAvailable: true,
      runtimeVerified: verified,
    };
  }
  return {
    readiness: 'configured',
    configured: true,
    binaryAvailable: true,
    runtimeVerified: false,
  };
}

export interface MuseRuntimeConfiguration {
  readonly executable: string;
  readonly modelId: string;
  readonly discoverySource: 'explicit' | 'environment' | 'path';
}

export function resolveMuseRuntime(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): MuseRuntimeConfiguration {
  const environment = input.environment ?? process.env;
  const explicit = input.executable?.trim();
  const fromEnvironment = environment.SENTRY_MUSE_BINARY?.trim();
  const modelId = input.modelId?.trim() || environment.SENTRY_MUSE_MODEL?.trim();
  if (modelId === undefined || modelId.length === 0) {
    throw new MuseHarnessError(
      'MUSE_MODEL_NOT_CONFIGURED',
      'Muse model is not configured. Set SENTRY_MUSE_MODEL to an exact model id.',
    );
  }
  return {
    executable: explicit || fromEnvironment || 'muse',
    modelId,
    discoverySource: explicit ? 'explicit' : fromEnvironment ? 'environment' : 'path',
  };
}

export async function probeMuseExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], {
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
        new MuseHarnessError(
          'MUSE_START_FAILED',
          'Muse --version did not complete within 5 seconds.',
          true,
        ),
      );
    }, 5_000);
    child.once('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new MuseHarnessError(
          cause.code === 'ENOENT' ? 'MUSE_BINARY_NOT_FOUND' : 'MUSE_START_FAILED',
          cause.code === 'ENOENT'
            ? 'Muse executable was not found: ' + executable
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
          new MuseHarnessError(
            'MUSE_START_FAILED',
            redactDiagnostic(
              stderr || 'Muse --version exited with code ' + String(code),
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

export async function doctorMuse(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<
  HarnessHealthResult & {
    readonly executable?: string;
    readonly executableVersion?: string;
    readonly modelId?: string;
    readonly sdkVersion?: string;
    readonly readiness?: MuseAgentReadiness;
    readonly configured?: boolean;
    readonly binaryAvailable?: boolean;
    readonly runtimeVerified?: boolean;
  }
> {
  const environment = input.environment ?? process.env;
  const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message?: string }> = [];
  let runtime: MuseRuntimeConfiguration | undefined;
  try {
    runtime = resolveMuseRuntime({ ...input, environment });
    checks.push({ name: 'model', status: 'pass', message: runtime.modelId });
  } catch (cause) {
    checks.push({ name: 'model', status: 'fail', message: redactDiagnostic(cause) });
  }
  const executable = input.executable?.trim() || environment.SENTRY_MUSE_BINARY?.trim() || 'muse';
  let executableVersion: string | undefined;
  try {
    executableVersion = await probeMuseExecutable(executable, environment);
    checks.push({ name: 'binary', status: 'pass', message: executableVersion });
  } catch (cause) {
    checks.push({ name: 'binary', status: 'fail', message: redactDiagnostic(cause) });
  }
  const child = buildMuseChildEnvironment({ source: environment });
  checks.push({
    name: 'environment',
    status: 'pass',
    message:
      'Child env allowlisted (' +
      child.allowedNames.length +
      ' allowed, ' +
      child.blockedNames.length +
      ' blocked); blocked names are never forwarded.',
  });
  checks.push({ name: 'sdk', status: 'pass', message: MUSE_SDK_VERSION });
  checks.push({
    name: 'sandbox',
    status: 'warn',
    message:
      executableVersion === undefined
        ? 'Sandbox startup probe cannot run until Muse is available.'
        : 'Sandbox: not yet verified. Sandbox enforcement is validated by Muse at real session startup; Sentry passes no sandbox-disable flags.',
  });
  if (!runtimeVerifiedThisProcess) {
    checks.push({
      name: 'runtime',
      status: 'warn',
      message: 'No live Muse session has succeeded in this process scope yet.',
    });
  }
  const modelOk = checks.some((check) => check.name === 'model' && check.status === 'pass');
  const binaryOk = checks.some((check) => check.name === 'binary' && check.status === 'pass');
  const readiness = museReadinessFromChecks({ modelOk, binaryOk, degraded: true });
  const status = checks.some((check) => check.status === 'fail')
    ? 'unavailable'
    : checks.some((check) => check.status === 'warn')
      ? 'degraded'
      : 'healthy';
  return {
    status,
    checks,
    checkedAt: nowIsoTimestamp(),
    executable: isAbsolute(executable) ? executable : executable,
    ...(executableVersion === undefined ? {} : { executableVersion }),
    ...(runtime === undefined ? {} : { modelId: runtime.modelId }),
    sdkVersion: MUSE_SDK_VERSION,
    readiness: readiness.readiness,
    configured: readiness.configured,
    binaryAvailable: readiness.binaryAvailable,
    runtimeVerified: readiness.runtimeVerified,
  };
}
