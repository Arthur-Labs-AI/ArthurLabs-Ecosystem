import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { nowIsoTimestamp } from '@qa/shared';
import type { HarnessHealthResult } from '@qa/harness-protocol';
import { buildOpenCodeModelId } from './model.js';
import { OpenCodeHarnessError } from './errors.js';
import { probeSystemdUser } from './process.js';
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
  /**
   * Production containment triple (systemd user units, bubblewrap sandbox,
   * config masking) all functional; false means OpenCode must not launch.
   */
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

export interface ResolvedOpenCodeExecutable {
  /** The exact executable string production execution would launch. */
  readonly executable: string;
  readonly source: OpenCodeExecutableSource;
  /** Managed candidate considered (diagnostics even when unused). */
  readonly managedCandidate?: string | undefined;
  /** True when `--version` probing succeeded (spawn-based: PATH-aware). */
  readonly available: boolean;
  /** Probed version text, when available. */
  readonly version?: string | undefined;
  /** Human-readable probe failure, when unavailable (no secrets). */
  readonly failureReason?: string | undefined;
  /** Original probe error for callers that must preserve typed failures. */
  readonly error?: unknown;
}

/**
 * Shared executable resolution + availability probe: the same discovery
 * production execution uses (explicit > env override > verified managed >
 * PATH lookup, fail-closed) combined with the spawn-based version probe
 * (PATH-aware, unlike filesystem-only checks). Used by doctor, pre-run
 * readiness, and registration preflight so all three probe the same
 * executable semantics. No provider contact, no model credit.
 */
export async function probeResolvedOpenCodeExecutable(
  input: {
    readonly executable?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly managedExecutable?: string;
  } = {},
): Promise<ResolvedOpenCodeExecutable> {
  const environment = input.environment ?? process.env;
  const resolved = resolveOpenCodeExecutable({
    ...(input.executable === undefined ? {} : { executable: input.executable }),
    environment,
    ...(input.managedExecutable === undefined
      ? {}
      : { managedExecutable: input.managedExecutable }),
  });
  const detail = describeOpenCodeExecutableFailure({
    environment,
    ...(resolved.managedCandidate === undefined
      ? {}
      : { managedCandidate: resolved.managedCandidate }),
  });
  try {
    const version = await probeOpenCodeExecutable(resolved.executable, environment, detail);
    return {
      executable: resolved.executable,
      source: resolved.source,
      ...(resolved.managedCandidate === undefined
        ? {}
        : { managedCandidate: resolved.managedCandidate }),
      available: true,
      version,
    };
  } catch (cause) {
    return {
      executable: resolved.executable,
      source: resolved.source,
      ...(resolved.managedCandidate === undefined
        ? {}
        : { managedCandidate: resolved.managedCandidate }),
      available: false,
      failureReason: cause instanceof Error ? cause.message.slice(0, 500) : 'probe failed',
      error: cause,
    };
  }
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

/**
 * OpenCode upstream providers (verified against models.dev + tagged
 * source + live captures). Transport is per provider+model, resolved by
 * OpenCode's own catalog — never provider-alone:
 * - `native-openrouter`: OpenCode ships a native SDK; Sentry redirects it.
 * - `opencode-catalog`: OpenCode's built-in provider/model metadata owns
 *   SDK + wire protocol (responses/chat/messages per model); Sentry
 *   overrides ONLY connection options (baseURL/apiKey/shell).
 * - `custom`: explicit test/gateway seams (npm/models/endpoint) take over.
 */
export type OpenCodeCatalogMode = 'native-openrouter' | 'opencode-catalog' | 'custom';

export interface OpenCodeProviderSpec {
  /** Environment variable holding this provider's key (never forwarded). */
  readonly credentialEnv: string;
  /** Default upstream base URL (overridable for tests/gateways). */
  readonly upstreamBaseUrl: string;
  readonly displayName: string;
}

export const OPENCODE_PROVIDER_SPECS: Record<string, OpenCodeProviderSpec> = {
  openrouter: {
    credentialEnv: 'OPENROUTER_API_KEY',
    upstreamBaseUrl: 'https://openrouter.ai/api/v1',
    displayName: 'OpenRouter',
  },
  opencode: {
    credentialEnv: 'OPENCODE_API_KEY',
    upstreamBaseUrl: 'https://opencode.ai/zen/v1',
    displayName: 'OpenCode Zen',
  },
  'opencode-go': {
    credentialEnv: 'OPENCODE_API_KEY',
    upstreamBaseUrl: 'https://opencode.ai/zen/go/v1',
    displayName: 'OpenCode Go',
  },
};

/** Resolve how a provider's SDK/transport is selected (never guess per model). */
export function openCodeCatalogMode(input: {
  readonly provider: string;
  readonly customNpm?: string;
  readonly customModels?: Readonly<Record<string, Record<string, unknown>>>;
  readonly directEndpoint?: string;
}): OpenCodeCatalogMode {
  if (
    input.customNpm !== undefined ||
    input.customModels !== undefined ||
    input.directEndpoint !== undefined
  ) {
    return 'custom';
  }
  if (input.provider === 'openrouter') return 'native-openrouter';
  return 'opencode-catalog';
}

export function openCodeProviderSpec(provider: string): OpenCodeProviderSpec | undefined {
  return OPENCODE_PROVIDER_SPECS[provider];
}

/** Supported provider ids for production runs (test seams use explicit endpoints). */
export function assertSupportedOpenCodeProvider(provider: string, customEndpoint: boolean): void {
  if (customEndpoint) return;
  if (openCodeProviderSpec(provider) === undefined) {
    throw new OpenCodeHarnessError(
      'OPENCODE_MODEL_NOT_CONFIGURED',
      'Unsupported OpenCode provider: ' +
        provider +
        '. Supported: openrouter, opencode, opencode-go. Set SENTRY_OPENCODE_PROVIDER.',
    );
  }
}

/** Trimmed credential for the provider (possibly empty; never logged). */
export function openCodeCredential(
  provider: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const spec = openCodeProviderSpec(provider);
  if (spec === undefined) return (environment.OPENROUTER_API_KEY ?? '').trim();
  return (environment[spec.credentialEnv] ?? '').trim();
}

export function openCodeCredentialPresent(
  provider: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return openCodeCredential(provider, environment).length > 0;
}

export function credentialEnvForProvider(provider: string): string {
  return openCodeProviderSpec(provider)?.credentialEnv ?? 'OPENROUTER_API_KEY';
}

/** Upstream base URL for a provider (explicit test/gateway override wins). */
export function openCodeUpstreamBaseUrl(provider: string, override?: string): string {
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return openCodeProviderSpec(provider)?.upstreamBaseUrl ?? 'https://openrouter.ai/api/v1';
}

/** Host-only form of a URL for diagnostics (never query, keys, or paths). */
export function upstreamHostForDiagnostics(url: string): string {
  try {
    return new URL(url).host || 'unknown-upstream';
  } catch {
    return 'unknown-upstream';
  }
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
 * Pure containment policy: masking failure always blocks; systemd and
 * bubblewrap failures block only outside the explicit dev bypass (where
 * they warn instead). Deterministic on every platform; unit-tested as a
 * matrix including healthy-host direct mode.
 */
export function isBlockingContainmentFailure(input: {
  readonly bypassed: boolean;
  readonly toolNamespace: string;
  readonly processBoundary: string;
  readonly configMasking: string;
}): boolean {
  if (input.configMasking === 'fail') return true;
  if (!input.bypassed && input.toolNamespace === 'fail') return true;
  if (!input.bypassed && input.processBoundary === 'fail') return true;
  return false;
}

export type OpenCodeVersionClassification = 'tested' | 'blocked' | 'override-allowed';

/**
 * Single shared OpenCode version policy: tested releases pass; anything
 * else is blocked unless SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION=1
 * explicitly permits it (warning/degraded, never silently healthy).
 * Used by assertTestedOpenCodeVersion, doctorOpenCode, and the runtime
 * pre-run gate so all three agree.
 */
export function classifyOpenCodeVersion(
  versionText: string,
  environment: NodeJS.ProcessEnv = process.env,
): OpenCodeVersionClassification {
  if (versionText.includes(OPENCODE_TESTED_VERSION)) return 'tested';
  if (openCodeUntestedVersionAllowed(environment)) return 'override-allowed';
  return 'blocked';
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
  if (classifyOpenCodeVersion(versionText, environment) !== 'blocked') return;
  throw new OpenCodeHarnessError(
    'OPENCODE_VERSION_MISMATCH',
    'OpenCode ' +
      versionText.slice(0, 100) +
      ' differs from tested ' +
      OPENCODE_TESTED_VERSION +
      '; refusing to run an unverified wire/security contract.',
  );
}

/**
 * Cheap local probe helper: run argv, true iff it exits 0 within budget.
 * Uses the supplied environment (same PATH/runtime context production
 * execution would see) rather than implicitly inheriting process.env.
 */
async function probeCommand(
  executable: string,
  argv: readonly string[],
  timeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...argv], {
        env: environment,
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
  const environment = input.environment ?? process.env;
  const [systemdUser, bubblewrap, masking] = await Promise.all([
    // Functional: a transient user unit must actually launch (the exact
    // mechanism production execution depends on), shared with launcher
    // selection via probeSystemdUser.
    probeSystemdUser(timeoutMs, environment),
    // Functional probe (not just presence): userns + mount must actually work.
    // Absolute /usr/bin/true: the sandbox PATH is not guaranteed.
    // --unshare-net is included because the tool-shell boundary depends on
    // network-namespace isolation too: a host that cannot provide it must
    // fail closed here, never silently run model shells with host networking.
    probeCommand(
      'bwrap',
      [
        '--ro-bind',
        '/',
        '/',
        '--unshare-net',
        '--tmpfs',
        '/tmp',
        '--proc',
        '/proc',
        '/usr/bin/true',
      ],
      timeoutMs,
      environment,
    ),
    (async () => {
      const { mkdtemp, rename, rm, stat } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      // Honor the evaluated environment's temp dir (production passes the
      // real runtime env, so behavior is unchanged there) so the probe
      // reflects the same filesystem context execution would see.
      const tmpParent =
        environment['TMPDIR'] ?? environment['TEMP'] ?? environment['TMP'] ?? tmpdir();
      let root: string | undefined;
      try {
        root = await mkdtemp(join(tmpParent, 'sentry-mask-probe-'));
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
        if (root !== undefined)
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
  const providerId = runtime?.provider ?? 'openrouter';
  const credentialEnv = credentialEnvForProvider(providerId);
  const credentialOk = openCodeCredentialPresent(providerId, environment);
  checks.push({
    name: 'credential',
    status: credentialOk ? 'pass' : 'fail',
    message: credentialOk
      ? credentialEnv + ' present (provider ' + providerId + ')'
      : credentialEnv + ' missing (provider ' + providerId + ')',
  });
  let binaryVersion: string | undefined;
  let binaryOk = false;
  if (runtime !== undefined) {
    // Effective discovery truth: path + source (managed/PATH/override),
    // probed with the shared spawn-based helper (PATH-aware).
    const probed = await probeResolvedOpenCodeExecutable({
      ...(input.executable === undefined ? {} : { executable: input.executable }),
      environment,
      ...(runtime.managedCandidate === undefined
        ? {}
        : { managedExecutable: runtime.managedCandidate }),
    });
    checks.push({
      name: 'executable',
      status: 'pass',
      message:
        probed.executable +
        ' (source: ' +
        probed.source +
        (probed.source === 'managed' ? ', Sentry-managed installation' : '') +
        ')',
    });
    if (probed.available && probed.version !== undefined) {
      binaryVersion = probed.version;
      binaryOk = true;
      checks.push({ name: 'binary', status: 'pass', message: binaryVersion });
      // Shared version policy: tested passes, blocked fails (preflight
      // refuses it), override-allowed warns (explicit dev opt-in).
      const classification = classifyOpenCodeVersion(binaryVersion, environment);
      if (classification === 'tested') {
        checks.push({ name: 'version', status: 'pass', message: binaryVersion });
      } else if (classification === 'override-allowed') {
        checks.push({
          name: 'version',
          status: 'warn',
          message:
            'OpenCode ' +
            binaryVersion +
            ' differs from tested ' +
            OPENCODE_TESTED_VERSION +
            '; allowed only because SENTRY_OPENCODE_ALLOW_UNTESTED_VERSION=1 is set',
        });
      } else {
        checks.push({
          name: 'version',
          status: 'fail',
          message:
            'OpenCode ' +
            binaryVersion +
            ' differs from tested ' +
            OPENCODE_TESTED_VERSION +
            '; production preflight will refuse this runtime',
        });
      }
    } else {
      checks.push({
        name: 'binary',
        status: 'fail',
        message: probed.failureReason ?? 'OpenCode binary unavailable',
      });
    }
  } else {
    checks.push({ name: 'binary', status: 'fail', message: 'Skipped: model not configured' });
  }
  // Containment prerequisites (all local, non-billable): the production
  // security boundary needs a working mount namespace, an owned process
  // boundary, and a working masking primitive. All three are hard failures
  // (registration preflight throws OPENCODE_SANDBOX_UNAVAILABLE when any is
  // missing), except under the explicit SENTRY_OPENCODE_ALLOW_DIRECT=1
  // development bypass, which downgrades systemd/bubblewrap to warnings
  // while masking stays hard (the adapter masks fail-closed regardless of
  // launcher).
  const bypassed = openCodeSandboxBypassed(environment);
  // The bypass flag itself is always a visible degradation: the adapter
  // intentionally skips the Bubblewrap tool-shell namespace in direct mode
  // even when every probe below passes.
  if (bypassed) {
    checks.push({
      name: 'direct-mode',
      status: 'warn',
      message:
        'SENTRY_OPENCODE_ALLOW_DIRECT=1 enables development-only weaker execution; ' +
        'the OpenCode production sandbox/tool namespace is intentionally bypassed.',
    });
  }
  try {
    const sandbox = await probeOpenCodeSandbox({ environment });
    const systemdStatus = sandbox.systemdUser ? 'pass' : bypassed ? 'warn' : 'fail';
    checks.push({
      name: 'tool-namespace',
      status: sandbox.bubblewrap ? 'pass' : bypassed ? 'warn' : 'fail',
      message: sandbox.bubblewrap
        ? 'bubblewrap mount namespace functional'
        : bypassed
          ? 'bubblewrap unavailable: bypassed for development-only direct execution (SENTRY_OPENCODE_ALLOW_DIRECT=1)'
          : 'bubblewrap unavailable: tool filesystem isolation missing',
    });
    checks.push({
      name: 'process-boundary',
      status: systemdStatus,
      message: sandbox.systemdUser
        ? 'systemd user transient units available'
        : bypassed
          ? 'systemd user unavailable: bypassed for development-only direct execution (SENTRY_OPENCODE_ALLOW_DIRECT=1)'
          : 'systemd user transient units unavailable: registration preflight blocks execution',
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
      status: 'fail',
      message: 'Containment probes could not run; OpenCode must not launch.',
    });
  }
  // Blocking vs warning evaluation: masking is always blocking; systemd and
  // bubblewrap block only outside the explicit dev bypass (where they warn).
  // A blocked version also blocks. Warnings otherwise degrade.
  const checkStatus = (name: string): string =>
    checks.find((check) => check.name === name)?.status ?? 'fail';
  const blockingContainmentFailure = isBlockingContainmentFailure({
    bypassed,
    toolNamespace: checkStatus('tool-namespace'),
    processBoundary: checkStatus('process-boundary'),
    configMasking: checkStatus('config-masking'),
  });
  const versionBlocked = checkStatus('version') === 'fail';
  const summary = openCodeReadinessFromChecks({
    modelOk: runtime !== undefined,
    credentialOk,
    binaryOk,
    sandboxOk: !blockingContainmentFailure && !versionBlocked,
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
