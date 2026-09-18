import { spawn } from 'node:child_process';
import { nowIsoTimestamp } from '@qa/shared';
import type { HarnessHealthResult } from '@qa/harness-protocol';
import { buildClaudeChildEnvironment } from './environment.js';
import { CLAUDE_CODE_VERSION } from './sdk.js';
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
  try {
    executableVersion = await probeClaudeExecutable(executable, environment);
    checks.push({ name: 'binary', status: 'pass', message: executableVersion });
  } catch (cause) {
    checks.push({ name: 'binary', status: 'fail', message: redactDiagnostic(cause) });
  }
  const child = buildClaudeChildEnvironment({ source: environment });
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
  checks.push({ name: 'sdk', status: 'pass', message: CLAUDE_CODE_VERSION });
  checks.push({
    name: 'sandbox',
    status: 'warn',
    message:
      executableVersion === undefined
        ? 'Sandbox startup probe cannot run until Claude Code is available.'
        : 'Sandbox: not yet verified. Sandbox enforcement is validated by Claude Code at real session startup; Sentry passes no sandbox-disable flags.',
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
    sdkVersion: CLAUDE_CODE_VERSION,
    readiness: readiness.readiness,
    configured: readiness.configured,
    binaryAvailable: readiness.binaryAvailable,
    runtimeVerified: readiness.runtimeVerified,
  };
}
