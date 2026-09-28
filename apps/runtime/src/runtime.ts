/**
 * Sentry WSL/Linux runtime: owns the Stable Core behind a versioned stdio RPC.
 *
 * Transport contract:
 * - stdin: one JSON request object per line (NDJSON).
 * - stdout: PROTOCOL ONLY (one JSON response/notification per line).
 * - stderr: bounded human diagnostics (never secrets, never protocol).
 * Long operations (runs.start / retests.start) return the persisted identity
 * as soon as the row exists; the promise stays owned here. Live state flows
 * via notifications plus renderer polling.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { INITIAL_AGENT_STACKS } from '@qa/domain';
import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  resolveInside,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import {
  RunCoordinator,
  mergeRun,
  verifyMerge,
  ingestMergeIssues,
  retestIssue,
  requestRetestCancellation,
  cancelRetestRun,
} from '@qa/run-engine';
import {
  createOpenCodeRegistration,
  credentialEnvForProvider,
  managedOpenCodeExecutable,
  normalizeOpenCodeProvider,
  openCodeCredentialPresent,
  openCodeSandboxBypassed,
  probeOpenCodeSandbox,
  probeResolvedOpenCodeExecutable,
  classifyOpenCodeVersion,
  OPENCODE_TESTED_VERSION,
} from '@qa/harness-opencode';
import {
  createDeepSeekRegistration,
  DEEPSEEK_SDK_VERSION,
  resolveInstalledDshPackage,
} from '@qa/harness-deepseek';
import {
  createGlmRegistration,
  resolveClaudeExecutableIdentity,
  resolveGlmRuntime,
  validateGlmEndpoint,
  classifyClaudeCodeVersion,
  CLAUDE_CODE_TESTED_VERSION,
  type ClaudeExecutableIdentity,
} from '@qa/harness-claude-code';
import { HarnessAdapterRegistry } from '@qa/harness-protocol';
import { selectCurrentMergeResult } from '@qa/merger';
import { projectIssueState } from '@qa/schemas';
import {
  RUN_TIMEOUT_MS_MAX,
  RUN_TIMEOUT_MS_MIN,
  createQARunId,
  createRetestRunId,
} from '@qa/shared';
import {
  RUNTIME_EXPORT_MAX_RAW_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  RpcLineBuffer,
  RuntimeConfigureParamsSchema,
  RuntimeHelloResultSchema,
  encodeRpcLine,
  exportSizeAllowed,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from '@qa/runtime-protocol';

export const RUNTIME_VERSION = '0.1.0-beta.1' as const;

const ProjectIdInput = z.string().min(1).max(200);
const RunIdInput = z.string().regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
const IssueIdInput = z.string().regex(/^issue_[0-9A-HJKMNP-TV-Z]{26}$/);
const RetestRunIdInput = z.string().regex(/^retest_[0-9A-HJKMNP-TV-Z]{26}$/);
const MergeResultIdInput = z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/);

function toError(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const typed = error as { code?: unknown; message?: unknown };
    return {
      code: typeof typed.code === 'string' ? typed.code.slice(0, 100) : 'RUNTIME_ERROR',
      message:
        typeof typed.message === 'string'
          ? typed.message.slice(0, 1000)
          : 'Runtime operation failed',
    };
  }
  return {
    code: 'RUNTIME_ERROR',
    message: error instanceof Error ? error.message.slice(0, 1000) : 'Runtime operation failed',
  };
}

function sanitizeBranch(value: unknown): unknown {
  // Under a secret-shaped key only actual secret strings are redacted:
  // usage counters and other non-string leaves (notably the run-status
  // `tokens` object) pass through, so strict consumers keep validating.
  if (typeof value === 'string') return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeBranch(entry));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeBranch(entry);
    }
    return out;
  }
  return value;
}

export function sanitizeRpcValue(value: unknown): unknown {
  return sanitize(value);
}

/**
 * Enforce the single-response export ceiling before bytes are materialized
 * or emitted. Oversized canonical exports fail here with EXPORT_TOO_LARGE
 * instead of being silently dropped by line framing downstream (which
 * would surface as an ambiguous RUNTIME_TIMEOUT).
 */
export function assertExportTransportSize(sizeBytes: number, runId: string): void {
  if (exportSizeAllowed(sizeBytes)) return;
  throw rpcError(
    'EXPORT_TOO_LARGE',
    'Canonical export for ' +
      runId +
      ' is ' +
      sizeBytes +
      ' bytes, above the ' +
      RUNTIME_EXPORT_MAX_RAW_BYTES +
      '-byte runtime transport bound for single-response export. Inspect large runs in the Desktop run workspace.',
  );
}

function sanitize(value: unknown): unknown {
  // Defense in depth: never let KEY/TOKEN/SECRET-looking values reach stdout.
  if (typeof value === 'string') {
    return value
      .replace(/\b(Bearer)\s+\S+/gi, '$1 [REDACTED]')
      .replace(
        /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*([^\s,;]+)/gi,
        '$1=[REDACTED]',
      );
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/KEY|TOKEN|SECRET|PASSWORD|apiKey|authToken/i.test(key)) {
        out[key] = sanitizeBranch(entry);
      } else {
        out[key] = sanitize(entry);
      }
    }
    return out;
  }
  return value;
}

export interface RuntimeHostOptions {
  readonly dataRoot?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly onStderr?: (message: string) => void;
  /** Test seam: replace process.exit in shutdown paths. */
  readonly onExit?: (code: number) => void;
}

interface PendingRun {
  readonly operationId: string;
  readonly promise: Promise<unknown>;
}

function applyBinaryOverride(name: string, value: string | undefined): void {
  if (value !== undefined) process.env[name] = value;
  else delete process.env[name];
}

export interface SandboxDepsStatus {
  readonly socat: boolean;
  readonly bwrap: boolean;
  readonly socatVersion: string;
  readonly bwrapVersion: string;
  readonly initOk: boolean;
  readonly initDetail: string;
}

/**
 * GLM sandbox prerequisites, probed in the runtime host (not in harness
 * code): the pinned Claude sandbox runs fail-closed and needs `socat` +
 * `bwrap` plus a working user-namespace sandbox init. No model contact,
 * bounded synchronous probes, never throws — unknown means unverified.
 */
export function probeSandboxDeps(): SandboxDepsStatus {
  const missing: SandboxDepsStatus = {
    socat: false,
    bwrap: false,
    socatVersion: '',
    bwrapVersion: '',
    initOk: false,
    initDetail: 'unverified',
  };
  try {
    const has = (bin: string): boolean => {
      try {
        const r = spawnSync('sh', ['-c', 'command -v ' + bin], {
          encoding: 'utf8',
          timeout: 5000,
        });
        return r.status === 0;
      } catch {
        return false;
      }
    };
    const socat = has('socat');
    const bwrap = has('bwrap');
    let socatVersion = '';
    let bwrapVersion = '';
    let initOk = false;
    let initDetail = 'unverified';
    if (socat) {
      try {
        const r = spawnSync('socat', ['-V'], { encoding: 'utf8', timeout: 5000 });
        socatVersion = (String(r.stdout ?? r.stderr ?? '').split('\n')[0] ?? '')
          .trim()
          .slice(0, 120);
      } catch {
        socatVersion = '';
      }
    }
    if (bwrap) {
      try {
        const r = spawnSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 5000 });
        bwrapVersion = (String(r.stdout ?? '').split('\n')[0] ?? '').trim().slice(0, 120);
      } catch {
        bwrapVersion = '';
      }
      try {
        const smoke = spawnSync(
          'bwrap',
          ['--dev-bind', '/', '/', '--proc', '/proc', '/usr/bin/true'],
          { encoding: 'utf8', timeout: 10000 },
        );
        initOk = smoke.status === 0;
        initDetail = smoke.status === 0 ? 'smoke passed' : 'exit ' + String(smoke.status);
      } catch {
        initOk = false;
        initDetail = 'spawn failed';
      }
    } else {
      initDetail = 'bwrap-missing';
    }
    return { socat, bwrap, socatVersion, bwrapVersion, initOk, initDetail };
  } catch {
    return missing;
  }
}

/** Sentry-managed DeepSeek wrapper path (the Bash CLI entry operators use). */
export function deepseekManagedWrapperPath(dataRoot: string): string {
  return join(dataRoot, 'tools', 'deepseek', 'bin', 'dsh');
}

/**
 * GLM-specific environment extras: when the fail-closed sandbox cannot be
 * established, readiness is downgraded (never upgraded) with a specific
 * note, so the UI shows WHY instead of a generic unavailable state.
 */
export function glmSandboxStatus(deps: SandboxDepsStatus): Record<string, unknown> {
  if (deps.socat && deps.bwrap && deps.initOk) return {};
  const missing: string[] = [];
  if (!deps.socat) missing.push('`socat` is not installed in Ubuntu');
  if (!deps.bwrap) missing.push('`bubblewrap` is not installed in Ubuntu');
  if (deps.socat && deps.bwrap && !deps.initOk)
    missing.push('bubblewrap cannot initialize (' + deps.initDetail + ')');
  return {
    readiness: 'sandbox-unavailable',
    note: 'Sandbox unavailable: ' + missing.join('; ') + '.',
  };
}

export interface OpencodeSandboxGateInput {
  readonly systemdUser: boolean;
  readonly bubblewrap: boolean;
  readonly masking: boolean;
}

export interface OpencodeGateInput {
  readonly credential: boolean;
  readonly credentialName: string;
  readonly model: boolean;
  readonly executable: string;
  readonly exists: boolean;
  readonly version: string | undefined;
  readonly versionPolicy: 'ready' | 'mismatch-blocked' | 'mismatch-allowed';
  readonly testedVersion: string;
  readonly sandboxBypassed: boolean;
  readonly sandbox: OpencodeSandboxGateInput | undefined;
}

export interface DeepseekGateInput {
  readonly credential: boolean;
  readonly model: boolean;
  readonly wrapperPath: string;
  readonly wrapperExists: boolean;
  readonly wrapperVersion: string | undefined;
  readonly expectedVersion: string;
  readonly dshPackageVersion: string | undefined;
}

export interface GlmGateInput {
  readonly credential: boolean;
  readonly model: boolean;
  readonly endpointValid: boolean;
  readonly endpointReason: string;
  readonly executable: string | undefined;
  readonly windowsMounted: boolean;
  readonly version: string | undefined;
  readonly versionPolicy: 'ready' | 'blocked' | 'unverified';
  readonly testedVersion: string;
  readonly socat: boolean;
  readonly bwrap: boolean;
  readonly sandboxInitOk: boolean;
  readonly sandboxDetail: string;
  readonly systemdOk: boolean;
}

export interface GateVerdict {
  readonly ready: boolean;
  readonly reasons: string[];
  readonly warnings: string[];
}

/**
 * Pure pre-run readiness evaluators (no fs, no spawn, no network): HARD
 * FAILURE vs UNVERIFIED vs first-run-allowed, unit-tested as a matrix.
 * `runtimeVerified` is intentionally not an input — a live session having
 * never succeeded must not block the first run.
 */
export function evaluateOpencodeGate(input: OpencodeGateInput): GateVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!input.credential) reasons.push('OpenCode credential missing (' + input.credentialName + ')');
  if (!input.model) reasons.push('OpenCode model not set');
  if (!input.exists) reasons.push('OpenCode executable not found: ' + input.executable);
  else if (input.version === undefined)
    reasons.push('OpenCode executable did not answer its version probe: ' + input.executable);
  else if (input.versionPolicy === 'mismatch-blocked')
    reasons.push('OpenCode version ' + input.version + ' is not the tested ' + input.testedVersion);
  else if (input.versionPolicy === 'mismatch-allowed')
    warnings.push(
      'OpenCode version ' + input.version + ' differs from tested ' + input.testedVersion,
    );
  // Masking stays hard even under the dev bypass: the adapter masks
  // fail-closed regardless of launcher. systemd/bubblewrap downgrade to
  // warnings under bypass; without bypass all three block.
  if (input.sandbox !== undefined) {
    if (!input.sandbox.bubblewrap) {
      if (input.sandboxBypassed)
        warnings.push('bubblewrap unavailable: bypassed for development-only direct execution');
      else reasons.push('bubblewrap sandbox unavailable');
    }
    if (!input.sandbox.systemdUser) {
      if (input.sandboxBypassed)
        warnings.push(
          'systemd user isolation unavailable: bypassed for development-only direct execution',
        );
      else reasons.push('systemd user isolation unavailable');
    }
    if (!input.sandbox.masking) reasons.push('OpenCode project-config masking unavailable');
    if (input.sandboxBypassed)
      warnings.push(
        'SENTRY_OPENCODE_ALLOW_DIRECT=1 bypasses production sandbox (development only)',
      );
  } else if (input.sandboxBypassed) {
    warnings.push('SENTRY_OPENCODE_ALLOW_DIRECT=1 bypasses production sandbox (development only)');
  }
  return { ready: reasons.length === 0, reasons, warnings };
}

export function evaluateDeepseekGate(input: DeepseekGateInput): GateVerdict {
  const reasons: string[] = [];
  if (!input.credential) reasons.push('DeepSeek credential missing');
  if (!input.model) reasons.push('DeepSeek model not set');
  if (!input.wrapperExists)
    reasons.push('managed DeepSeek wrapper unavailable: ' + input.wrapperPath);
  else if (input.wrapperVersion === undefined)
    reasons.push('managed DeepSeek wrapper did not answer its version probe');
  else if (!input.wrapperVersion.includes(input.expectedVersion))
    reasons.push(
      'managed DeepSeek wrapper reports ' +
        input.wrapperVersion +
        ', expected ' +
        input.expectedVersion,
    );
  if (input.dshPackageVersion === undefined)
    reasons.push('compatible vendor DSH runtime is not locally resolvable');
  else if (input.dshPackageVersion !== input.expectedVersion)
    reasons.push(
      'local DSH runtime is ' +
        input.dshPackageVersion +
        ', expected SDK pin ' +
        input.expectedVersion,
    );
  return { ready: reasons.length === 0, reasons, warnings: [] };
}

export function evaluateGlmGate(input: GlmGateInput): GateVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!input.credential) reasons.push('GLM credential missing');
  if (!input.model) reasons.push('GLM model not set');
  if (!input.endpointValid) reasons.push(input.endpointReason);
  if (input.executable === undefined) reasons.push('Claude Code executable not found');
  else {
    if (input.windowsMounted)
      reasons.push('Claude Code resolves to a Windows mount; need a native Linux binary');
    if (input.version === undefined)
      reasons.push('Claude Code executable did not answer its version probe');
    else if (input.versionPolicy === 'blocked')
      reasons.push('Claude Code ' + input.version + ' is a known-incompatible version');
    else if (input.versionPolicy === 'unverified')
      warnings.push(
        'Claude Code version ' +
          input.version +
          ' is unverified (tested: ' +
          input.testedVersion +
          '); first run allowed',
      );
  }
  if (!input.socat) reasons.push('socat is not installed');
  if (!input.bwrap) reasons.push('bubblewrap is not installed');
  if (input.socat && input.bwrap && !input.sandboxInitOk)
    reasons.push('Claude sandbox unavailable (' + input.sandboxDetail + ')');
  if (!input.systemdOk) reasons.push('systemd user isolation unavailable');
  return { ready: reasons.length === 0, reasons, warnings };
}

export class SentryRuntimeHost {
  private readonly dataRoot: string;
  private readonly database: SentryDatabase;
  private readonly repository: SentryRepository;
  private readonly lease: RuntimeInstanceLease;
  private readonly projects: ProjectManager;
  private readonly registry: HarnessAdapterRegistry;
  private readonly coordinator: RunCoordinator;
  private readonly pendingRuns = new Map<string, PendingRun>();
  private readonly pendingRetests = new Map<string, PendingRun>();
  private readonly notify: (event: string, payload?: unknown) => void;
  private configuredModels: { opencode?: string; deepseek?: string; glm?: string } = {};
  private closed = false;

  constructor(
    dataRootOverride: string | undefined,
    notify: (event: string, payload?: unknown) => void,
  ) {
    this.notify = notify;
    this.dataRoot = dataRootOverride ?? defaultLinuxDataRoot();
    this.database = new SentryDatabase({ dataRoot: this.dataRoot });
    this.repository = new SentryRepository(this.database);
    this.lease = new RuntimeInstanceLease(this.repository);
    this.lease.start();
    this.projects = new ProjectManager(this.dataRoot, this.repository, {
      runtimeLease: this.lease,
    });
    this.registry = new HarnessAdapterRegistry()
      .register(
        createOpenCodeRegistration({
          managedExecutable: managedOpenCodeExecutable(this.dataRoot),
        }),
      )
      .register(createDeepSeekRegistration())
      .register(createGlmRegistration());
    this.coordinator = new RunCoordinator(
      this.dataRoot,
      this.repository,
      this.lease,
      this.registry,
    );
  }

  get runtimeDataRoot(): string {
    return this.dataRoot;
  }

  /**
   * Legacy Windows data roots are never migrated automatically: detect and
   * report them untouched. Historical simulation rows stay readable.
   */
  async legacyWindowsData(): Promise<unknown> {
    const { access, constants } = await import('node:fs/promises');
    const found: string[] = [];
    // Conventional Windows-mounted locations that may hold pre-WSL Sentry data.
    // Generic drive roots only — never user-specific paths.
    for (const drive of ['c', 'd']) {
      for (const tail of ['/Temp/sentry-live-data/sentry.db', '/Sentry/.sentry-live/sentry.db']) {
        const candidate = '/mnt/' + drive + tail;
        try {
          await access(candidate, constants.R_OK);
          found.push('/mnt/' + drive + tail.slice(0, tail.lastIndexOf('/')));
        } catch {
          // absent — nothing to report
        }
      }
    }

    return {
      detected: found,
      migrated: false,
      note:
        found.length === 0
          ? 'No legacy Windows-runtime data detected.'
          : 'Legacy Windows-runtime data detected. It has not been modified.',
    };
  }

  async recover(): Promise<void> {
    await this.coordinator.recover();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lease.release();
    this.database.close();
  }

  hello(): unknown {
    const hello = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      platform: process.platform,
      isWsl: isWslEnvironment(),
      nodeVersion: process.version,
      processExecPath: process.execPath,
      dataRoot: this.dataRoot,
    };
    return RuntimeHelloResultSchema.parse({
      ...hello,
      ...(isWslEnvironment() ? { distro: wslDistroName() } : {}),
    });
  }

  configure(params: unknown): unknown {
    const parsed = RuntimeConfigureParamsSchema.parse(params ?? {});
    if (parsed.models.opencode !== undefined) {
      process.env['SENTRY_OPENCODE_MODEL'] = parsed.models.opencode;
      this.configuredModels = { ...this.configuredModels, opencode: parsed.models.opencode };
    }
    if (parsed.models.deepseek !== undefined) {
      process.env['SENTRY_DEEPSEEK_MODEL'] = parsed.models.deepseek;
      this.configuredModels = { ...this.configuredModels, deepseek: parsed.models.deepseek };
    }
    if (parsed.models.glm !== undefined) {
      process.env['SENTRY_GLM_MODEL'] = parsed.models.glm;
      this.configuredModels = { ...this.configuredModels, glm: parsed.models.glm };
    }
    // Secrets live in runtime process memory only: never persisted to
    // SQLite, events, artifacts, or logs (sanitized at the RPC boundary).
    if (parsed.providers.openRouterApiKey !== undefined) {
      process.env['OPENROUTER_API_KEY'] = parsed.providers.openRouterApiKey;
    }
    if (parsed.providers.openCodeApiKey !== undefined) {
      process.env['OPENCODE_API_KEY'] = parsed.providers.openCodeApiKey;
    }
    if (parsed.openCodeProvider !== undefined) {
      process.env['SENTRY_OPENCODE_PROVIDER'] = parsed.openCodeProvider;
    }
    if (parsed.providers.deepseekApiKey !== undefined) {
      process.env['DEEPSEEK_API_KEY'] = parsed.providers.deepseekApiKey;
    }
    if (parsed.providers.anthropicAuthToken !== undefined) {
      process.env['ANTHROPIC_AUTH_TOKEN'] = parsed.providers.anthropicAuthToken;
    }
    if (parsed.providers.anthropicBaseUrl !== undefined) {
      process.env['ANTHROPIC_BASE_URL'] = parsed.providers.anthropicBaseUrl;
    }
    // Full-state binary overrides: the desktop always pushes its complete
    // current set, so a present block with an absent key clears a stale
    // override (Clear button works without restart). A missing block
    // leaves the environment untouched.
    if (parsed.binaries !== undefined) {
      applyBinaryOverride('SENTRY_OPENCODE_BINARY', parsed.binaries.opencode);
      applyBinaryOverride('SENTRY_DEEPSEEK_BINARY', parsed.binaries.deepseek);
      applyBinaryOverride('SENTRY_GLM_BINARY', parsed.binaries.glm);
      // The GLM harness resolves its executable from SENTRY_CLAUDE_BINARY
      // (or PATH `claude`). Mirror the pushed GLM override there so the
      // Desktop's persisted SENTRY_GLM_BINARY actually takes effect.
      // Harness discovery itself is untouched.
      applyBinaryOverride('SENTRY_CLAUDE_BINARY', parsed.binaries.glm);
    }
    return { configured: true };
  }

  // ---- projects ----
  listProjects(): unknown[] {
    return this.repository.listProjects().flatMap((project) => {
      const copy = this.repository.getManagedCopy(project.id);
      if (copy?.currentRevisionId === undefined) return [];
      return [
        {
          projectId: project.id,
          name: project.name,
          state: copy.state,
          currentRevisionId: copy.currentRevisionId,
          sourcePath: project.sourcePath,
          updatedAt: project.updatedAt,
          runCount: this.repository.countProjectRuns(project.id),
        },
      ];
    });
  }
  // ---- projects ----
  /** Opt-out of the default import exclusion set (full-tree v1 revisions). */
  private importIncludeAll(): boolean {
    return process.env['SENTRY_IMPORT_INCLUDE_ALL'] === '1';
  }

  async addProject(sourcePath: string): Promise<unknown> {
    const input = z.string().min(1).max(2000).parse(sourcePath);
    const translated = translateWindowsPath(input);
    await assertReadableDir(translated);
    return this.projects.addProject(translated, {
      ...(this.importIncludeAll() ? { includeAll: true as const } : {}),
    });
  }

  getProject(projectId: string): unknown {
    const id = ProjectIdInput.parse(projectId);
    const record = this.projects.getProject(id as never);
    if (record === undefined) throw rpcError('PROJECT_NOT_FOUND', 'Project not found: ' + id);
    return record;
  }

  listRevisions(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId);
    return this.repository.listRevisions(id as never);
  }

  async suggestTargets(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    const record = this.projects.getProject(id as never);
    if (record === undefined) throw rpcError('PROJECT_NOT_FOUND', 'Project not found: ' + id);
    const { projectDataPaths } = await import('@qa/persistence');
    const { readdir } = await import('node:fs/promises');
    const workingCopy = projectDataPaths(this.dataRoot, record.project.id).workingCopy;
    assertLinuxNative(workingCopy, 'managed copy');
    let entries: string[] = [];
    try {
      entries = (await readdir(workingCopy, { withFileTypes: true }))
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
        .sort()
        .slice(0, 100);
    } catch {
      entries = [];
    }
    return { projectId: record.project.id, paths: entries };
  }

  async updateProject(projectId: string, sourcePath?: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    // Salvage pass: a previous update killed mid-flight (client timeout,
    // host teardown) leaves state=updating with a stale operation row.
    // Reusing the boot-time recovery heals it when the owner is dead;
    // a genuinely live owner is left untouched (freshness check inside).
    try {
      const copy = this.repository.getManagedCopy(id as never);
      if (copy !== undefined && copy.state !== 'ready') {
        await this.projects.recoverAbandonedOperations(this.lease);
      }
    } catch {
      // Salvage is best-effort; the update below reports authoritatively.
    }
    const includeAll = this.importIncludeAll() ? { includeAll: true as const } : {};
    if (sourcePath === undefined)
      return this.projects.updateProjectCopy(id as never, undefined, includeAll);
    const parsed = z.string().min(1).max(2000).parse(sourcePath);
    const translated = translateWindowsPath(parsed);
    await assertReadableDir(translated);
    return this.projects.updateProjectCopy(id as never, translated, includeAll);
  }

  async deleteProject(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    await this.projects.deleteProject(id as never);
    return { projectId: id, deleted: true };
  }

  async projectDoctor(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    const record = this.projects.getProject(id as never);
    if (record === undefined) throw rpcError('PROJECT_NOT_FOUND', 'Project not found: ' + id);
    const { projectDataPaths } = await import('@qa/persistence');
    const { readdir } = await import('node:fs/promises');
    const workingCopy = projectDataPaths(this.dataRoot, record.project.id).workingCopy;
    let entries: string[] = [];
    try {
      entries = await readdir(workingCopy);
    } catch {
      entries = [];
    }
    const ecosystem = entries.includes('package.json') ? ['node'] : [];
    return {
      projectId: record.project.id,
      ready: record.managedCopy.state === 'ready',
      managedCopyState: record.managedCopy.state,
      currentRevisionId: record.revision.id,
      revisionCount: this.repository.listRevisions(id as never).length,
      runCount: this.repository.countProjectRuns(id as never),
      issueCount: this.repository.listIssues(id as never).length,
      detectedEcosystem: ecosystem,
      warnings:
        ecosystem.length === 0 ? ['No known ecosystem markers at the working-copy root.'] : [],
    };
  }

  // ---- runs ----
  listRuns(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId);
    return this.coordinator.listRuns(id as never).map((run) => ({
      ...run,
      agentSummary: this.coordinator.getRunStatus(run.id).agents,
      findingCount: this.repository.countRunFindings(run.id),
      issueCount: this.repository.listOccurrencesForRun(run.id).length,
    }));
  }

  runSnapshot(runId: string): unknown {
    const id = RunIdInput.parse(runId);
    const details = this.coordinator.getRunDetails(id as never);
    const mergeResults = this.repository.listMergeResults(id as never).map((merge) => ({
      ...merge,
      clusters: this.repository.listClusters(merge.id),
    }));
    // Authoritative current MergeResult (§12): highest supported
    // mergerVersion for this run — never repository ordering ([0]).
    // Historical results remain viewable in mergeResults.
    const currentMergeResultId = selectCurrentMergeResult(mergeResults)?.id;
    const verificationRuns = mergeResults.flatMap((m) =>
      this.repository.listVerificationRuns(m.id).map((vrun) => ({
        ...vrun,
        attempts: this.repository.listVerificationAttempts(vrun.id).map((attempt) => ({
          ...attempt,
          steps: this.repository.listVerificationSteps(attempt.id),
          observations: this.repository.listVerificationObservations(attempt.id),
          assertions: this.repository.listVerificationAssertions(attempt.id),
        })),
      })),
    );
    const issues = this.repository.listOccurrencesForRun(id as never);
    let targetSpec: unknown;
    try {
      targetSpec = this.repository.getTargetSpec(id as never) ?? undefined;
    } catch {
      targetSpec = undefined;
    }
    const project = this.repository.getProject(details.run.projectId as never) ?? undefined;
    let revision: unknown;
    try {
      const snapshot = this.repository.getSnapshot(details.run.snapshotId as never);
      revision =
        snapshot === undefined
          ? undefined
          : (this.repository.getRevision(snapshot.projectRevisionId as never) ?? undefined);
    } catch {
      revision = undefined;
    }
    // exports + counts ride along so canonical run inspection (Desktop
    // and the external CLI run.show) shares one shape with the local
    // RunCoordinator.getRunSummary contract.
    const exports = this.repository.listExports(id as never);
    return {
      run: details.run,
      ...(project === undefined ? {} : { project }),
      ...(revision === undefined ? {} : { revision }),
      agentRuns: details.agentRuns,
      findings: details.findings,
      evidence: details.evidence,
      exports,
      counts: {
        agentRuns: details.agentRuns.length,
        findings: details.findings.length,
        evidence: details.evidence.length,
        activities: details.activities.length,
        events: details.events.length,
        exports: exports.length,
      },
      activities: details.activities,
      events: details.events.map((e) => e.event),
      mergeResults,
      ...(currentMergeResultId === undefined ? {} : { currentMergeResultId }),
      verificationRuns,
      issues,
      ...(targetSpec === undefined ? {} : { targetSpec }),
    };
  }

  runStatus(runId: string): unknown {
    const id = RunIdInput.parse(runId);
    return this.coordinator.getRunStatus(id as never);
  }
  // ---- async run start: runId as soon as the row exists ----
  async startRun(
    projectId: string,
    params: unknown,
  ): Promise<{ operationId: string; runId?: string; status?: string }> {
    const id = ProjectIdInput.parse(projectId);
    const parsed = StartRunParamsSchema.parse(params ?? {});
    const operationId = 'dop_' + createQARunId().slice(4);
    const runPromise = this.coordinator.run(id as never, {
      executionKind: 'production',
      mode: parsed.mode,
      ...(parsed.includePaths === undefined
        ? {}
        : { target: { includePaths: [...parsed.includePaths] } }),
      ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
      ...(parsed.agentStackIds === undefined
        ? {}
        : { agentStackIds: [...parsed.agentStackIds] as never }),
      ...(parsed.runTimeoutMs === undefined ? {} : { runTimeoutMs: parsed.runTimeoutMs }),
    });
    const settled = runPromise.then(
      (details) => {
        this.pendingRuns.delete(operationId);
        this.notify('run.snapshot', { runId: details.run.id });
        return details;
      },
      (error: unknown) => {
        this.pendingRuns.delete(operationId);
        throw error;
      },
    );
    settled.then(undefined, () => undefined);
    this.pendingRuns.set(operationId, { operationId, promise: settled });
    const runId = await this.detectCreatedRun(id as never, settled);
    if (runId !== undefined) {
      this.notify('run.created', { runId, operationId });
      return { operationId, runId, status: this.persistedRunStatus(runId) };
    }
    const details = await settled.then((value) => value as { run: { id: string } });
    this.notify('run.created', { runId: details.run.id, operationId });
    return { operationId, runId: details.run.id, status: this.persistedRunStatus(details.run.id) };
  }

  /**
   * Persisted initial status for an async start response. Callers (notably
   * the CLI Nexus flow) must return the created runId without a follow-up
   * request, so the status travels with the start response. A missing row
   * means the start did not actually persist: report failure, never a
   * runId without truth behind it.
   */
  private persistedRunStatus(runId: string): string {
    const row = this.repository.getRun(runId as never);
    if (row === undefined) {
      throw rpcError('RUN_NOT_FOUND', 'Run row missing immediately after start: ' + runId);
    }
    return row.status;
  }

  /**
   * Row-or-settlement wait: polls until the QARun row appears (normal path,
   * seconds — even behind a slow snapshot) or the workflow promise settles.
   * Settlement-error throws the REAL backend error immediately instead of a
   * client timeout; settlement-success returns the id. There is no arbitrary
   * deadline here — the client's own timeout bounds the wait, and the desktop
   * reconciles any timeout against persisted rows before reporting.
   */
  private async detectCreatedRun(
    projectId: never,
    runPromise: Promise<unknown>,
  ): Promise<string | undefined> {
    const before = new Set(this.coordinator.listRuns(projectId).map((r) => r.id));
    let settled: { done: boolean; value?: unknown; error?: unknown } = { done: false };
    void runPromise.then(
      (value) => {
        settled = { done: true, value };
      },
      (error: unknown) => {
        settled = { done: true, error };
      },
    );
    for (;;) {
      const current = this.coordinator.listRuns(projectId);
      const created = current.find((r) => !before.has(r.id));
      if (created !== undefined) return created.id;
      if (settled.done) {
        if (settled.error !== undefined) throw settled.error;
        return (settled.value as { run?: { id?: string } } | undefined)?.run?.id;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  requestRunCancellation(runId: string): unknown {
    const id = RunIdInput.parse(runId);
    try {
      return this.coordinator.requestRunCancellation(id as never);
    } catch (error) {
      const sanitized = toError(error);
      throw rpcError(sanitized.code, sanitized.message);
    }
  }

  mergeRun(runId: string): unknown {
    const id = RunIdInput.parse(runId);
    return mergeRun(this.repository, id as never);
  }

  async verifyMerge(mergeResultId: string): Promise<unknown> {
    const id = MergeResultIdInput.parse(mergeResultId);
    return verifyMerge(this.repository, this.dataRoot, id as never);
  }

  ingestIssues(mergeResultId: string): unknown {
    const id = MergeResultIdInput.parse(mergeResultId);
    return ingestMergeIssues(this.repository, id as never);
  }

  /** Narrow Save As source: validated runId + format only. No caller-
   *  supplied paths ever reach the filesystem; bytes always come from the
   *  canonical RunExporter artifact for this run + format. The artifact
   *  size is gated BEFORE materializing bytes: the NDJSON runtime
   *  transport caps response lines, so an oversized export fails here with
   *  EXPORT_TOO_LARGE instead of being silently dropped downstream (which
   *  would surface as an ambiguous RUNTIME_TIMEOUT). */
  async exportContent(runId: string, format: string): Promise<unknown> {
    const id = RunIdInput.parse(runId);
    const parsed = z.enum(['log', 'json']).parse(format);
    const manifest = (await this.coordinator.exportRun(id as never, parsed)) as {
      artifactId: string;
    };
    const artifact = this.repository.getArtifact(manifest.artifactId as never);
    if (artifact !== undefined) {
      let sizeBytes = -1;
      try {
        sizeBytes = statSync(resolveInside(this.dataRoot, artifact.relativeStoragePath)).size;
      } catch {
        sizeBytes = -1;
      }
      if (sizeBytes >= 0) assertExportTransportSize(sizeBytes, id);
    }
    return this.coordinator.exportContent(id as never, parsed);
  }

  exportRun(runId: string, format: string): Promise<unknown> {
    const id = RunIdInput.parse(runId);
    const parsed = z.enum(['log', 'json']).parse(format);
    return this.coordinator.exportRun(id as never, parsed);
  }

  // ---- issues ----
  listIssues(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId);
    return this.repository.listIssues(id as never).map((issue) => ({
      ...issue,
      currentState: projectIssueState(this.repository.listIssueEvents(issue.id)),
    }));
  }

  getIssue(issueId: string): unknown {
    const id = IssueIdInput.parse(issueId);
    const issue = this.repository.getIssue(id as never);
    if (issue === undefined) throw rpcError('ISSUE_NOT_FOUND', 'Issue not found: ' + id);
    return {
      ...issue,
      currentState: projectIssueState(this.repository.listIssueEvents(id as never)),
    };
  }

  issueHistory(issueId: string): unknown {
    const id = IssueIdInput.parse(issueId);
    const events = this.repository.listIssueEvents(id as never);
    return {
      issue: this.repository.getIssue(id as never),
      currentState: projectIssueState(events),
      occurrences: this.repository.listIssueOccurrences(id as never),
      events,
      assessments: this.repository.listRetestAssessments(id as never),
      retests: this.repository.listRetestRuns(id as never),
    };
  }

  // ---- retests (async: retestRunId as soon as the row exists) ----
  listRetests(issueId: string): unknown[] {
    const id = IssueIdInput.parse(issueId);
    return this.repository.listRetestRuns(id as never);
  }

  async startRetest(
    issueId: string,
    params: unknown,
  ): Promise<{ operationId: string; retestRunId?: string }> {
    const id = IssueIdInput.parse(issueId);
    const parsed = StartRetestParamsSchema.parse(params ?? {});
    const operationId = 'dop_' + createRetestRunId().slice(7);
    const retestPromise = retestIssue(
      {
        dataRoot: this.dataRoot,
        repository: this.repository,
        lease: this.lease,
        registry: this.registry,
      },
      id as never,
      {
        ...(parsed.revisionId === undefined
          ? {}
          : { targetRevisionId: parsed.revisionId as never }),
        ...(parsed.agentStackIds === undefined
          ? {}
          : { agentStackIds: [...parsed.agentStackIds] as never }),
      },
    );
    const settled = retestPromise.then(
      (result) => {
        this.pendingRetests.delete(operationId);
        this.notify('retest.snapshot', { retestRunId: result.retestRun.id });
        return result;
      },
      (error: unknown) => {
        this.pendingRetests.delete(operationId);
        throw error;
      },
    );
    settled.then(undefined, () => undefined);
    this.pendingRetests.set(operationId, { operationId, promise: settled });
    const retestRunId = await this.detectCreatedRetest(id as never, settled);
    this.notify('retest.created', { retestRunId, operationId });
    return { operationId, retestRunId };
  }

  /** Same row-or-settlement contract as runs: no arbitrary deadline. */
  private async detectCreatedRetest(
    issueId: never,
    retestPromise: Promise<unknown>,
  ): Promise<string> {
    const before = new Set(this.repository.listRetestRuns(issueId).map((r) => r.id));
    let settled: { done: boolean; value?: unknown; error?: unknown } = { done: false };
    void retestPromise.then(
      (value) => {
        settled = { done: true, value };
      },
      (error: unknown) => {
        settled = { done: true, error };
      },
    );
    for (;;) {
      const current = this.repository.listRetestRuns(issueId);
      const created = current.find((r) => !before.has(r.id));
      if (created !== undefined) return created.id;
      if (settled.done) {
        if (settled.error !== undefined) throw settled.error;
        const id = (settled.value as { retestRun?: { id?: string } } | undefined)?.retestRun?.id;
        if (id !== undefined) return id;
        throw rpcError('RETEST_NOT_CREATED', 'RetestRun was not created');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  retestSnapshot(retestRunId: string): unknown {
    const id = RetestRunIdInput.parse(retestRunId);
    const retestRun = this.repository.getRetestRun(id as never);
    if (retestRun === undefined) throw rpcError('RETEST_NOT_FOUND', 'Retest not found: ' + id);
    const assessments = this.repository.listRetestAssessmentsForRun(id as never);
    let spec: unknown;
    try {
      spec = this.repository.getRetestSpec(id as never) ?? undefined;
    } catch {
      spec = undefined;
    }
    let targetRun: unknown;
    try {
      if (retestRun.targetQaRunId !== undefined) {
        targetRun = this.runSnapshot(retestRun.targetQaRunId as string);
      }
    } catch {
      targetRun = undefined;
    }
    return {
      retestRun,
      assessments,
      ...(spec === undefined ? {} : { spec }),
      ...(targetRun === undefined ? {} : { targetRun }),
    };
  }

  cancelRetest(retestRunId: string): unknown {
    const id = RetestRunIdInput.parse(retestRunId);
    const deps = {
      dataRoot: this.dataRoot,
      repository: this.repository,
      lease: this.lease,
      registry: this.registry,
    };
    try {
      requestRetestCancellation(deps, id as never);
      return cancelRetestRun(deps, id as never);
    } catch (error) {
      const sanitized = toError(error);
      throw rpcError(sanitized.code, sanitized.message);
    }
  }
  // ---- doctors / system (all inside the Linux runtime) ----
  async environmentDoctors(): Promise<unknown> {
    const [{ doctorOpenCode }, { doctorDeepSeek }, { doctorGlm }] = await Promise.all([
      import('@qa/harness-opencode'),
      import('@qa/harness-deepseek'),
      import('@qa/harness-claude-code'),
    ]);
    // Sandbox prerequisites for the fail-closed GLM sandbox, probed here
    // (not in harness code): presence + versions + a minimal no-model
    // bubblewrap init smoke. Never throws; unknown means unverified.
    const sandboxDeps = probeSandboxDeps();
    const [opencode, deepseek, glm] = await Promise.all([
      doctorOpenCode({
        managedExecutable: managedOpenCodeExecutable(this.dataRoot),
      }).catch(() => undefined),
      doctorDeepSeek().catch(() => undefined),
      doctorGlm().catch(() => undefined),
    ]);
    const stackStatus = (
      stackId: string,
      doctor:
        | {
            configured?: boolean;
            binaryAvailable?: boolean;
            runtimeVerified?: boolean;
            readiness?: string;
          }
        | undefined,
    ): Record<string, unknown> => ({
      id: stackId,
      configured: doctor?.configured ?? false,
      binaryAvailable: doctor?.binaryAvailable ?? false,
      runtimeVerified: doctor?.runtimeVerified ?? false,
      readiness: doctor?.readiness ?? 'unknown',
    });
    let verifier: Record<string, unknown> = {
      sandboxAvailable: false,
      runtimeReplaySupported: false,
      reason: 'probe pending',
    };
    try {
      const [{ SystemdSandboxBackend }, { verifierStagingParent }, { mkdir }] = await Promise.all([
        import('@qa/verifier'),
        import('@qa/run-engine'),
        import('node:fs/promises'),
      ]);
      const probeParent = verifierStagingParent(this.dataRoot);
      await mkdir(probeParent, { recursive: true });
      const availability = await new SystemdSandboxBackend().preflight(probeParent);
      verifier = {
        sandboxAvailable: availability.available,
        runtimeReplaySupported: availability.available,
        ...(availability.reason === undefined ? {} : { reason: availability.reason }),
      };
    } catch (error) {
      verifier = {
        sandboxAvailable: false,
        runtimeReplaySupported: false,
        reason: error instanceof Error ? error.message.slice(0, 300) : 'probe failed',
      };
    }
    const stacks = INITIAL_AGENT_STACKS.map((s) => {
      const opencodeDoctor = opencode as
        | {
            executable?: string;
            executableSource?: string;
            checks?: Array<{ name: string; status: string; message?: string }>;
          }
        | undefined;
      const opencodeNote = (opencodeDoctor?.checks ?? [])
        .filter((check) => check.status === 'fail')
        .map((check) => check.message ?? check.name)
        .slice(0, 3)
        .join('; ');
      const base =
        s.id === 'stack_opencode_main'
          ? {
              ...stackStatus(s.id, opencode as never),
              executionPath: opencodeDoctor?.executable ?? managedOpenCodeExecutable(this.dataRoot),
              ...(opencodeDoctor?.executableSource === undefined
                ? {}
                : { executableSource: opencodeDoctor.executableSource }),
              ...(opencodeNote.length === 0 ? {} : { note: opencodeNote }),
            }
          : s.id === 'stack_deepseek_main'
            ? {
                ...stackStatus(s.id, deepseek as never),
                executionPath: deepseekManagedWrapperPath(this.dataRoot),
                wrapperNote:
                  'Managed wrapper available; production SDK runtime resolves separately at startup.',
              }
            : {
                ...stackStatus(s.id, glm as never),
                ...glmSandboxStatus(sandboxDeps),
              };
      return {
        id: s.id,
        displayName: s.displayName,
        modelId: s.model.modelId,
        provider: s.model.provider,
        ...base,
      };
    });
    return {
      runtime: await this.runtimeIdentity(),
      agentStacks: stacks,
      sandboxDeps,
      verifier,
      dataRoot: this.dataRoot,
    };
  }

  async runtimeIdentity(): Promise<Record<string, unknown>> {
    const hello = this.hello() as Record<string, unknown>;
    return { ...hello, ...(await systemdIdentity()) };
  }

  activeRuns(): unknown[] {
    return this.repository
      .listNonterminalRuns()
      .map((r) => ({ runId: r.id, projectId: r.projectId, status: r.status }));
  }

  systemInfo(): unknown {
    return {
      dataRoot: this.dataRoot,
      versions: { runtime: RUNTIME_VERSION, merger: '2', verifier: '3', retest: '2' },
    };
  }

  /**
   * Hard local readiness probes for the pre-run gate. Pure filesystem and
   * bounded local spawns only: no model contact, no network, no paid calls.
   * `runtimeVerified` (a live session ever succeeding) is deliberately NOT
   * consulted here so first runs are never deadlocked by history.
   */
  static probeLocalExecutable(path: string): { exists: boolean; version: string | undefined } {
    try {
      accessSync(path, constants.X_OK);
      if (!statSync(path).isFile()) return { exists: false, version: undefined };
    } catch {
      return { exists: false, version: undefined };
    }
    try {
      const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 8000 });
      if (r.status !== 0) return { exists: true, version: undefined };
      const line = String(r.stdout ?? '')
        .split('\n')[0]
        ?.trim()
        .slice(0, 200);
      return { exists: true, version: line !== undefined && line.length > 0 ? line : undefined };
    } catch {
      return { exists: true, version: undefined };
    }
  }

  static resolveDshPackage(): { entry: string; version: string } | undefined {
    try {
      return resolveInstalledDshPackage();
    } catch {
      return undefined;
    }
  }

  static probeSandbox(): SandboxDepsStatus {
    return probeSandboxDeps();
  }

  static async probeOpencodeResolved(
    env: NodeJS.ProcessEnv,
    managedExecutable: string,
  ): Promise<{
    executable: string;
    source: string;
    available: boolean;
    version?: string | undefined;
    failureReason?: string | undefined;
  }> {
    return probeResolvedOpenCodeExecutable({ environment: env, managedExecutable });
  }

  static async probeOpencodeSandbox(env: NodeJS.ProcessEnv): Promise<{
    readonly systemdUser: boolean;
    readonly bubblewrap: boolean;
    readonly masking: boolean;
  }> {
    try {
      return await probeOpenCodeSandbox({ environment: env });
    } catch {
      return { systemdUser: false, bubblewrap: false, masking: false };
    }
  }

  static async probeClaudeIdentity(
    executable: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ identity: ClaudeExecutableIdentity | undefined; windowsMounted: boolean }> {
    try {
      const identity = await resolveClaudeExecutableIdentity(executable, env);
      return { identity, windowsMounted: identity.isWindowsMounted };
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === 'GLM_CLAUDE_RUNTIME_MISMATCH')
        return { identity: undefined, windowsMounted: true };
      return { identity: undefined, windowsMounted: false };
    }
  }

  static systemdUserReady(): boolean {
    try {
      const a = spawnSync('systemctl', ['--user', 'show-environment'], {
        encoding: 'utf8',
        timeout: 8000,
      });
      if (a.status !== 0) return false;
      const b = spawnSync('systemd-run', ['--user', '--pipe', '--wait', '/usr/bin/true'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      return b.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Pre-run provider gate from LIVE runtime state: configured env (pushed via
   * runtime.configure) plus hard local binary/sandbox evidence. Never inferred
   * from credential presence alone.
   */
  async productionReadiness(agentStackIds?: string[]): Promise<unknown> {
    const wants = (stack: string): boolean =>
      agentStackIds === undefined || agentStackIds.includes(stack);
    const env = process.env;
    const reasons: string[] = [];
    const warnings: string[] = [];
    const stacks: Array<{
      id: string;
      ready: boolean;
      reasons: string[];
      warnings: string[];
    }> = [];
    const pushVerdict = (
      id: string,
      verdict: { ready: boolean; reasons: string[]; warnings: string[] },
    ): void => {
      reasons.push(...verdict.reasons);
      warnings.push(...verdict.warnings);
      stacks.push({
        id,
        ready: verdict.ready,
        reasons: verdict.reasons,
        warnings: verdict.warnings,
      });
    };
    // Sandbox/isolation probes run per requested provider that needs them —
    // never defaulted to true for unprobed providers.
    if (wants('stack_opencode_main')) {
      const provider = normalizeOpenCodeProvider(env['SENTRY_OPENCODE_PROVIDER']);
      // Shared resolution+probe: the exact executable production execution
      // would launch, probed with the spawn-based helper (PATH-aware — the
      // same effective runtime environment production uses).
      const probed = await SentryRuntimeHost.probeOpencodeResolved(
        env,
        managedOpenCodeExecutable(this.dataRoot),
      );
      const version = probed.available ? probed.version : undefined;
      // Shared version policy (tested / blocked / override-allowed).
      const classification =
        version === undefined ? 'tested' : classifyOpenCodeVersion(version, env);
      const versionPolicy: 'ready' | 'mismatch-blocked' | 'mismatch-allowed' =
        classification === 'blocked'
          ? 'mismatch-blocked'
          : classification === 'override-allowed'
            ? 'mismatch-allowed'
            : 'ready';
      const linux = process.platform === 'linux';
      const bypassed = openCodeSandboxBypassed(env);
      // Single sandbox authority: probeOpenCodeSandbox is functionally
      // complete (transient unit launch, bwrap smoke, masking primitive).
      const sandbox = linux ? await SentryRuntimeHost.probeOpencodeSandbox(env) : undefined;
      pushVerdict(
        'stack_opencode_main',
        evaluateOpencodeGate({
          credential: openCodeCredentialPresent(provider, env),
          credentialName: credentialEnvForProvider(provider),
          model: (env['SENTRY_OPENCODE_MODEL'] ?? '').length > 0,
          executable: probed.executable,
          exists: probed.available,
          version,
          versionPolicy,
          testedVersion: OPENCODE_TESTED_VERSION,
          sandboxBypassed: bypassed,
          sandbox,
        }),
      );
    }
    if (wants('stack_deepseek_main')) {
      const wrapperPath =
        env['SENTRY_DEEPSEEK_BINARY']?.trim() || deepseekManagedWrapperPath(this.dataRoot);
      const probed = SentryRuntimeHost.probeLocalExecutable(wrapperPath);
      const dshPackage = SentryRuntimeHost.resolveDshPackage();
      const verdict = evaluateDeepseekGate({
        credential: (env['DEEPSEEK_API_KEY'] ?? '').length > 0,
        model: (env['SENTRY_DEEPSEEK_MODEL'] ?? '').length > 0,
        wrapperPath,
        wrapperExists: probed.exists,
        wrapperVersion: probed.version,
        expectedVersion: DEEPSEEK_SDK_VERSION,
        dshPackageVersion: dshPackage?.version,
      });
      pushVerdict('stack_deepseek_main', verdict);
    }
    if (wants('stack_glm_main')) {
      const endpoint = validateGlmEndpoint(env);
      const glmSandbox = SentryRuntimeHost.probeSandbox();
      const glmSystemd = SentryRuntimeHost.systemdUserReady();
      // Same resolution production preflight uses (env override or PATH).
      let glmRuntime: { executable: string };
      try {
        glmRuntime = resolveGlmRuntime({ environment: env });
      } catch {
        glmRuntime = { executable: env['SENTRY_CLAUDE_BINARY']?.trim() || 'claude' };
      }
      const probed = await SentryRuntimeHost.probeClaudeIdentity(glmRuntime.executable, env);
      const version = probed.identity?.version;
      pushVerdict(
        'stack_glm_main',
        evaluateGlmGate({
          credential: (env['ANTHROPIC_AUTH_TOKEN'] ?? '').length > 0,
          model: (env['SENTRY_GLM_MODEL'] ?? '').length > 0,
          endpointValid: endpoint.valid,
          endpointReason: endpoint.reason ?? 'GLM provider endpoint is not configured',
          executable: probed.identity === undefined ? undefined : probed.identity.resolved,
          windowsMounted: probed.windowsMounted,
          version,
          versionPolicy: version === undefined ? 'unverified' : classifyClaudeCodeVersion(version),
          testedVersion: CLAUDE_CODE_TESTED_VERSION,
          socat: glmSandbox.socat,
          bwrap: glmSandbox.bwrap,
          sandboxInitOk: glmSandbox.initOk,
          sandboxDetail: glmSandbox.initDetail,
          systemdOk: glmSystemd,
        }),
      );
    }
    return { ready: reasons.length === 0, reasons, warnings, productionWired: true, stacks };
  }

  async preRunGate(agentStackIds?: string[]): Promise<unknown> {
    const gate = (await this.productionReadiness(agentStackIds)) as {
      ready: boolean;
      warnings: string[];
      stacks: Array<{ id: string; ready: boolean; reasons: string[]; warnings: string[] }>;
    };
    return { ready: gate.ready, warnings: gate.warnings, stacks: gate.stacks };
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'runtime.hello':
        return this.hello();
      case 'runtime.configure':
        return this.configure(params);
      case 'runtime.environment':
        return this.environmentDoctors();
      case 'runtime.shutdown':
        return { shuttingDown: true };
      case 'projects.list':
        return this.listProjects();
      case 'projects.add':
        return this.addProject(requireString(params, 'sourcePath'));
      case 'projects.get':
        return this.getProject(requireString(params, 'projectId'));
      case 'projects.revisions':
        return this.listRevisions(requireString(params, 'projectId'));
      case 'projects.update':
        return this.updateProject(
          requireString(params, 'projectId'),
          optionalString(params, 'sourcePath'),
        );
      case 'projects.delete':
        return this.deleteProject(requireString(params, 'projectId'));
      case 'projects.doctor':
        return this.projectDoctor(requireString(params, 'projectId'));
      case 'projects.suggestTargets':
        return this.suggestTargets(requireString(params, 'projectId'));
      case 'runs.list':
        return this.listRuns(requireString(params, 'projectId'));
      case 'runs.get':
        return this.runSnapshot(requireString(params, 'runId'));
      case 'runs.status':
        return this.runStatus(requireString(params, 'runId'));
      case 'runs.start': {
        const { projectId: _projectId, ...rest } = params;
        void _projectId;
        return this.startRun(requireString(params, 'projectId'), rest);
      }
      case 'runs.cancel':
        return this.requestRunCancellation(requireString(params, 'runId'));
      // Merger / Verifier / issue-ingest RPCs are retired from the active
      // product. The class methods below stay for CLI + historical
      // compatibility but are no longer reachable over the WSL bridge.
      case 'runs.export':
        return this.exportRun(requireString(params, 'runId'), requireString(params, 'format'));
      case 'runs.exportContent':
        return this.exportContent(requireString(params, 'runId'), requireString(params, 'format'));
      case 'issues.list':
        return this.listIssues(requireString(params, 'projectId'));
      case 'issues.get':
        return this.getIssue(requireString(params, 'issueId'));
      case 'issues.history':
        return this.issueHistory(requireString(params, 'issueId'));
      case 'retests.list':
        return this.listRetests(requireString(params, 'issueId'));
      case 'retests.start': {
        const { issueId: _issueId, ...rest } = params;
        void _issueId;
        return this.startRetest(requireString(params, 'issueId'), rest);
      }
      case 'retests.get':
        return this.retestSnapshot(requireString(params, 'retestRunId'));
      case 'retests.cancel':
        return this.cancelRetest(requireString(params, 'retestRunId'));
      case 'system.activeRuns':
        return this.activeRuns();
      case 'system.info':
        return this.systemInfo();
      case 'production.readiness': {
        const ids = params['agentStackIds'];
        return this.productionReadiness(ids === undefined ? undefined : (ids as string[]));
      }
      case 'production.preRunGate': {
        const ids = params['agentStackIds'];
        return this.preRunGate(ids === undefined ? undefined : (ids as string[]));
      }
      default:
        throw rpcError('UNKNOWN_METHOD', 'Unknown runtime method: ' + method.slice(0, 120));
    }
  }
}

const StartRunParamsSchema = z
  .object({
    mode: z.enum(['full', 'targeted']),
    includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
    instructions: z.string().min(1).max(5000).optional(),
    agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
    runTimeoutMs: z.number().int().min(RUN_TIMEOUT_MS_MIN).max(RUN_TIMEOUT_MS_MAX).optional(),
  })
  .strict();

const StartRetestParamsSchema = z
  .object({
    revisionId: z.string().min(1).max(100).optional(),
    agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
  })
  .strict();

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function requireString(params: Record<string, unknown>, name: string): string {
  return z.string().min(1).max(2000).parse(params[name]);
}

function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  return z.string().min(1).max(2000).parse(value);
}

export function defaultLinuxDataRoot(): string {
  const home = process.env['HOME'];
  if (home !== undefined && home.length > 0) return join(home, '.local', 'share', 'sentry');
  return resolveSentryDataRoot();
}

export function isWslEnvironment(): boolean {
  if (process.platform !== 'linux') return false;
  if ((process.env['WSL_DISTRO_NAME'] ?? '').length > 0) return true;
  if ((process.env['WSL_INTEROP'] ?? '').length > 0) return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const release = readFileSync('/proc/version', 'utf8');
    if (/microsoft/i.test(release)) return true;
  } catch {
    return false;
  }
  return false;
}

function wslDistroName(): string | undefined {
  return process.env['WSL_DISTRO_NAME'];
}

async function systemdIdentity(): Promise<Record<string, unknown>> {
  try {
    const { SystemdSandboxBackend } = await import('@qa/verifier');
    const backend = new SystemdSandboxBackend();
    const available = typeof backend.preflight === 'function';
    void available;
  } catch {
    // diagnostics only
  }
  return { systemdProbed: true };
}

async function assertReadableDir(path: string): Promise<void> {
  const { stat, readdir } = await import('node:fs/promises');
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw rpcError(
      'PROJECT_SOURCE_UNAVAILABLE',
      'Source path is not a readable directory: ' + path.slice(0, 300),
    );
  }
  await readdir(path).catch(() => {
    throw rpcError(
      'PROJECT_SOURCE_UNAVAILABLE',
      'Source path is not readable: ' + path.slice(0, 300),
    );
  });
}

/** Windows C:\/D:\ paths must already be translated by the desktop bridge. */
function translateWindowsPath(input: string): string {
  if (/^[A-Za-z]:[\\/]/.test(input)) {
    throw rpcError(
      'WINDOWS_PATH_NOT_TRANSLATED',
      'Windows source paths must be translated to WSL paths by the desktop bridge: ' +
        input.slice(0, 120),
    );
  }
  if (!isAbsolute(input)) {
    throw rpcError('INVALID_SOURCE_PATH', 'Source path must be absolute: ' + input.slice(0, 120));
  }
  return input;
}

/** Agent workspaces must live under the Linux data root — never /mnt/c sources. */
function assertLinuxNative(path: string, what: string): void {
  if (path.startsWith('/mnt/')) {
    throw rpcError(
      'NON_NATIVE_' + what.toUpperCase().replace(/[^A-Z]+/g, '_'),
      what + ' must not live under /mnt: ' + path.slice(0, 200),
    );
  }
}

/** Stdio loop: stdin NDJSON requests, stdout protocol only, stderr diagnostics. */
export async function serveStdio(options: RuntimeHostOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.onStderr ?? ((message: string) => process.stderr.write(message + '\n'));
  const exit = options.onExit ?? ((code: number) => process.exit(code));
  const emit = (message: RpcNotification | RpcResponse): void => {
    output.write(encodeRpcLine(message as never));
  };
  const notify = (event: string, payload?: unknown): void => {
    emit({
      type: 'notification',
      event,
      ...(payload === undefined ? {} : { payload: sanitize(payload) }),
    });
  };
  let host: SentryRuntimeHost;
  try {
    host = new SentryRuntimeHost(options.dataRoot, notify);
    await host.recover();
  } catch (error) {
    const sanitized = sanitize(toError(error)) as { code: string; message: string };
    log('runtime boot failed: ' + sanitized.code + ' ' + sanitized.message);
    process.exitCode = 1;
    return;
  }
  log(
    'sentry runtime ready protocol=' +
      String(RUNTIME_PROTOCOL_VERSION) +
      ' dataRoot=' +
      host.runtimeDataRoot,
  );
  const buffer = new RpcLineBuffer();
  let shuttingDown = false;
  let inFlight = 0;
  const onData = (chunk: Buffer | string): void => {
    let messages: ReturnType<RpcLineBuffer['push']>;
    try {
      messages = buffer.push(chunk);
    } catch (error) {
      log(
        'rpc framing dropped input: ' +
          (error instanceof Error ? error.message : String(error)).slice(0, 200),
      );
      return;
    }
    for (const message of messages) {
      if (message.type !== 'request') continue;
      void handleRequest(message);
    }
  };
  const handleRequest = async (message: RpcRequest): Promise<void> => {
    const startedAt = Date.now();
    inFlight += 1;
    try {
      const { RUNTIME_METHODS } = await import('@qa/runtime-protocol');
      if (!(RUNTIME_METHODS as readonly string[]).includes(message.method)) {
        throw rpcError('UNKNOWN_METHOD', 'Unknown runtime method: ' + message.method.slice(0, 120));
      }
      const result = await host.dispatch(message.method, message.params ?? {});
      emit({ type: 'response', id: message.id, ok: true, result: sanitize(result) });
      if (message.method === 'runtime.shutdown') {
        shuttingDown = true;
        // Drain in-flight requests before closing (bounded 30 s).
        const deadline = Date.now() + 30_000;
        while (inFlight > 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        host.close();
        setImmediate(() => exit(0));
      }
      void startedAt;
    } catch (error) {
      const sanitized = sanitize(toError(error)) as { code: string; message: string };
      try {
        emit({ type: 'response', id: message.id, ok: false, error: sanitized });
      } catch {
        log('rpc emit failed for ' + message.id);
      }
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  };
  input.on('data', onData);
  const onEnd = (): void => {
    host.close();
    if (!shuttingDown) exit(0);
  };
  input.on('end', onEnd);
  input.on('close', onEnd);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (shuttingDown) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
    timer.unref?.();
  });
}
