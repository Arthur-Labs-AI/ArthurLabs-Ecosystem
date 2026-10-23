/**
 * Desktop application service: typed RPC adapter over the host runtime.
 *
 * Production-only desktop: Electron main owns NO Sentry domain state — no
 * database, no RunCoordinator, no provider adapters. Every QA operation is
 * a typed `RuntimeClient.request()` over the shared stdio transport to the long-lived Linux runtime.
 * Host keeps: safeStorage credentials, runtime lifecycle, path preparation,
 * live-update fan-out. Secrets stay in main; renderer receives statuses.
 */
import { z } from 'zod';
import { RUN_TIMEOUT_MS_MAX, RUN_TIMEOUT_MS_MIN } from '@qa/shared';
import type { AgentStackDefinition } from '@qa/schemas';
import type { DesktopOperation, RetestSnapshot, RunSnapshot } from '../../shared/ipc-contract.js';
import { toSafeError } from '../desktop-command-router.js';
import type { ProviderCredentialService } from './provider-credentials.js';
import type { RuntimeClient } from '../runtime/runtime-client.js';
import type { HostPlatform } from '../platform/host-platform.js';

export interface DesktopServiceDeps {
  readonly runtime: RuntimeClient;
  readonly host: HostPlatform;
  readonly agentStacks: readonly AgentStackDefinition[];
  readonly credentials: ProviderCredentialService;
  readonly legacyDataRoot?: string;
}

const ProjectIdInput = z.string().min(1).max(200);
const RunIdInput = z.string().regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
const IssueIdInput = z.string().regex(/^issue_[0-9A-HJKMNP-TV-Z]{26}$/);
const RetestRunIdInput = z.string().regex(/^retest_[0-9A-HJKMNP-TV-Z]{26}$/);
const StartRunOptions = z
  .object({
    mode: z.enum(['full', 'targeted']),
    includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
    instructions: z.string().min(1).max(5000).optional(),
    agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
    runTimeoutMs: z.number().int().min(RUN_TIMEOUT_MS_MIN).max(RUN_TIMEOUT_MS_MAX).optional(),
  })
  .strict();

function sanitizeError(
  error: unknown,
  redactSecrets?: (text: string) => string,
): { code: string; message: string } {
  return toSafeError(error, redactSecrets === undefined ? {} : { redactSecrets });
}

function toError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class DesktopApplicationService {
  constructor(private readonly deps: DesktopServiceDeps) {}

  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const redact = (text: string): string => this.redactSecretsFromText(text);
    const toMappedError = (error: unknown): Error => {
      const sanitized = sanitizeError(error, redact);
      return toError(sanitized.code, sanitized.message);
    };
    try {
      const pending = this.deps.runtime.request(method, params);
      // Async rejections sanitize through the same boundary as sync throws;
      // success values pass through untouched, failures map identically.
      return pending.catch((error: unknown) => {
        throw toMappedError(error);
      });
    } catch (error) {
      throw toMappedError(error);
    }
  }

  /**
   * Boundary scrubber for error surfaces (IPC/CLI/log warnings): removes
   * exact known secret-lane values; see ProviderCredentialService.
   */
  redactSecretsFromText(text: string): string {
    // Intentionally no catch here: a failing scrubber must propagate to
    // the shared fail-closed mapping (toSafeError), never silently keep
    // the original text.
    return this.deps.credentials.redactSecretsFromText(text);
  }

  get dataRoot(): string {
    return this.deps.legacyDataRoot ?? 'wsl-runtime';
  }

  get productionCoordinator(): unknown {
    return undefined;
  }

  get productionRegistry(): unknown {
    return undefined;
  }

  runtimeStatus(): unknown {
    return this.deps.runtime.status;
  }

  // ---- projects (Windows paths translated via wslpath before RPC) ----
  listProjects(): Promise<unknown[]> {
    return this.call('projects.list') as Promise<unknown[]>;
  }

  async addProject(sourcePath: string): Promise<unknown> {
    const input = z.string().min(1).max(2000).parse(sourcePath);
    const translated = await this.translateSourcePath(input);
    return this.call('projects.add', { sourcePath: translated });
  }

  getProject(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('projects.get', { projectId: id });
  }

  listRevisions(projectId: string): Promise<unknown[]> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('projects.revisions', { projectId: id }) as Promise<unknown[]>;
  }

  suggestTargets(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('projects.suggestTargets', { projectId: id });
  }

  async updateProject(projectId: string, sourcePath?: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    if (sourcePath === undefined) return this.call('projects.update', { projectId: id });
    const parsed = z.string().min(1).max(2000).parse(sourcePath);
    const translated = await this.translateSourcePath(parsed);
    return this.call('projects.update', { projectId: id, sourcePath: translated });
  }

  deleteProject(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('projects.delete', { projectId: id });
  }

  projectDoctor(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('projects.doctor', { projectId: id });
  }

  private async translateSourcePath(input: string): Promise<string> {
    return this.deps.host.prepareSourcePath(input);
  }

  // ---- runs (all inside the Linux execution runtime) ----
  listRuns(projectId: string): Promise<unknown[]> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('runs.list', { projectId: id }) as Promise<unknown[]>;
  }

  runSnapshot(runId: string): Promise<RunSnapshot> {
    const id = RunIdInput.parse(runId);
    return this.call('runs.get', { runId: id }) as Promise<RunSnapshot>;
  }

  runStatus(runId: string): Promise<unknown> {
    const id = RunIdInput.parse(runId);
    return this.call('runs.status', { runId: id });
  }

  async startRun(projectId: string, options: unknown): Promise<DesktopOperation> {
    const id = ProjectIdInput.parse(projectId);
    const parsed = StartRunOptions.parse(options);
    try {
      return (await this.call('runs.start', {
        projectId: id,
        mode: parsed.mode,
        ...(parsed.includePaths === undefined ? {} : { includePaths: [...parsed.includePaths] }),
        ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
        ...(parsed.agentStackIds === undefined ? {} : { agentStackIds: [...parsed.agentStackIds] }),
        ...(parsed.runTimeoutMs === undefined ? {} : { runTimeoutMs: parsed.runTimeoutMs }),
      })) as DesktopOperation;
    } catch (error) {
      // A client-side timeout does NOT mean the runtime didn't start the run:
      // reconcile before reporting, so the UI never hides a paid run that is
      // actually executing (and the user never double-starts blindly).
      if (error instanceof Error && (error as { code?: unknown }).code === 'RUNTIME_TIMEOUT') {
        const reconciled = await this.recentRunForProject(id).catch(() => undefined);
        if (reconciled !== undefined) {
          throw toError(
            'RUN_MAY_HAVE_STARTED',
            'Runtime request timed out, but a run (' +
              reconciled +
              ') appeared for this project — open Runs before retrying.',
          );
        }
      }
      throw error;
    }
  }

  /** Most recent nonterminal run row for a project, if any (timeout reconciliation). */
  private async recentRunForProject(projectId: string): Promise<string | undefined> {
    const runs = (await this.call('runs.list', { projectId: projectId as string })) as Array<{
      id: string;
      status: string;
      createdAt: string;
    }>;
    const active = runs
      .filter((r) => !['completed', 'partial', 'failed', 'cancelled'].includes(r.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return active[0]?.id;
  }

  requestRunCancellation(runId: string): Promise<unknown> {
    const id = RunIdInput.parse(runId);
    return this.call('runs.cancel', { runId: id });
  }

  /** Canonical export bytes for Save As. Renderer controls runId + format
   *  only; the destination always originates from the native dialog. */
  exportContent(
    runId: string,
    format: 'log' | 'json',
  ): Promise<{
    filename: string;
    mimeType: string;
    format: string;
    sizeBytes: number;
    contentBase64: string;
  }> {
    const id = RunIdInput.parse(runId);
    const parsed = z.enum(['log', 'json']).parse(format);
    return this.call('runs.exportContent', { runId: id, format: parsed }) as Promise<{
      filename: string;
      mimeType: string;
      format: string;
      sizeBytes: number;
      contentBase64: string;
    }>;
  }

  exportRun(runId: string, format: 'log' | 'json'): Promise<unknown> {
    const id = RunIdInput.parse(runId);
    const parsed = z.enum(['log', 'json']).parse(format);
    return this.call('runs.export', { runId: id, format: parsed });
  }

  // ---- issues ----
  listIssues(projectId: string): Promise<unknown[]> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('issues.list', { projectId: id }) as Promise<unknown[]>;
  }

  getIssue(issueId: string): Promise<unknown> {
    const id = IssueIdInput.parse(issueId);
    return this.call('issues.get', { issueId: id });
  }

  issueHistory(issueId: string): Promise<unknown> {
    const id = IssueIdInput.parse(issueId);
    return this.call('issues.history', { issueId: id });
  }

  // ---- retests ----
  listRetests(issueId: string): Promise<unknown[]> {
    const id = IssueIdInput.parse(issueId);
    return this.call('retests.list', { issueId: id }) as Promise<unknown[]>;
  }

  startRetest(
    issueId: string,
    options?: { revisionId?: string; agentStackIds?: string[] },
  ): Promise<DesktopOperation> {
    const id = IssueIdInput.parse(issueId);
    return this.call('retests.start', {
      issueId: id,
      ...(options?.revisionId === undefined ? {} : { revisionId: options.revisionId }),
      ...(options?.agentStackIds === undefined
        ? {}
        : { agentStackIds: [...options.agentStackIds] }),
    }) as Promise<DesktopOperation>;
  }

  retestSnapshot(retestRunId: string): Promise<RetestSnapshot> {
    const id = RetestRunIdInput.parse(retestRunId);
    return this.call('retests.get', { retestRunId: id }) as Promise<RetestSnapshot>;
  }

  cancelRetest(retestRunId: string): Promise<unknown> {
    const id = RetestRunIdInput.parse(retestRunId);
    return this.call('retests.cancel', { retestRunId: id });
  }

  // ---- doctors / system ----
  environmentDoctors(): Promise<unknown> {
    return this.call('runtime.environment', {});
  }

  runtimeEnvironment(): Promise<unknown> {
    return this.call('runtime.environment', {});
  }

  // ---- provider credentials (statuses only to renderer; never values) ----
  providerStatuses(): unknown {
    return this.deps.credentials.statuses();
  }

  async providerSaveKey(name: string, value: string): Promise<unknown> {
    const parsed = z
      .object({ name: z.string().min(1).max(200), value: z.string().min(1).max(5000) })
      .strict()
      .parse({ name, value });
    const status = await this.deps.credentials.saveKey(parsed.name, parsed.value);
    await this.pushRuntimeConfiguration().catch(() => undefined);
    return status;
  }

  async providerClearKey(name: string): Promise<unknown> {
    const parsed = z.string().min(1).max(200).parse(name);
    const status = await this.deps.credentials.clearKey(parsed);
    await this.pushRuntimeConfiguration().catch(() => undefined);
    return status;
  }

  providerPersist(): Promise<unknown> {
    return this.deps.credentials.persist();
  }

  providerForgetFile(): Promise<unknown> {
    return this.deps.credentials.forgetFile().then(() => ({ forgotten: true }));
  }

  async providerForgetAll(): Promise<unknown> {
    const result = await this.deps.credentials.forgetAll();
    await this.pushRuntimeConfiguration().catch(() => undefined);
    return result;
  }

  detectHarnessBinaries(): Promise<unknown> {
    return Promise.resolve({
      deepseek: { detected: null, configured: null, effective: 'linux-runtime' },
      note: 'Provider executables resolve inside the Linux execution runtime; host paths do not apply.',
    });
  }

  /** Push models + secrets + binary overrides (memory-only) to the runtime. */
  async pushRuntimeConfiguration(): Promise<unknown> {
    const get = (name: string): string | undefined => this.deps.credentials.getValue(name);
    const models: Record<string, string> = {};
    const opencode = get('SENTRY_OPENCODE_MODEL');
    const deepseek = get('SENTRY_DEEPSEEK_MODEL');
    const glm = get('SENTRY_GLM_MODEL');
    if (opencode !== undefined) models['opencode'] = opencode;
    if (deepseek !== undefined) models['deepseek'] = deepseek;
    if (glm !== undefined) models['glm'] = glm;
    const providers: Record<string, string> = {};
    const openRouterKey = get('OPENROUTER_API_KEY');
    const openCodeKey = get('OPENCODE_API_KEY');
    const deepseekKey = get('DEEPSEEK_API_KEY');
    const glmToken = get('ANTHROPIC_AUTH_TOKEN');
    const glmEndpoint = get('ANTHROPIC_BASE_URL');
    if (openRouterKey !== undefined) providers['openRouterApiKey'] = openRouterKey;
    if (openCodeKey !== undefined) providers['openCodeApiKey'] = openCodeKey;
    if (deepseekKey !== undefined) providers['deepseekApiKey'] = deepseekKey;
    if (glmToken !== undefined) providers['anthropicAuthToken'] = glmToken;
    if (glmEndpoint !== undefined) providers['anthropicBaseUrl'] = glmEndpoint;
    const binaries: Record<string, string> = {};
    const opencodeBinary = get('SENTRY_OPENCODE_BINARY');
    const deepseekBinary = get('SENTRY_DEEPSEEK_BINARY');
    const glmBinary = get('SENTRY_GLM_BINARY');
    if (opencodeBinary !== undefined) binaries['opencode'] = opencodeBinary;
    if (deepseekBinary !== undefined) binaries['deepseek'] = deepseekBinary;
    if (glmBinary !== undefined) binaries['glm'] = glmBinary;
    const openCodeProvider = get('SENTRY_OPENCODE_PROVIDER')?.trim().toLowerCase();
    const provider =
      openCodeProvider === 'openrouter' ||
      openCodeProvider === 'opencode' ||
      openCodeProvider === 'opencode-go'
        ? { openCodeProvider }
        : {};
    return this.call('runtime.configure', { models, providers, binaries, ...provider });
  }

  productionReadiness(input?: { agentStackIds?: string[] }): Promise<unknown> {
    return this.call('production.readiness', {
      ...(input?.agentStackIds === undefined ? {} : { agentStackIds: [...input.agentStackIds] }),
    });
  }

  preRunGate(agentStackIds?: string[]): Promise<{
    readonly ready: boolean;
    readonly warnings: readonly string[];
    readonly stacks: ReadonlyArray<{
      readonly id: string;
      readonly ready: boolean;
      readonly reasons: readonly string[];
      readonly warnings: readonly string[];
    }>;
  }> {
    return this.call('production.preRunGate', {
      ...(agentStackIds === undefined ? {} : { agentStackIds: [...agentStackIds] }),
    }) as Promise<{
      readonly ready: boolean;
      readonly warnings: readonly string[];
      readonly stacks: ReadonlyArray<{
        readonly id: string;
        readonly ready: boolean;
        readonly reasons: readonly string[];
        readonly warnings: readonly string[];
      }>;
    }>;
  }

  systemInfo(): Promise<{ dataRoot: string; versions: Record<string, string> }> {
    return this.call('system.info', {}) as Promise<{
      dataRoot: string;
      versions: Record<string, string>;
    }>;
  }

  activeRuns(): Promise<Array<{ runId: string; projectId: string; status: string }>> {
    return this.call('system.activeRuns', {}) as Promise<
      Array<{ runId: string; projectId: string; status: string }>
    >;
  }

  /**
   * Runtime target choices live behind the host platform: WSL distro data
   * on Windows, normalized native host info on Linux (no distro to pick).
   */
  async runtimeDistros(): Promise<unknown> {
    return this.deps.host.runtimeDistros();
  }

  async runtimeSelectDistro(distro: string): Promise<unknown> {
    const parsed = z.string().min(1).max(200).parse(distro);
    return this.deps.host.runtimeSelectDistro(parsed);
  }
}
