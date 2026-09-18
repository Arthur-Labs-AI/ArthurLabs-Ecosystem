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

/**
 * Readiness state machine (final semantics):
 * - unconfigured: model (or essential config) missing
 * - unavailable: configured but binary cannot execute / hard failure
 * - configured: model + binary + SDK local checks pass, no live session yet
 *   (sandbox-unverified and runtime-unverified are INFORMATIONAL here, not
 *   degraded: they describe what cheap checks cannot prove)
 * - ready: a real session startup succeeded and no real warning exists
 * - degraded: runtime works but a REAL warning exists (probe failure that is
 *   not hard, partial shutdown confidence, known restriction)
 */
export function museReadinessFromChecks(input: {
  readonly modelOk: boolean;
  readonly binaryOk: boolean;
  readonly runtimeVerified?: boolean;
  readonly realWarning?: boolean;
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

export interface MuseRuntimeConfiguration {
  readonly executable: string;
  readonly modelId: string;
  readonly discoverySource: 'explicit' | 'environment' | 'path';
}

/** `muse` on PATH may be the unrelated MusE music sequencer. */
export function isMuseCodeVersion(version: string): boolean {
  return /^Muse Code\s+v?\d+(?:\.\d+){1,2}\b/.test(version);
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
        new MuseHarnessError(
          code === 'ENOENT' ? 'MUSE_BINARY_NOT_FOUND' : 'MUSE_START_FAILED',
          code === 'ENOENT'
            ? 'Muse executable was not found: ' + executable
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
      const version = redactDiagnostic(
        (stdout || stderr).trim().slice(0, 200) || 'unknown',
        secretValues(environment),
      );
      // Linux also ships an unrelated music sequencer named `muse`.
      // A successful --version exit only proves that *some* binary exists.
      if (!isMuseCodeVersion(version)) {
        reject(
          new MuseHarnessError(
            'MUSE_START_FAILED',
            'Expected the Meta Muse Code CLI. Set SENTRY_MUSE_BINARY to its executable.',
          ),
        );
        return;
      }
      resolve(version);
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
  // No real warning exists at doctor scope: sandbox/runtime unverified are
  // informational (cheap checks cannot prove them), not degraded.
  const readiness = museReadinessFromChecks({ modelOk, binaryOk });
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
