import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { nowIsoTimestamp } from '@qa/shared';
import type { HarnessHealthResult } from '@qa/harness-protocol';
import { buildDeepSeekChildEnvironment } from './environment.js';
import { DEEPSEEK_SDK_VERSION, resolveExplicitDshEntry } from './sdk.js';
import { DeepSeekHarnessError } from './errors.js';
import { redactDiagnostic, secretValues } from './redaction.js';

export type DeepSeekAgentReadiness =
  'unconfigured' | 'configured' | 'ready' | 'degraded' | 'unavailable';

export interface DeepSeekReadinessSummary {
  readonly readiness: DeepSeekAgentReadiness;
  readonly configured: boolean;
  readonly binaryAvailable: boolean;
  readonly runtimeVerified: boolean;
}

let runtimeVerifiedThisProcess = false;

export function markDeepSeekRuntimeVerified(): void {
  runtimeVerifiedThisProcess = true;
}

export function deepSeekReadinessFromChecks(input: {
  readonly modelOk: boolean;
  readonly binaryOk: boolean;
  readonly runtimeVerified?: boolean;
  readonly realWarning?: boolean;
}): DeepSeekReadinessSummary {
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

/**
 * Resolve the installed `@deepseek-ai/dsh` package (entry + version) from
 * the harness's own module tree, where pnpm links the SDK client's declared
 * dependencies. Resolving from any other package root cannot traverse
 * pnpm's virtual store, so this helper is the single authority for "is a
 * compatible vendor runtime locally installed". No spawn, no network.
 */
export function resolveInstalledDshPackage(
  fromUrl: string = import.meta.url,
): { readonly entry: string; readonly version: string } | undefined {
  // createRequire (not import.meta.resolve) so this also works under
  // bundlers/test runners without import.meta.resolve, matching how the
  // vendor client itself resolves. Pure path/manifest reads: no spawn.
  const readVersion = (manifest: string): string | undefined => {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  };
  const entryFor = (manifest: string): { entry: string; version: string } | undefined => {
    const version = readVersion(manifest);
    if (version === undefined) return undefined;
    return { entry: join(dirname(manifest), 'lib', 'bin.js'), version };
  };
  try {
    const requireFromHere = createRequire(fromUrl);
    const clientManifest = requireFromHere.resolve('@deepseek-ai/dsh-sdk-client/package.json');
    // dirname(manifest) already ends at .../node_modules/@deepseek-ai, so the
    // sibling dsh package sits directly beneath it (no extra '..').
    const sibling = join(dirname(clientManifest), 'dsh', 'package.json');
    const viaSibling = entryFor(sibling);
    if (viaSibling !== undefined) return viaSibling;
  } catch {
    // Fall through to direct resolution below.
  }
  try {
    const requireFromHere = createRequire(fromUrl);
    return entryFor(requireFromHere.resolve('@deepseek-ai/dsh/package.json'));
  } catch {
    return undefined;
  }
}

export interface DeepSeekRuntimeConfiguration {
  readonly executable: string;
  readonly modelId: string;
  readonly provider: string;
  readonly discoverySource: 'explicit' | 'environment' | 'path';
}

export function resolveDeepSeekRuntime(
  input: {
    readonly executable?: string;
    readonly modelId?: string;
    readonly provider?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): DeepSeekRuntimeConfiguration {
  const environment = input.environment ?? process.env;
  const explicit = input.executable?.trim();
  const fromEnvironment = environment.SENTRY_DEEPSEEK_BINARY?.trim();
  const modelId = input.modelId?.trim() || environment.SENTRY_DEEPSEEK_MODEL?.trim();
  if (modelId === undefined || modelId.length === 0) {
    throw new DeepSeekHarnessError(
      'DEEPSEEK_MODEL_NOT_CONFIGURED',
      'DeepSeek model is not configured. Set SENTRY_DEEPSEEK_MODEL to an exact model id.',
    );
  }
  const provider =
    input.provider?.trim() || environment.SENTRY_DEEPSEEK_PROVIDER?.trim() || 'deepseek-official';
  return {
    executable: explicit || fromEnvironment || 'dsh',
    modelId,
    provider,
    discoverySource: explicit ? 'explicit' : fromEnvironment ? 'environment' : 'path',
  };
}

export async function probeDeepSeekExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Mirror the SDK client: the dsh runtime ships as a .js entry point
    // launched via node (see resolveDshLaunch in dsh-sdk-client). Spawning
    // a script path directly throws synchronously on Windows (EFTYPE).
    // Shell wrappers (e.g. Sentry's managed bin/dsh) execute directly —
    // the same executable-vs-entrypoint distinction as resolveExplicitDshEntry.
    const isScript = resolveExplicitDshEntry(executable) !== undefined;
    const command = isScript ? process.execPath : executable;
    const args = isScript ? [executable, '--version'] : ['--version'];
    // Narrow wrapper preserves the piped-stdio overload type (non-null
    // stdout/stderr) across the try/catch a bare ReturnType<typeof spawn>
    // would widen away.
    const spawnChild = () =>
      spawn(command, args, {
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
        new DeepSeekHarnessError(
          code === 'ENOENT' ? 'DEEPSEEK_BINARY_NOT_FOUND' : 'DEEPSEEK_START_FAILED',
          code === 'ENOENT'
            ? 'DeepSeek executable was not found: ' + executable
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
        new DeepSeekHarnessError(
          'DEEPSEEK_START_FAILED',
          'DeepSeek --version did not complete within 5 seconds.',
          true,
        ),
      );
    }, 5_000);
    child.once('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new DeepSeekHarnessError(
          cause.code === 'ENOENT' ? 'DEEPSEEK_BINARY_NOT_FOUND' : 'DEEPSEEK_START_FAILED',
          cause.code === 'ENOENT'
            ? 'DeepSeek executable was not found: ' + executable
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
          new DeepSeekHarnessError(
            'DEEPSEEK_START_FAILED',
            redactDiagnostic(
              stderr || 'DeepSeek --version exited with code ' + String(code),
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

export async function doctorDeepSeek(
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
    readonly readiness?: DeepSeekAgentReadiness;
    readonly configured?: boolean;
    readonly binaryAvailable?: boolean;
    readonly runtimeVerified?: boolean;
  }
> {
  const environment = input.environment ?? process.env;
  const checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message?: string }> = [];
  let runtime: DeepSeekRuntimeConfiguration | undefined;
  try {
    runtime = resolveDeepSeekRuntime({ ...input, environment });
    checks.push({ name: 'model', status: 'pass', message: runtime.modelId });
    if (runtime.modelId === 'deepseek-v4-flash') {
      checks.push({
        name: 'model-alias',
        status: 'warn',
        message:
          'Configured DeepSeek model uses legacy alias deepseek-v4-flash. Canonical tested route is deepseek-flash.',
      });
    }
    checks.push({ name: 'provider', status: 'pass', message: runtime.provider });
  } catch (cause) {
    checks.push({ name: 'model', status: 'fail', message: redactDiagnostic(cause) });
  }
  const executable =
    input.executable?.trim() || environment.SENTRY_DEEPSEEK_BINARY?.trim() || 'dsh';
  let executableVersion: string | undefined;
  try {
    executableVersion = await probeDeepSeekExecutable(executable, environment);
    checks.push({ name: 'binary', status: 'pass', message: executableVersion });
  } catch (cause) {
    checks.push({ name: 'binary', status: 'fail', message: redactDiagnostic(cause) });
  }
  const child = buildDeepSeekChildEnvironment({ source: environment });
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
  checks.push({ name: 'sdk', status: 'pass', message: DEEPSEEK_SDK_VERSION });
  checks.push({
    name: 'sandbox',
    status: 'warn',
    message:
      executableVersion === undefined
        ? 'Sandbox startup probe cannot run until DeepSeek Harness is available.'
        : 'Sandbox: not yet verified. Sandbox enforcement is validated by DeepSeek Harness at real session startup; Sentry passes no sandbox-disable flags.',
  });
  if (!runtimeVerifiedThisProcess) {
    checks.push({
      name: 'runtime',
      status: 'warn',
      message: 'No live DeepSeek session has succeeded in this process scope yet.',
    });
  }
  const modelOk = checks.some((check) => check.name === 'model' && check.status === 'pass');
  const binaryOk = checks.some((check) => check.name === 'binary' && check.status === 'pass');
  const readiness = deepSeekReadinessFromChecks({ modelOk, binaryOk });
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
    ...(runtime === undefined ? {} : { modelId: runtime.modelId, provider: runtime.provider }),
    sdkVersion: DEEPSEEK_SDK_VERSION,
    readiness: readiness.readiness,
    configured: readiness.configured,
    binaryAvailable: readiness.binaryAvailable,
    runtimeVerified: readiness.runtimeVerified,
  };
}
