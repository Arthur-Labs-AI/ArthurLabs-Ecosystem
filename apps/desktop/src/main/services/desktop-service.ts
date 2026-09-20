/**
 * Desktop application service: typed RPC adapter over the WSL runtime.
 *
 * Production-only desktop: Electron main owns NO Sentry domain state — no
 * database, no RunCoordinator, no provider adapters. Every QA operation is
 * a typed `WslRuntimeClient.request()` to the long-lived Linux runtime.
 * Windows keeps: safeStorage credentials, WSL lifecycle, path translation,
 * live-update fan-out. Secrets stay in main; renderer receives statuses.
 */
import { z } from 'zod';
import type { AgentStackDefinition } from '@qa/schemas';
import type { DesktopOperation, RetestSnapshot, RunSnapshot } from '../../shared/ipc-contract.js';
import type { ProviderCredentialService } from './provider-credentials.js';
import type { WslRuntimeClient } from './wsl-runtime-client.js';
import { translateWindowsPathForWsl, WslRuntimeManager } from './wsl-runtime-client.js';

export interface DesktopServiceDeps {
  readonly runtime: WslRuntimeClient;
  readonly distro: string;
  readonly agentStacks: readonly AgentStackDefinition[];
  readonly credentials: ProviderCredentialService;
  readonly legacyDataRoot?: string;
  /** Electron userData dir: persists the WSL distro preference. */
  readonly userDataDir?: string;
}

const ProjectIdInput = z.string().min(1).max(200);
const RunIdInput = z.string().regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
const IssueIdInput = z.string().regex(/^issue_[0-9A-HJKMNP-TV-Z]{26}$/);
const RetestRunIdInput = z.string().regex(/^retest_[0-9A-HJKMNP-TV-Z]{26}$/);
const MergeResultIdInput = z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/);
const StartRunOptions = z
  .object({
    mode: z.enum(['full', 'targeted']),
    includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
    instructions: z.string().min(1).max(5000).optional(),
    agentStackIds: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
  })
  .strict();

function sanitizeError(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const typed = error as { code?: unknown; message?: unknown };
    return {
      code: typeof typed.code === 'string' ? typed.code.slice(0, 100) : 'DESKTOP_ERROR',
      message:
        typeof typed.message === 'string'
          ? typed.message.slice(0, 1000)
          : 'Desktop operation failed',
    };
  }
  return {
    code: 'DESKTOP_ERROR',
    message: error instanceof Error ? error.message.slice(0, 1000) : 'Desktop operation failed',
  };
}

function toError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export class DesktopApplicationService {
  constructor(private readonly deps: DesktopServiceDeps) {}

  private call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    try {
      return this.deps.runtime.request(method, params);
    } catch (error) {
      const sanitized = sanitizeError(error);
      throw toError(sanitized.code, sanitized.message);
    }
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

  projectDoctor(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId);
    return this.call('projects.doctor', { projectId: id });
  }

  private async translateSourcePath(input: string): Promise<string> {
    if (/^[A-Za-z]:[\\/]/.test(input)) {
      return translateWindowsPathForWsl(input, this.deps.distro);
    }
    return input;
  }

  // ---- runs (all inside the WSL runtime) ----
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

  mergeRun(runId: string): Promise<unknown> {
    const id = RunIdInput.parse(runId);
    return this.call('runs.merge', { runId: id });
  }

  verifyMerge(mergeResultId: string): Promise<unknown> {
    const id = MergeResultIdInput.parse(mergeResultId);
    return this.call('runs.verify', { mergeResultId: id });
  }

  ingestIssues(mergeResultId: string): Promise<unknown> {
    const id = MergeResultIdInput.parse(mergeResultId);
    return this.call('runs.ingest', { mergeResultId: id });
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

  async providerSetSessionKey(name: string, value: string): Promise<unknown> {
    const parsed = z
      .object({ name: z.string().min(1).max(200), value: z.string().min(1).max(5000) })
      .strict()
      .parse({ name, value });
    const status = this.deps.credentials.setSessionKey(parsed.name, parsed.value);
    await this.pushRuntimeConfiguration().catch(() => undefined);
    return status;
  }

  providerSetKey(name: string, value: string): Promise<unknown> {
    return this.providerSetSessionKey(name, value);
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
      note: 'Provider executables resolve inside the WSL runtime; Windows paths do not apply.',
    });
  }

  /** Push models + secrets (memory-only) to the runtime after handshake/changes. */
  async pushRuntimeConfiguration(): Promise<unknown> {
    const get = (name: string): string | undefined => this.deps.credentials.getValue(name);
    const models: Record<string, string> = {};
    const muse = get('SENTRY_MUSE_MODEL');
    const deepseek = get('SENTRY_DEEPSEEK_MODEL');
    const glm = get('SENTRY_GLM_MODEL');
    if (muse !== undefined) models['muse'] = muse;
    if (deepseek !== undefined) models['deepseek'] = deepseek;
    if (glm !== undefined) models['glm'] = glm;
    const providers: Record<string, string> = {};
    const deepseekKey = get('DEEPSEEK_API_KEY');
    const glmToken = get('ANTHROPIC_AUTH_TOKEN');
    if (deepseekKey !== undefined) providers['deepseekApiKey'] = deepseekKey;
    if (glmToken !== undefined) providers['anthropicAuthToken'] = glmToken;
    return this.call('runtime.configure', { models, providers });
  }

  productionReadiness(input?: { agentStackIds?: string[] }): Promise<unknown> {
    return this.call('production.readiness', {
      ...(input?.agentStackIds === undefined ? {} : { agentStackIds: [...input.agentStackIds] }),
    });
  }

  preRunGate(agentStackIds?: string[]): Promise<{
    readonly ready: boolean;
    readonly stacks: ReadonlyArray<{
      readonly id: string;
      readonly ready: boolean;
      readonly reasons: readonly string[];
    }>;
  }> {
    return this.call('production.preRunGate', {
      ...(agentStackIds === undefined ? {} : { agentStackIds: [...agentStackIds] }),
    }) as Promise<{
      readonly ready: boolean;
      readonly stacks: ReadonlyArray<{
        readonly id: string;
        readonly ready: boolean;
        readonly reasons: readonly string[];
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

  private wslManager(): WslRuntimeManager {
    return new WslRuntimeManager(
      this.deps.userDataDir === undefined ? {} : { userDataDir: this.deps.userDataDir },
    );
  }

  async runtimeDistros(): Promise<unknown> {
    const manager = this.wslManager();
    let distros: Array<{ name: string; state: string; version: number }> = [];
    let listError: string | undefined;
    try {
      distros = await manager.listDistros();
    } catch (error) {
      // Never a silent empty list: the UI must distinguish "none installed"
      // from "wsl.exe failed", otherwise users chase the wrong fix.
      listError =
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    }
    const preferred = await manager.loadPreferredDistro().catch(() => undefined);
    return {
      distros,
      preferred: preferred ?? null,
      selected: this.deps.distro,
      ...(listError === undefined ? {} : { listError }),
    };
  }

  async runtimeSelectDistro(distro: string): Promise<unknown> {
    const parsed = z.string().min(1).max(200).parse(distro);
    const manager = this.wslManager();
    const usable = (await manager.listDistros()).filter((d) => d.version === 2);
    if (!usable.some((d) => d.name === parsed)) {
      throw toError('WSL_NO_DISTRO', 'Not a usable WSL2 distribution: ' + parsed);
    }
    await manager.savePreferredDistro(parsed);
    return { saved: parsed, restartRequired: true };
  }
}
