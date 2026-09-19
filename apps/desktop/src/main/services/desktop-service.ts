/**
 * Desktop application service: UI-facing adapters over frozen Sentry
 * domain/services. No business logic is duplicated here — every method
 * delegates to ProjectManager / RunCoordinator / repositories / doctors.
 * All secrets stay in main; renderer receives statuses only.
 */
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { SentryDatabase, SentryRepository, RuntimeInstanceLease } from '@qa/persistence';
import { projectDataPaths } from '@qa/persistence';
import type { ProjectManager } from '@qa/project-manager';
import type { RunCoordinator } from '@qa/run-engine';
import { mergeRun, verifyMerge, ingestMergeIssues, retestIssue } from '@qa/run-engine';
import { requestRetestCancellation, cancelRetestRun } from '@qa/run-engine';
import type { AgentStackDefinition } from '@qa/schemas';
import { projectIssueState } from '@qa/schemas';
import { createQARunId, createRetestRunId, type ProjectId, type QARunId } from '@qa/shared';
import type { HarnessAdapterRegistry } from '@qa/harness-protocol';
import type { DesktopOperation, RetestSnapshot, RunSnapshot } from '../../shared/ipc-contract.js';
import type { ProviderCredentialService } from './provider-credentials.js';

export interface DesktopServiceDeps {
  readonly dataRoot: string;
  readonly database: SentryDatabase;
  readonly repository: SentryRepository;
  readonly lease: RuntimeInstanceLease;
  readonly projects: ProjectManager;
  /**
   * Production-only desktop: exactly one coordinator backed by the real
   * Muse / DeepSeek / GLM registrations. No simulation coordinator exists.
   */
  readonly coordinator: RunCoordinator;
  readonly registry: HarnessAdapterRegistry;
  readonly agentStacks: readonly AgentStackDefinition[];
  readonly credentials: ProviderCredentialService;
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
  private readonly pendingRuns = new Map<string, Promise<unknown>>();
  private readonly pendingRetests = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DesktopServiceDeps) {}

  get productionCoordinator(): RunCoordinator {
    return this.deps.coordinator;
  }

  get productionRegistry(): HarnessAdapterRegistry {
    return this.deps.registry;
  }

  get dataRoot(): string {
    return this.deps.dataRoot;
  }

  // ---- projects ----
  listProjects(): unknown[] {
    return this.deps.repository.listProjects().flatMap((project) => {
      const copy = this.deps.repository.getManagedCopy(project.id);
      if (copy?.currentRevisionId === undefined) return [];
      return [
        {
          projectId: project.id,
          name: project.name,
          state: copy.state,
          currentRevisionId: copy.currentRevisionId,
          sourcePath: project.sourcePath,
          updatedAt: project.updatedAt,
          runCount: this.deps.repository.countProjectRuns(project.id),
        },
      ];
    });
  }

  async addProject(sourcePath: string): Promise<unknown> {
    const input = z.string().min(1).max(2000).parse(sourcePath);
    return this.deps.projects.addProject(input);
  }

  getProject(projectId: string): unknown {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    const record = this.deps.projects.getProject(id);
    if (record === undefined) throw toError('PROJECT_NOT_FOUND', 'Project not found: ' + id);
    return record;
  }

  listRevisions(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    return this.deps.repository.listRevisions(id);
  }

  /** Suggest top-level target paths from the current managed working copy (autocomplete only;
   *  the frozen snapshot manifest stays authoritative at run start). */
  async suggestTargets(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    const record = this.deps.projects.getProject(id);
    if (record === undefined) throw toError('PROJECT_NOT_FOUND', 'Project not found: ' + id);
    const workingCopy = projectDataPaths(this.deps.dataRoot, record.project.id).workingCopy;
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
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    const parsedPath =
      sourcePath === undefined ? undefined : z.string().min(1).max(2000).parse(sourcePath);
    return this.deps.projects.updateProjectCopy(id, parsedPath);
  }

  async projectDoctor(projectId: string): Promise<unknown> {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    const record = this.deps.projects.getProject(id);
    if (record === undefined) throw toError('PROJECT_NOT_FOUND', 'Project not found: ' + id);
    const workingCopy = projectDataPaths(this.deps.dataRoot, record.project.id).workingCopy;
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
      revisionCount: this.deps.repository.listRevisions(id).length,
      runCount: this.deps.repository.countProjectRuns(id),
      issueCount: this.deps.repository.listIssues(id).length,
      detectedEcosystem: ecosystem,
      warnings:
        ecosystem.length === 0 ? ['No known ecosystem markers at the working-copy root.'] : [],
    };
  }

  // ---- runs (production only; historical simulation rows stay readable) ----
  listRuns(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    return this.deps.coordinator.listRuns(id).map((run) => ({
      ...run,
      agentSummary: this.deps.coordinator.getRunStatus(run.id).agents,
      findingCount: this.deps.repository.countRunFindings(run.id),
      issueCount: this.deps.repository.listOccurrencesForRun(run.id).length,
    }));
  }

  /** Single production coordinator owns every run (live + historical). */
  private coordinatorForRun(_runId: QARunId): RunCoordinator {
    return this.deps.coordinator;
  }

  runSnapshot(runId: string): RunSnapshot {
    const id = RunIdInput.parse(runId) as QARunId;
    const details = this.coordinatorForRun(id).getRunDetails(id);
    const mergeResults = this.deps.repository.listMergeResults(id).map((merge) => ({
      ...merge,
      clusters: this.deps.repository.listClusters(merge.id),
    }));
    const verificationRuns = mergeResults.flatMap((m) =>
      this.deps.repository.listVerificationRuns(m.id).map((vrun) => ({
        ...vrun,
        attempts: this.deps.repository.listVerificationAttempts(vrun.id).map((attempt) => ({
          ...attempt,
          steps: this.deps.repository.listVerificationSteps(attempt.id),
          observations: this.deps.repository.listVerificationObservations(attempt.id),
          assertions: this.deps.repository.listVerificationAssertions(attempt.id),
        })),
      })),
    );
    const issues = this.deps.repository.listOccurrencesForRun(id);
    let targetSpec: unknown;
    try {
      targetSpec = this.deps.repository.getTargetSpec(id) ?? undefined;
    } catch {
      targetSpec = undefined;
    }
    // Lineage: project + immutable revision alongside the frozen snapshot.
    const project = this.deps.repository.getProject(details.run.projectId as never) ?? undefined;
    let revision: unknown;
    try {
      const snapshot = this.deps.repository.getSnapshot(details.run.snapshotId as never);
      revision =
        snapshot === undefined
          ? undefined
          : (this.deps.repository.getRevision(snapshot.projectRevisionId as never) ?? undefined);
    } catch {
      revision = undefined;
    }
    return {
      run: details.run,
      ...(project === undefined ? {} : { project }),
      ...(revision === undefined ? {} : { revision }),
      agentRuns: details.agentRuns,
      findings: details.findings,
      evidence: details.evidence,
      activities: details.activities,
      events: details.events.map((e) => e.event),
      mergeResults,
      verificationRuns,
      issues,
      ...(targetSpec === undefined ? {} : { targetSpec }),
    };
  }

  runStatus(runId: string): unknown {
    const id = RunIdInput.parse(runId) as QARunId;
    return this.coordinatorForRun(id).getRunStatus(id);
  }

  /**
   * Start a production QA run (the only execution mode). Always persists
   * executionKind 'production'. Electron main owns the long-running promise;
   * the runId returns as soon as the QARun row exists and the canvas goes
   * live from persisted truth. Backend remains authoritative.
   */
  async startRun(projectId: string, options: unknown): Promise<DesktopOperation> {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    const parsed = StartRunOptions.parse(options);
    const operationId = 'dop_' + createQARunId().slice(4);
    const runPromise = this.deps.coordinator.run(id, {
      executionKind: 'production',
      mode: parsed.mode,
      ...(parsed.includePaths === undefined
        ? {}
        : { target: { includePaths: [...parsed.includePaths] } }),
      ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
      ...(parsed.agentStackIds === undefined
        ? {}
        : { agentStackIds: [...parsed.agentStackIds] as never }),
    });
    // Attach settlement cleanup FIRST so a fast rejection is never unhandled.
    // The chained promise rethrows for the pre-row failure path below; the trailing
    // sink guarantees a late background rejection (e.g. host teardown mid-run) can
    // never surface as an unhandled rejection — persisted run truth stays authoritative
    // and the UI reconciles it via polling/snapshots.
    const settled = runPromise.then(
      (details) => {
        this.pendingRuns.delete(operationId);
        return details;
      },
      (error: unknown) => {
        this.pendingRuns.delete(operationId);
        throw error;
      },
    );
    settled.then(undefined, () => undefined);
    this.pendingRuns.set(operationId, settled);
    const runId = await this.detectCreatedRun(id, settled);
    // If the run failed before its row appeared, surface the structured backend error
    // instead of a phantom operation without a run.
    if (runId === undefined) await settled;
    return { operationId, ...(runId === undefined ? {} : { runId }) };
  }

  private listAllRuns(projectId: ProjectId): Array<{ id: string }> {
    return this.deps.coordinator.listRuns(projectId);
  }

  private async detectCreatedRun(
    projectId: ProjectId,
    runPromise: Promise<{ run: { id: string } }>,
  ): Promise<string | undefined> {
    const before = new Set(this.listAllRuns(projectId).map((r) => r.id));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = this.listAllRuns(projectId);
      const created = current.find((r) => !before.has(r.id));
      if (created !== undefined) return created.id;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      const details = await Promise.race([
        runPromise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000)),
      ]);
      return details?.run.id;
    } catch {
      return undefined;
    }
  }

  requestRunCancellation(runId: string): unknown {
    const id = RunIdInput.parse(runId) as QARunId;
    try {
      // requestRunCancellation is cross-process safe (durable request;
      // the owning coordinator's workers drive terminalization).
      return this.coordinatorForRun(id).requestRunCancellation(id);
    } catch (error) {
      const sanitized = sanitizeError(error);
      throw toError(sanitized.code, sanitized.message);
    }
  }

  mergeRun(runId: string): unknown {
    const id = RunIdInput.parse(runId) as QARunId;
    return mergeRun(this.deps.repository, id);
  }

  async verifyMerge(mergeResultId: string): Promise<unknown> {
    const id = MergeResultIdInput.parse(mergeResultId);
    return verifyMerge(this.deps.repository, this.deps.dataRoot, id);
  }

  ingestIssues(mergeResultId: string): unknown {
    const id = MergeResultIdInput.parse(mergeResultId);
    return ingestMergeIssues(this.deps.repository, id);
  }

  exportRun(runId: string, format: 'log' | 'json'): Promise<unknown> {
    const id = RunIdInput.parse(runId) as QARunId;
    const parsed = z.enum(['log', 'json']).parse(format);
    return this.coordinatorForRun(id).exportRun(id, parsed);
  }

  // ---- issues (backend-projected currentState; renderer never derives) ----
  listIssues(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    return this.deps.repository.listIssues(id).map((issue) => ({
      ...issue,
      currentState: projectIssueState(this.deps.repository.listIssueEvents(issue.id)),
    }));
  }

  getIssue(issueId: string): unknown {
    const id = IssueIdInput.parse(issueId);
    const issue = this.deps.repository.getIssue(id);
    if (issue === undefined) throw toError('ISSUE_NOT_FOUND', 'Issue not found: ' + id);
    return {
      ...issue,
      currentState: projectIssueState(this.deps.repository.listIssueEvents(id)),
    };
  }

  issueHistory(issueId: string): unknown {
    const id = IssueIdInput.parse(issueId);
    const events = this.deps.repository.listIssueEvents(id);
    return {
      issue: this.deps.repository.getIssue(id),
      currentState: projectIssueState(events),
      occurrences: this.deps.repository.listIssueOccurrences(id),
      events,
      assessments: this.deps.repository.listRetestAssessments(id),
      retests: this.deps.repository.listRetestRuns(id),
    };
  }

  // ---- retests ----
  listRetests(issueId: string): unknown[] {
    const id = IssueIdInput.parse(issueId);
    return this.deps.repository.listRetestRuns(id);
  }

  /**
   * Async Retest start: returns the DesktopOperation as soon as the persisted
   * RetestRun row exists; the long Retest promise stays owned by main.
   * Retest v2 semantics are untouched — this only changes IPC timing.
   */
  async startRetest(
    issueId: string,
    options?: { revisionId?: string; agentStackIds?: string[] },
  ): Promise<DesktopOperation> {
    const id = IssueIdInput.parse(issueId);
    const operationId = 'dop_' + createRetestRunId().slice(7);
    const retestPromise = retestIssue(
      {
        dataRoot: this.deps.dataRoot,
        repository: this.deps.repository,
        lease: this.deps.lease,
        registry: this.deps.registry,
      },
      id,
      {
        ...(options?.revisionId === undefined
          ? {}
          : { targetRevisionId: options.revisionId as never }),
        ...(options?.agentStackIds === undefined
          ? {}
          : { agentStackIds: [...options.agentStackIds] as never }),
      },
    );
    const settled = retestPromise.then(
      (result) => {
        this.pendingRetests.delete(operationId);
        return result;
      },
      (error: unknown) => {
        this.pendingRetests.delete(operationId);
        throw error;
      },
    );
    settled.then(undefined, () => undefined);
    this.pendingRetests.set(operationId, settled);
    const retestRunId = await this.detectCreatedRetest(id, settled);
    if (retestRunId !== undefined) return { operationId, retestRunId };
    // No RetestRun row appeared: surface the structured backend error instead
    // of a phantom operation (bounded wait — never hang on settlement).
    const timeoutOutcome: { ok: false; error: unknown } = await new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false as const,
            error: toError('RETEST_NOT_CREATED', 'RetestRun was not created'),
          }),
        1000,
      ),
    );
    const outcome = await Promise.race([
      settled.then(
        (result) => ({ ok: true as const, id: result.retestRun.id }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      Promise.resolve(timeoutOutcome),
    ]);
    if (outcome.ok) return { operationId, retestRunId: outcome.id };
    throw outcome.error;
  }

  private async detectCreatedRetest(
    issueId: string,
    retestPromise: Promise<{ retestRun: { id: string } }>,
  ): Promise<string | undefined> {
    const before = new Set(this.deps.repository.listRetestRuns(issueId).map((r) => r.id));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = this.deps.repository.listRetestRuns(issueId);
      const created = current.find((r) => !before.has(r.id));
      if (created !== undefined) return created.id;
      let finished = false;
      void retestPromise.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      if (finished) {
        const after = this.deps.repository.listRetestRuns(issueId);
        const late = after.find((r) => !before.has(r.id));
        if (late !== undefined) return late.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      const details = await Promise.race([
        retestPromise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
      ]);
      return details?.retestRun.id;
    } catch {
      return undefined;
    }
  }

  retestSnapshot(retestRunId: string): RetestSnapshot {
    const id = RetestRunIdInput.parse(retestRunId);
    const retestRun = this.deps.repository.getRetestRun(id);
    if (retestRun === undefined) throw toError('RETEST_NOT_FOUND', 'Retest not found: ' + id);
    const assessments = this.deps.repository.listRetestAssessmentsForRun(id);
    // RetestSpec + Snapshot B + targetQaRunId survive cancellation (§169).
    let spec: unknown;
    try {
      spec = this.deps.repository.getRetestSpec(id) ?? undefined;
    } catch {
      spec = undefined;
    }
    // Typed DTO: targetRun is a nested DesktopRunSnapshot ({ run, agentRuns,
    // ... }), never a flattened run. Renderer reads targetRun.run.id.
    let targetRun: RunSnapshot | undefined;
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
      dataRoot: this.deps.dataRoot,
      repository: this.deps.repository,
      lease: this.deps.lease,
      registry: this.deps.registry,
    };
    try {
      requestRetestCancellation(deps, id);
      return cancelRetestRun(deps, id);
    } catch (error) {
      const sanitized = sanitizeError(error);
      throw toError(sanitized.code, sanitized.message);
    }
  }

  // ---- doctors / system ----
  async environmentDoctors(): Promise<unknown> {
    // Honest doctor statuses from the real harness/verifier probes (§112-114).
    // Renderer receives statuses only — never credential values (§116).
    const [muse, deepseek, glm] = await Promise.all([
      import('@qa/harness-muse').then((m) => m.doctorMuse()).catch(() => undefined),
      import('@qa/harness-deepseek').then((m) => m.doctorDeepSeek()).catch(() => undefined),
      import('@qa/harness-claude-code').then((m) => m.doctorGlm()).catch(() => undefined),
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
      const probeParent = verifierStagingParent(this.deps.dataRoot);
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
    return {
      agentStacks: this.deps.agentStacks.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        modelId: s.model.modelId,
        provider: s.model.provider,
        ...(s.id === 'stack_muse_main'
          ? stackStatus(s.id, muse as never)
          : s.id === 'stack_deepseek_main'
            ? stackStatus(s.id, deepseek as never)
            : stackStatus(s.id, glm as never)),
      })),
      verifier,
      dataRoot: this.deps.dataRoot,
    };
  }

  // ---- provider credentials (statuses only to renderer; never values) ----
  providerStatuses(): unknown {
    return this.deps.credentials.statuses();
  }

  /** Secure default: encrypt + persist + load into runtime + refresh env. */
  async providerSaveKey(name: string, value: string): Promise<unknown> {
    const parsed = z
      .object({ name: z.string().min(1).max(200), value: z.string().min(1).max(5000) })
      .strict()
      .parse({ name, value });
    return this.deps.credentials.saveKey(parsed.name, parsed.value);
  }

  /** Explicit session-only variant (no persistence). */
  providerSetSessionKey(name: string, value: string): unknown {
    const parsed = z
      .object({ name: z.string().min(1).max(200), value: z.string().min(1).max(5000) })
      .strict()
      .parse({ name, value });
    return this.deps.credentials.setSessionKey(parsed.name, parsed.value);
  }

  /** Back-compat session set (older renderer). */
  providerSetKey(name: string, value: string): unknown {
    return this.providerSetSessionKey(name, value);
  }

  async providerClearKey(name: string): Promise<unknown> {
    const parsed = z.string().min(1).max(200).parse(name);
    return this.deps.credentials.clearKey(parsed);
  }

  /** @deprecated Secure Save persists automatically; kept for older IPC callers. */
  providerPersist(): Promise<unknown> {
    return this.deps.credentials.persist();
  }

  /** @deprecated Use forgetAll; kept for older IPC call sites. */
  providerForgetFile(): Promise<unknown> {
    return this.deps.credentials.forgetFile().then(() => ({ forgotten: true }));
  }

  async providerForgetAll(): Promise<unknown> {
    return this.deps.credentials.forgetAll();
  }

  productionReadiness(input?: { agentStackIds?: string[] }): unknown {
    const statuses = this.deps.credentials.statuses();
    const isConfigured = (name: string): boolean =>
      statuses.find((s) => s.name === name)?.configured === true;
    const requested = input?.agentStackIds;
    const wants = (stack: string): boolean => requested === undefined || requested.includes(stack);
    const reasons: string[] = [];
    if (wants('stack_deepseek_main')) {
      if (!isConfigured('DEEPSEEK_API_KEY')) reasons.push('DeepSeek credential missing');
      if (!isConfigured('SENTRY_DEEPSEEK_MODEL')) reasons.push('DeepSeek model not set');
    }
    if (wants('stack_glm_main')) {
      if (!isConfigured('ANTHROPIC_AUTH_TOKEN')) reasons.push('GLM credential missing');
      if (!isConfigured('SENTRY_GLM_MODEL')) reasons.push('GLM model not set');
    }
    if (wants('stack_muse_main') && !isConfigured('SENTRY_MUSE_MODEL')) {
      reasons.push('Muse model not set');
    }
    return {
      ready: reasons.length === 0,
      reasons,
      productionWired: true,
      note: 'Muse authenticates via local muse login; verify in Environment.',
    };
  }

  /**
   * Pre-run gate: every requested stack must be provider-ready, otherwise
   * refuse to start a partial run silently. Returns the per-stack breakdown
   * so the UI can show exactly which provider blocks the run.
   */
  preRunGate(agentStackIds?: string[]): {
    readonly ready: boolean;
    readonly stacks: ReadonlyArray<{
      readonly id: string;
      readonly ready: boolean;
      readonly reasons: readonly string[];
    }>;
  } {
    const stacks = this.deps.agentStacks
      .map((s) => s.id)
      .filter((id) => agentStackIds === undefined || agentStackIds.includes(id));
    const per = stacks.map((id) => {
      const check = this.productionReadiness({ agentStackIds: [id] }) as {
        ready: boolean;
        reasons: string[];
      };
      return { id, ready: check.ready, reasons: check.reasons };
    });
    return { ready: per.every((s) => s.ready), stacks: per };
  }

  systemInfo(): { dataRoot: string; versions: Record<string, string> } {
    return {
      dataRoot: this.deps.dataRoot,
      versions: { desktop: '0.1.0', merger: '2', verifier: '3', retest: '2' },
    };
  }

  activeRuns(): Array<{ runId: string; projectId: string; status: string }> {
    return this.deps.repository.listNonterminalRuns().map((r) => ({
      runId: r.id,
      projectId: r.projectId,
      status: r.status,
    }));
  }
}
