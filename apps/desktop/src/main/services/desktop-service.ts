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
const SimulationOptions = z
  .object({
    mode: z.enum(['full', 'targeted']),
    includePaths: z.array(z.string().min(1).max(500)).max(100).optional(),
    scenario: z
      .enum(['success', 'partial', 'all-fail', 'transport-loss', 'timeout', 'protocol-error'])
      .optional(),
    instructions: z.string().min(1).max(5000).optional(),
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

  constructor(private readonly deps: DesktopServiceDeps) {}

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

  // ---- runs ----
  listRuns(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    return this.deps.coordinator.listRuns(id).map((run) => ({
      ...run,
      agentSummary: this.deps.coordinator.getRunStatus(run.id).agents,
      findingCount: this.deps.repository.countRunFindings(run.id),
      issueCount: this.deps.repository.listOccurrencesForRun(run.id).length,
    }));
  }

  runSnapshot(runId: string): RunSnapshot {
    const id = RunIdInput.parse(runId) as QARunId;
    const details = this.deps.coordinator.getRunDetails(id);
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
    return {
      run: details.run,
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
    return this.deps.coordinator.getRunStatus(id);
  }

  async startSimulation(projectId: string, options: unknown): Promise<DesktopOperation> {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    const parsed = SimulationOptions.parse(options);
    const operationId = 'dop_' + createQARunId().slice(4);
    const runPromise = this.deps.coordinator.run(id, {
      executionKind: 'simulation',
      mode: parsed.mode,
      ...(parsed.includePaths === undefined
        ? {}
        : { target: { includePaths: [...parsed.includePaths] } }),
      ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
    });
    this.pendingRuns.set(operationId, runPromise);
    const runId = await this.detectCreatedRun(id, runPromise);
    void runPromise.then(
      () => this.pendingRuns.delete(operationId),
      () => this.pendingRuns.delete(operationId),
    );
    return { operationId, ...(runId === undefined ? {} : { runId }) };
  }

  private async detectCreatedRun(
    projectId: ProjectId,
    runPromise: Promise<{ run: { id: string } }>,
  ): Promise<string | undefined> {
    const before = new Set(this.deps.coordinator.listRuns(projectId).map((r) => r.id));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = this.deps.coordinator.listRuns(projectId);
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
      return this.deps.coordinator.requestRunCancellation(id);
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
    return this.deps.coordinator.exportRun(id, parsed);
  }

  // ---- issues ----
  listIssues(projectId: string): unknown[] {
    const id = ProjectIdInput.parse(projectId) as ProjectId;
    return this.deps.repository.listIssues(id);
  }

  getIssue(issueId: string): unknown {
    const id = IssueIdInput.parse(issueId);
    const issue = this.deps.repository.getIssue(id);
    if (issue === undefined) throw toError('ISSUE_NOT_FOUND', 'Issue not found: ' + id);
    return issue;
  }

  issueHistory(issueId: string): unknown {
    const id = IssueIdInput.parse(issueId);
    return {
      issue: this.deps.repository.getIssue(id),
      occurrences: this.deps.repository.listIssueOccurrences(id),
      events: this.deps.repository.listIssueEvents(id),
      assessments: this.deps.repository.listRetestAssessments(id),
      retests: this.deps.repository.listRetestRuns(id),
    };
  }

  // ---- retests ----
  listRetests(issueId: string): unknown[] {
    const id = IssueIdInput.parse(issueId);
    return this.deps.repository.listRetestRuns(id);
  }

  async startRetest(issueId: string, options?: { revisionId?: string }): Promise<DesktopOperation> {
    const id = IssueIdInput.parse(issueId);
    const operationId = 'dop_' + createRetestRunId().slice(7);
    const result = await retestIssue(
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
      },
    );
    return { operationId, retestRunId: result.retestRun.id };
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
    let targetRun: unknown;
    try {
      if (retestRun.targetQaRunId !== undefined) {
        const details = this.deps.coordinator.getRunDetails(retestRun.targetQaRunId as QARunId);
        const targetMerges = this.deps.repository
          .listMergeResults(retestRun.targetQaRunId as QARunId)
          .map((merge) => ({
            ...merge,
            clusters: this.deps.repository.listClusters(merge.id),
          }));
        const targetVerifications = targetMerges.flatMap((m) =>
          this.deps.repository.listVerificationRuns(m.id).map((vrun) => ({
            ...vrun,
            attempts: this.deps.repository.listVerificationAttempts(vrun.id),
          })),
        );
        targetRun = {
          ...details,
          mergeResults: targetMerges,
          verificationRuns: targetVerifications,
        };
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
      simulation: { ready: true, label: 'Simulation mode — no provider tokens used' },
      dataRoot: this.deps.dataRoot,
    };
  }

  // ---- provider credentials (statuses only to renderer) ----
  providerStatuses(): unknown {
    return this.deps.credentials.statuses();
  }

  providerSetKey(name: string, value: string): unknown {
    const parsed = z
      .object({ name: z.string().min(1).max(200), value: z.string().min(1).max(5000) })
      .strict()
      .parse({ name, value });
    return this.deps.credentials.setKey(parsed.name, parsed.value);
  }

  providerClearKey(name: string): unknown {
    const parsed = z.string().min(1).max(200).parse(name);
    return this.deps.credentials.clearKey(parsed);
  }

  providerPersist(): Promise<unknown> {
    return this.deps.credentials.persist();
  }

  providerForgetFile(): Promise<unknown> {
    return this.deps.credentials.forgetFile().then(() => ({ forgotten: true }));
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
