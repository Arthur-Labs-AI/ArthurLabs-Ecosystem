import {
  createAgentRunId,
  createQARunId,
  nowIsoTimestamp,
  type AgentRunId,
  type AgentStackId,
  type ProjectId,
  type ProjectRevisionId,
  type QARunId,
} from '@qa/shared';
import {
  AgentRunSchema,
  HarnessRunRequestSchema,
  QARunSchema,
  RunActivitySchema,
  TargetSpecSchema,
  type AgentRun,
  type Evidence,
  type Finding,
  type HarnessEvent,
  type HarnessRunRequest,
  type HarnessWorkspace,
  type QARun,
  type QARunLineage,
  type TargetSpec,
  type VerificationLevel,
} from '@qa/schemas';
import {
  aggregateAgentUsage,
  aggregateAgentRunOutcome,
  assertAgentRunTransition,
} from '@qa/domain';
import {
  HarnessAdapterRegistry,
  HarnessProtocolError,
  IncrementalHarnessEventValidator,
  type HarnessAdapter,
  type HarnessAdapterRegistration,
} from '@qa/harness-protocol';
import {
  projectDataPaths,
  RuntimeInstanceLease,
  RuntimePersistenceError,
  SENTRY_PRODUCTION_RUN_TIMEOUT_MS,
  SENTRY_SIMULATION_RUN_TIMEOUT_MS,
  type SentryRepository,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { SnapshotEngine } from '@qa/snapshot-engine';
import { WorkspaceFactory } from '@qa/workspace-factory';
import { RunActivityProjector } from './activity-projector.js';
import { RunExporter } from './exporters.js';
import { RunEngineError } from './errors.js';
import { recoverRetests } from './retest-service.js';
import { recoverVerifications } from './verification-service.js';

export interface TargetedScope {
  /** Project-relative target paths (§9-§10). Validated against the frozen
   *  snapshot manifest before agents start; rejected when unknown. */
  readonly includePaths: readonly string[];
  readonly issueIds?: readonly string[];
  readonly userInstructions?: string;
}

export interface RunOptions {
  readonly agentStackIds?: readonly AgentStackId[];
  readonly executionKind: 'simulation' | 'production';
  readonly verificationLevel?: VerificationLevel;
  readonly instructions?: string;
  readonly runTimeoutMs?: number;
  /** Phase 7 (§8-§13): TARGETED QA. Same independent agent architecture
   *  and FULL-strength responsibility class, focused on a narrower scope.
   *  Omitted (or mode 'full') preserves FULL semantics unchanged (§7). */
  readonly mode?: 'full' | 'targeted';
  readonly target?: TargetedScope;
  /** Phase 7 run lineage (§37): e.g. FULL → TARGETED follow-up. */
  readonly lineage?: {
    readonly parentRunId?: QARunId;
    readonly sourceRevisionId?: ProjectRevisionId;
    readonly targetRevisionId?: ProjectRevisionId;
  };
  readonly onHarnessRequest?: (request: HarnessRunRequest) => void;
  readonly onHarnessEventPersisted?: (event: HarnessEvent, agentRun: AgentRun) => void;
  /** Finish-pass §29/§35: fires after revision integrity + snapshot freeze
   *  (lock held), BEFORE target validation + TargetSpec persistence + any
   *  agent adapter start. May return `overrideIncludePaths` to replace the
   *  requested TARGETED scope with snapshot-manifest-resolved paths
   *  (Retest historical resolution). Generic: any caller may use it. */
  readonly onSnapshotFrozen?: (
    frozen: SnapshotFrozenContext,
  ) =>
    | Promise<{ mode?: 'full' | 'targeted'; overrideIncludePaths?: readonly string[] } | void>
    | { mode?: 'full' | 'targeted'; overrideIncludePaths?: readonly string[] }
    | void;
}

/** Finish-pass §36: the frozen half of a run — revision + snapshot + the
 *  immutable file manifest, before target validation and agent start. */
export interface SnapshotFrozenContext {
  readonly runId: QARunId;
  readonly projectId: ProjectId;
  readonly revision: {
    readonly id: string;
    readonly contentHash: string;
  };
  readonly snapshot: {
    readonly id: string;
    readonly projectRevisionId: string;
  };
  /** Immutable file set from the frozen manifest (never the mutable tree). */
  readonly snapshotFiles: ReadonlySet<string>;
  readonly mode: 'full' | 'targeted';
  readonly requestedIncludePaths: readonly string[] | undefined;
}

export interface RunDetails {
  readonly run: QARun;
  readonly agentRuns: AgentRun[];
  readonly findings: Finding[];
  readonly evidence: Evidence[];
  readonly activities: ReturnType<SentryRepository['listActivities']>;
  readonly events: ReturnType<SentryRepository['listRunEvents']>;
  readonly exports: ReturnType<SentryRepository['listExports']>;
}

export interface RunSummary {
  readonly run: QARun;
  readonly agentRuns: AgentRun[];
  readonly findings: Finding[];
  readonly evidence: Evidence[];
  readonly exports: ReturnType<SentryRepository['listExports']>;
  readonly counts: {
    readonly agentRuns: number;
    readonly findings: number;
    readonly evidence: number;
    readonly activities: number;
    readonly events: number;
    readonly exports: number;
  };
}

export interface RunStatus {
  readonly runId: QARunId;
  readonly projectId: ProjectId;
  readonly mode: QARun['mode'];
  readonly status: QARun['status'];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt: string | null;
  readonly agents: {
    readonly configured: number;
    readonly queued: number;
    readonly starting: number;
    readonly planning: number;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly timedOut: number;
    readonly interrupted: number;
  };
  readonly findings: { readonly total: number };
  readonly tokens?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly totalTokens?: number;
    readonly turns?: number;
  };
}

class RunTimeoutError extends Error {}

export const CANCELLATION_POLL_INTERVAL_MS = 500;

export class RunCoordinator {
  private readonly projects: ProjectManager;
  private readonly snapshots: SnapshotEngine;
  private readonly workspaces: WorkspaceFactory;
  private readonly activities: RunActivityProjector;
  private readonly exporter: RunExporter;
  /** Runtime-local ownership (§10): adapters owned by THIS coordinator
   *  instance only. Never persisted; the DB cancellation request bridges
   *  processes to this map. */
  private readonly activeAdapters = new Map<AgentRunId, HarnessAdapter>();

  constructor(
    private readonly dataRoot: string,
    private readonly repository: SentryRepository,
    private readonly runtimeLease?: RuntimeInstanceLease,
    private readonly registry: HarnessAdapterRegistry = new HarnessAdapterRegistry(),
  ) {
    this.projects = new ProjectManager(
      dataRoot,
      repository,
      runtimeLease === undefined ? {} : { runtimeLease },
    );
    this.snapshots = new SnapshotEngine(dataRoot, repository);
    this.workspaces = new WorkspaceFactory(dataRoot);
    this.activities = new RunActivityProjector(repository);
    this.exporter = new RunExporter(dataRoot, repository);
  }

  async run(projectId: ProjectId, options: RunOptions): Promise<RunDetails> {
    const runtimeLease = this.requireRuntimeLease();
    const project = this.projects.getProject(projectId);
    if (project === undefined)
      throw new RunEngineError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
    const selectedIds = options.agentStackIds ?? this.registry.list().map((item) => item.stack.id);
    const selected = selectedIds.map((id) => {
      const registration = this.registry.resolve(id);
      if (registration === undefined)
        throw new RunEngineError('AGENT_STACK_NOT_FOUND', 'Agent stack not found: ' + id);
      return registration;
    });
    if (selected.length === 0) throw new Error('At least one agent stack must be selected');
    // Phase 7 TARGETED validation (before any mutation): mode/target must
    // agree, and target paths must be project-relative (TargetSpecSchema
    // rejects absolute/.. entries; snapshot existence is checked after
    // the freeze so validation always runs against the frozen manifest).
    const mode = options.mode ?? 'full';
    if (mode === 'targeted' && options.target === undefined) {
      throw new RunEngineError(
        'INVALID_TARGET',
        'Targeted QA requires a target scope (includePaths)',
      );
    }
    if (mode === 'full' && options.target !== undefined) {
      throw new RunEngineError(
        'INVALID_TARGET',
        'Full QA takes no target scope; use mode targeted',
      );
    }
    for (const registration of selected) await registration.preflight?.();
    const runId = createQARunId();
    this.projects.lockProjectForRun(projectId, runId);
    // Final micro-fix §7/§14: pre-execution boundary. The initial QARun row
    // persists before the frozen hook (active-Retest fix — must remain), so
    // any handled failure before worker launch must terminalize that same
    // row as failed. Execution starts at first runAgent() launch only.
    let runPersisted = false;
    let executionStarted = false;
    let stagedRoot: ReturnType<RunActivityProjector['stage']> | undefined;
    try {
      const revision = await this.projects.assertWorkingCopyIntegrity(projectId);
      const context = project.context ?? this.repository.getContextForRevision(revision.id);
      if (context === undefined) throw new Error('PROJECT_CONTEXT_NOT_FOUND: ' + revision.id);
      const workingCopy = projectDataPaths(this.dataRoot, projectId).workingCopy;
      const snapshot = await this.snapshots.createSnapshot({
        projectId,
        projectRevisionId: revision.id,
        qaRunId: runId,
        workingCopyPath: workingCopy,
      });
      if (snapshot.contentHash !== revision.contentHash) throw new Error('PROJECT_COPY_DRIFT');
      const createdAt = nowIsoTimestamp();
      const lineage: QARunLineage | undefined =
        options.lineage === undefined
          ? undefined
          : {
              ...(options.lineage.parentRunId === undefined
                ? {}
                : { parentRunId: options.lineage.parentRunId }),
              ...(options.lineage.sourceRevisionId === undefined
                ? {}
                : { sourceRevisionId: options.lineage.sourceRevisionId }),
              ...(options.lineage.targetRevisionId === undefined
                ? {}
                : { targetRevisionId: options.lineage.targetRevisionId }),
            };
      // Micro-patch §7: persist the initial child QARun row BEFORE the
      // frozen hook so callbacks (Retest targetQaRunId) can reference it
      // without violating the qa_runs FK. Status agents_running is the
      // existing pre-execution state (minimum change — no new status).
      // The hook may still adjust mode before agents begin (§8); the same
      // row is updated, never a second QARun.
      let run = QARunSchema.parse({
        schemaVersion: 1,
        id: runId,
        projectId,
        runtimeInstanceId: runtimeLease.instanceId,
        executionKind: options.executionKind,
        snapshotId: snapshot.id,
        projectContextSnapshotId: context.id,
        mode,
        status: 'agents_running',
        ...(lineage === undefined ? {} : { lineage }),
        configuration: {
          agentStackIds: selected.map((item) => item.stack.id),
          verificationLevel: options.verificationLevel ?? 'strict',
          ...(options.instructions === undefined
            ? {}
            : { instructions: { message: options.instructions, createdAt } }),
          policy: { id: 'qa-standard', version: 1 },
          executionSafeguards: {
            runTimeoutMs:
              options.runTimeoutMs ??
              (options.executionKind === 'production'
                ? SENTRY_PRODUCTION_RUN_TIMEOUT_MS
                : SENTRY_SIMULATION_RUN_TIMEOUT_MS),
          },
        },
        createdAt,
        startedAt: createdAt,
      });
      this.repository.saveRun(run);
      runPersisted = true;
      // Frozen manifest file set: the immutable source of truth for scope
      // validation (never the mutable working copy).
      const frozenBaseline = await this.snapshots.baselineFileHashes(snapshot.id);
      const frozenFiles: ReadonlySet<string> = new Set(frozenBaseline.keys());
      // Finish-pass §29/§35 hook: fires after freeze (lock held), before
      // target validation + TargetSpec persistence + agent start. The hook
      // may assert revision identity (Retest B≠C race) and override the
      // TARGETED scope with manifest-resolved paths, or flip to full for
      // the explicit focused full-snapshot fallback.
      let effectiveMode = mode;
      let effectiveIncludePaths: readonly string[] | undefined =
        options.target?.includePaths === undefined ? undefined : [...options.target.includePaths];
      if (options.onSnapshotFrozen !== undefined) {
        const hookResult = await options.onSnapshotFrozen({
          runId,
          projectId,
          revision: { id: revision.id, contentHash: revision.contentHash },
          snapshot: { id: snapshot.id, projectRevisionId: snapshot.projectRevisionId },
          snapshotFiles: frozenFiles,
          mode,
          requestedIncludePaths: effectiveIncludePaths,
        });
        if (hookResult !== undefined) {
          if (hookResult.mode !== undefined) effectiveMode = hookResult.mode;
          if (effectiveMode === 'full') {
            // Explicit focused full-snapshot fallback: no target scope.
            effectiveIncludePaths = undefined;
          } else if (hookResult.overrideIncludePaths !== undefined) {
            effectiveIncludePaths = [...hookResult.overrideIncludePaths];
          }
        }
      }
      if (effectiveMode === 'full' && effectiveIncludePaths !== undefined) {
        throw new RunEngineError(
          'INVALID_TARGET',
          'Full QA takes no target scope; use mode targeted',
        );
      }
      if (effectiveMode === 'targeted' && effectiveIncludePaths === undefined) {
        throw new RunEngineError(
          'INVALID_TARGET',
          'Targeted QA requires a target scope (includePaths)',
        );
      }
      // Phase 7 TARGETED freeze (§9, §10, §77): validate target paths
      // against the FROZEN snapshot manifest (never the live source),
      // then persist the immutable TargetSpec before agents start.
      let targetSpec: TargetSpec | undefined;
      if (effectiveMode === 'targeted') {
        const scope = {
          includePaths: [...(effectiveIncludePaths as readonly string[])],
          ...(options.target?.issueIds === undefined ? {} : { issueIds: options.target.issueIds }),
          ...(options.target?.userInstructions === undefined
            ? {}
            : { userInstructions: options.target.userInstructions }),
        };
        const unknown = scope.includePaths.filter(
          (candidate) =>
            !frozenBaseline.has(candidate) &&
            ![...frozenBaseline.keys()].some((file) => file.startsWith(candidate + '/')),
        );
        if (unknown.length > 0) {
          throw new RunEngineError(
            'INVALID_TARGET',
            'Target paths not found in the frozen snapshot: ' + unknown.join(', '),
          );
        }
        targetSpec = TargetSpecSchema.parse({
          schemaVersion: 1,
          qaRunId: runId,
          snapshotId: snapshot.id,
          includePaths: [...scope.includePaths],
          issueIds: scope.issueIds === undefined ? [] : [...scope.issueIds],
          ...(scope.userInstructions === undefined
            ? {}
            : { userInstructions: scope.userInstructions }),
          createdAt,
        });
      }
      // Generic scope preamble (§11-§12): identical for every selected
      // stack, delivered through the standard instructions channel.
      const targetedPreamble =
        targetSpec === undefined
          ? ''
          : 'TARGETED QA SCOPE. Focus full-strength QA on: ' +
            targetSpec.includePaths.join(', ') +
            '. Inspect any dependency outside the scope as needed to understand the target; reported findings should relate to the target or a necessary dependency/consequence. ' +
            (targetSpec.userInstructions === undefined
              ? ''
              : 'Target instructions: ' + targetSpec.userInstructions + ' ');
      const instructionMessage =
        targetSpec === undefined && options.instructions === undefined
          ? undefined
          : targetedPreamble + (options.instructions ?? 'No additional user instructions.');
      // Micro-patch §8: the hook may flip targeted→full (explicit fallback).
      // Update the SAME persisted row before agents begin — configuration
      // preparation has not started execution, so no second QARun is created.
      run = QARunSchema.parse({
        ...run,
        mode: effectiveMode,
        configuration: {
          agentStackIds: run.configuration.agentStackIds,
          verificationLevel: run.configuration.verificationLevel,
          ...(run.configuration.policy === undefined ? {} : { policy: run.configuration.policy }),
          ...(run.configuration.executionProfileId === undefined
            ? {}
            : { executionProfileId: run.configuration.executionProfileId }),
          ...(run.configuration.executionSafeguards === undefined
            ? {}
            : { executionSafeguards: run.configuration.executionSafeguards }),
          ...(instructionMessage === undefined
            ? {}
            : { instructions: { message: instructionMessage, createdAt } }),
        },
      });
      this.repository.saveRun(run);
      if (targetSpec !== undefined) this.repository.saveTargetSpec(targetSpec, projectId);
      const scopeLabel = effectiveMode === 'targeted' ? 'Targeted QA' : 'Full QA';
      const root = this.activities.stage({
        qaRunId: runId,
        source: 'sentry',
        kind: 'run',
        title:
          options.executionKind === 'simulation'
            ? scopeLabel + ' — SIMULATED / FAKE HARNESS RUN'
            : scopeLabel + ' — REAL AGENT RUN',
        status: 'running',
      });
      stagedRoot = root;
      for (const [kind, title] of [
        ['preparation', 'Preparation'],
        ['snapshot', 'Snapshot'],
        ['context', 'Context'],
        ['baseline', options.executionKind === 'simulation' ? 'Baseline (simulated)' : 'Baseline'],
      ] as const) {
        this.activities.stage({
          qaRunId: runId,
          parentActivityId: root.id,
          source: 'sentry',
          kind,
          title,
        });
      }

      // Micro-patch §27: a cancellation request durable BEFORE any adapter
      // starts short-circuits worker launch — no provider execution begins
      // after cancellation was requested. The owner marks acknowledgedAt;
      // completion follows terminalization below like the normal path.
      const preAgentCancel = this.repository.getRunControlRequest(runId);
      if (preAgentCancel !== undefined && preAgentCancel.completedAt === undefined) {
        if (preAgentCancel.acknowledgedAt === undefined) {
          this.repository.saveRunControlRequest({
            ...preAgentCancel,
            acknowledgedAt: nowIsoTimestamp(),
          });
        }
      }
      // Final micro-fix §14: execution starts at first worker launch.
      executionStarted = true;
      const workers =
        preAgentCancel !== undefined && preAgentCancel.completedAt === undefined
          ? []
          : selected.map((registration, index) =>
              this.runAgent({
                run,
                registration,
                index,
                workingCopy,
                rootActivityId: root.id,
                missionContext: {
                  project: {
                    id: project.project.id,
                    name: project.project.name,
                    metadata: project.project.metadata,
                  },
                  revision: {
                    id: revision.id,
                    contentHash: revision.contentHash,
                    ...(revision.stats === undefined ? {} : { stats: revision.stats }),
                    ...(revision.sourceState === undefined
                      ? {}
                      : { sourceState: revision.sourceState }),
                  },
                  snapshot,
                  projectContext: context,
                  runInstructions: run.configuration.instructions ?? null,
                  qaPolicy: run.configuration.policy,
                },
                ...(options.onHarnessRequest === undefined
                  ? {}
                  : { onHarnessRequest: options.onHarnessRequest }),
                ...(options.onHarnessEventPersisted === undefined
                  ? {}
                  : { onHarnessEventPersisted: options.onHarnessEventPersisted }),
              }),
            );
      await Promise.allSettled(workers);
      // Owner-driven finalization: after workers settle, reconcile the durable
      // cancellation request. Requested-or-cancelled terminalizes the parent as
      // cancelled, never via the normal aggregate outcome.
      const cancellation = this.repository.getRunControlRequest(runId);
      const agentRuns = this.repository.listAgentRuns(runId);
      const cancelledCount = agentRuns.filter((ar) => ar.status === 'cancelled').length;
      const outcome =
        cancellation !== undefined || cancelledCount > 0
          ? 'cancelled'
          : aggregateAgentRunOutcome(
              agentRuns.map((agentRun) => ({
                status: agentRun.status,
                producedUsableOutput: this.repository.agentProducedUsableOutput(agentRun.id),
              })),
            );
      const finalStages =
        options.executionKind === 'simulation'
          ? ([
              ['merger', 'merger', 'Merger (deterministic no-op)'],
              ['verifier', 'verification', 'Verification (simulated)'],
              ['report', 'report', 'Report'],
            ] as const)
          : ([['report', 'report', 'Report']] as const);
      for (const [source, kind, title] of finalStages) {
        this.activities.stage({ qaRunId: runId, parentActivityId: root.id, source, kind, title });
      }
      const completedAt = nowIsoTimestamp();
      run = QARunSchema.parse({
        ...run,
        status: outcome,
        completedAt,
        summary: {
          agentRuns: {
            configured: agentRuns.length,
            completed: agentRuns.filter((item) => item.status === 'completed').length,
            failed: agentRuns.filter(
              (item) => item.status === 'failed' || item.status === 'timed_out',
            ).length,
            interrupted: agentRuns.filter((item) => item.status === 'interrupted').length,
          },
          findings: { total: this.repository.listFindings(runId).length },
        },
      });
      this.repository.saveRun(run);
      this.repository.saveActivity({
        ...root,
        status:
          outcome === 'completed'
            ? 'completed'
            : outcome === 'partial'
              ? 'warning'
              : outcome === 'cancelled'
                ? 'cancelled'
                : 'failed',
        completedAt,
      });
      // completedAt is set only when owned execution actually settled:
      // workers done, workspaces cleaned (runAgent finally), parent terminal.
      if (outcome === 'cancelled') {
        const pending = this.repository.getRunControlRequest(runId);
        if (pending !== undefined && pending.completedAt === undefined) {
          this.repository.saveRunControlRequest({ ...pending, completedAt: nowIsoTimestamp() });
        }
      }
      await this.exporter.export(runId, 'log');
      await this.exporter.export(runId, 'json');
      return this.getRunDetails(runId);
    } catch (cause) {
      // Final micro-fix §7: a handled failure after QARun persistence but
      // before worker launch must not leave a stale agents_running row.
      // Worker-phase errors have their own lifecycle — only pre-execution
      // failures terminalize here (§13); cancellation keeps its path (§15).
      if (runPersisted && !executionStarted) {
        const persisted = this.repository.getRun(runId);
        if (
          persisted !== undefined &&
          !['completed', 'partial', 'failed', 'cancelled'].includes(persisted.status)
        ) {
          const completedAt = nowIsoTimestamp();
          this.repository.saveRun(
            QARunSchema.parse({ ...persisted, status: 'failed', completedAt }),
          );
          if (stagedRoot !== undefined) {
            this.repository.saveActivity({ ...stagedRoot, status: 'failed', completedAt });
          }
        }
      }
      throw cause;
    } finally {
      this.projects.unlockProjectAfterRun(projectId, runId);
    }
  }

  private async runAgent(input: {
    readonly run: QARun;
    readonly registration: HarnessAdapterRegistration;
    readonly index: number;
    readonly workingCopy: string;
    readonly rootActivityId: ReturnType<RunActivityProjector['stage']>['id'];
    readonly missionContext: Readonly<Record<string, unknown>>;
    readonly onHarnessRequest?: (request: HarnessRunRequest) => void;
    readonly onHarnessEventPersisted?: (event: HarnessEvent, agentRun: AgentRun) => void;
  }): Promise<void> {
    // Preflight reports the authoritative configured model into
    // registration.runtimeIdentity; reflect it on the stack view so
    // requests, mission context, and persisted identity never carry the
    // 'unconfigured' registration placeholder for a selected stack.
    const resolvedModelId = input.registration.runtimeIdentity?.modelId;
    const stack =
      resolvedModelId === undefined
        ? input.registration.stack
        : {
            ...input.registration.stack,
            model: { ...input.registration.stack.model, modelId: resolvedModelId },
          };
    const agentRunId = createAgentRunId();
    const startedAt = nowIsoTimestamp();
    let agentRun = AgentRunSchema.parse({
      schemaVersion: 1,
      id: agentRunId,
      qaRunId: input.run.id,
      agentStackId: stack.id,
      taskType: 'qa',
      status: 'starting',
      startedAt,
      runtimeIdentity: {
        modelId: stack.model.modelId,
        ...input.registration.runtimeIdentity,
        policyId: stack.policy.id,
        policyVersion: stack.policy.version,
      },
    });
    this.repository.saveAgentRun(agentRun);
    let workspace: HarnessWorkspace | undefined;
    let adapter: HarnessAdapter | undefined;
    const validator = new IncrementalHarnessEventValidator(input.run.id, agentRunId);
    let cancelledByControlRequest = false;
    try {
      adapter = await input.registration.createAdapter({
        qaRunId: input.run.id,
        agentRunId,
        agentIndex: input.index,
        stack,
      });
      const metadata = await adapter.getMetadata();
      agentRun = AgentRunSchema.parse({
        ...agentRun,
        runtimeIdentity: {
          ...agentRun.runtimeIdentity,
          adapterId: metadata.adapterId,
          adapterVersion: metadata.adapterVersion,
        },
      });
      this.repository.saveAgentRun(agentRun);
      // Authoritative baseline hashes come from the frozen run snapshot
      // manifest (never the live source or a harness-side rescan).
      const baselineHashes = await this.snapshots.baselineFileHashes(input.run.snapshotId);
      workspace = await this.workspaces.create({
        projectId: input.run.projectId,
        qaRunId: input.run.id,
        agentRunId,
        snapshotId: input.run.snapshotId,
        workingCopyPath: input.workingCopy,
        baseline: { snapshotId: input.run.snapshotId, fileHashByPath: baselineHashes },
      });
      this.activeAdapters.set(agentRunId, adapter);
      const request = HarnessRunRequestSchema.parse({
        schemaVersion: 1,
        agentRunId,
        qaRunId: input.run.id,
        agentStackId: stack.id,
        projectContextSnapshotId: input.run.projectContextSnapshotId,
        workspace,
        model: stack.model,
        task: {
          type: 'qa',
          prompt:
            (input.run.executionKind === 'simulation'
              ? 'SIMULATED QA. '
              : 'REAL QA. Independently inspect the supplied snapshot. ') +
            (input.run.configuration.instructions?.message ?? 'No additional user instructions.'),
          policyId: input.run.configuration.policy.id,
          policyVersion: input.run.configuration.policy.version,
          context: {
            ...input.missionContext,
            agentStack: stack,
          },
        },
        executionSafeguards: input.run.configuration.executionSafeguards,
      });
      input.onHarnessRequest?.(request);
      const timeoutMs = input.run.configuration.executionSafeguards?.runTimeoutMs ?? 2_000;
      const consumeOutcome = await this.consumeWithTimeout(
        adapter,
        request,
        timeoutMs,
        async (event) => {
          this.requireRuntimeLease();
          validator.accept(event);
          this.repository.transaction(() => {
            this.repository.appendHarnessEventWithinTransaction(input.run.id, event);
            this.activities.project(event, input.run.id, input.rootActivityId);
            if (event.type === 'investigation.plan.created') this.repository.savePlan(event.plan);
            else if (event.type === 'investigation.hypothesis.discovered')
              this.repository.saveHypothesis(event.hypothesis);
            else if (event.type === 'finding.submitted') this.repository.saveFinding(event.finding);
            else if (event.type === 'evidence.submitted')
              this.repository.saveEvidence(event.evidence);
            agentRun = this.projectAgentRunEvent(agentRun, event);
          });
          input.onHarnessEventPersisted?.(event, agentRun);
        },
      );
      if (consumeOutcome.cancelled) cancelledByControlRequest = true;
      // Race safety (§12): reconcile against durable state before the
      // terminal write — a control request may have terminalized this
      // AgentRun as cancelled while the stream was finishing. A durably
      // cancelled row must never be overwritten with completed.
      agentRun = this.reconcileAgentRunBeforeTerminalWrite(agentRunId, agentRun);
      if (cancelledByControlRequest && agentRun.status !== 'cancelled') {
        agentRun = AgentRunSchema.parse({
          ...agentRun,
          status: 'cancelled',
          completedAt: agentRun.completedAt ?? nowIsoTimestamp(),
        });
      }
      agentRun = AgentRunSchema.parse({
        ...agentRun,
        runtimeIdentity: {
          ...agentRun.runtimeIdentity,
          ...input.registration.runtimeIdentity,
        },
      });
      this.persistAgentRunUnlessCancelled(agentRunId, agentRun);
      validator.finish();
      const persisted = this.repository.getAgentRun(agentRunId);
      if (
        persisted !== undefined &&
        !['completed', 'failed', 'cancelled'].includes(persisted.status)
      ) {
        throw new Error('WORKER_DISCONNECTED');
      }
    } catch (cause) {
      const timedOut = cause instanceof RunTimeoutError;
      // A raw ZodError escaping an adapter is a structured validation failure,
      // not a transport loss — and its message is raw JSON that must never be
      // persisted verbatim. Map it to a bounded protocol message.
      const zodFailure =
        typeof cause === 'object' &&
        cause !== null &&
        (cause as { name?: unknown }).name === 'ZodError';
      const protocolViolation =
        zodFailure ||
        cause instanceof HarnessProtocolError ||
        (cause instanceof RuntimePersistenceError && cause.code === 'EVENT_CONFLICT');
      const typed =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? (cause as { code?: unknown; message?: unknown; retryable?: unknown })
          : undefined;
      agentRun = AgentRunSchema.parse({
        ...agentRun,
        status: timedOut ? 'timed_out' : protocolViolation ? 'failed' : 'interrupted',
        completedAt: nowIsoTimestamp(),
        failure: {
          code: timedOut
            ? 'RUN_TIMEOUT'
            : protocolViolation
              ? 'HARNESS_PROTOCOL_VIOLATION'
              : typeof typed?.code === 'string'
                ? typed.code
                : 'WORKER_DISCONNECTED',
          message: timedOut
            ? 'Agent exceeded configured run timeout.'
            : zodFailure
              ? 'Agent output failed schema validation.'
              : protocolViolation
                ? cause instanceof Error
                  ? cause.message
                  : 'Harness protocol validation failed.'
                : cause instanceof Error
                  ? cause.message
                  : 'Agent worker transport disconnected.',
          retryable: typeof typed?.retryable === 'boolean' ? typed.retryable : !protocolViolation,
        },
      });
      // Race safety (§12): a durably cancelled row wins over a late local failure.
      agentRun = this.reconcileAgentRunBeforeTerminalWrite(agentRunId, agentRun);
      if (cancelledByControlRequest && agentRun.status !== 'cancelled') {
        const reconciled = this.repository.getAgentRun(agentRunId);
        if (reconciled === undefined || reconciled.status === agentRun.status) {
          agentRun = AgentRunSchema.parse({
            ...agentRun,
            status: 'cancelled',
            completedAt: agentRun.completedAt ?? nowIsoTimestamp(),
          });
        } else {
          agentRun = reconciled;
        }
      }
      this.persistAgentRunUnlessCancelled(agentRunId, agentRun);
      this.activities.finalizeAgent(
        agentRunId,
        'failed',
        agentRun.completedAt,
        timedOut
          ? 'Agent timed out'
          : protocolViolation
            ? 'Agent failed protocol validation'
            : 'Agent interrupted by transport loss',
      );
    } finally {
      this.activeAdapters.delete(agentRunId);
      await adapter?.dispose();
      // Generic shutdown observability: after dispose(), surface any adapter
      // shutdown diagnostics as run warnings before workspace cleanup.
      for (const diagnostic of adapter?.getShutdownDiagnostics?.() ?? []) {
        this.activities.stage({
          qaRunId: input.run.id,
          parentActivityId: input.rootActivityId,
          source: 'sentry',
          kind: 'runtime',
          title:
            diagnostic.severity === 'error'
              ? 'Shutdown diagnostic (error): ' + diagnostic.code
              : 'Shutdown diagnostic: ' + diagnostic.code,
          status: diagnostic.severity === 'error' ? 'failed' : 'warning',
        });
      }
      if (workspace !== undefined) {
        const cleanup = await this.workspaces.cleanup(workspace);
        if (cleanup.warning !== undefined) {
          this.activities.stage({
            qaRunId: input.run.id,
            parentActivityId: input.rootActivityId,
            source: 'sentry',
            kind: 'runtime',
            title: cleanup.warning,
            status: 'warning',
          });
        }
      }
    }
  }

  /** Race safety (§12): a durably terminal row (esp. cancelled) is never
   *  overwritten by a stale local in-memory object. Returns the persisted
   *  row when it is already terminal, otherwise the local candidate. */
  private reconcileAgentRunBeforeTerminalWrite(agentRunId: AgentRunId, local: AgentRun): AgentRun {
    const persisted = this.repository.getAgentRun(agentRunId);
    if (persisted === undefined) return local;
    if (
      ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(persisted.status)
    ) {
      return persisted;
    }
    return local;
  }

  private persistAgentRunUnlessCancelled(agentRunId: AgentRunId, local: AgentRun): void {
    const persisted = this.repository.getAgentRun(agentRunId);
    if (persisted !== undefined && persisted.status === 'cancelled') return;
    this.repository.saveAgentRun(local);
  }

  private projectAgentRunEvent(agentRun: AgentRun, event: HarnessEvent): AgentRun {
    let nextStatus = agentRun.status;
    let completedAt = agentRun.completedAt;
    let failure = agentRun.failure;
    let usage = agentRun.usage;
    if (event.type === 'run.started') nextStatus = 'running';
    else if (event.type === 'agent.status') {
      nextStatus = event.status === 'planning' ? 'planning' : 'running';
    } else if (event.type === 'usage.updated') usage = event.usage;
    else if (event.type === 'run.completed') {
      nextStatus = 'completed';
      completedAt = event.timestamp;
      usage = event.usage ?? usage;
    } else if (event.type === 'run.failed') {
      nextStatus = 'failed';
      completedAt = event.timestamp;
      failure = event.failure;
    } else if (event.type === 'run.cancelled') {
      nextStatus = 'cancelled';
      completedAt = event.timestamp;
    }
    if (nextStatus !== agentRun.status) assertAgentRunTransition(agentRun.status, nextStatus);
    const projected = AgentRunSchema.parse({
      ...agentRun,
      status: nextStatus,
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(failure === undefined ? {} : { failure }),
      ...(usage === undefined ? {} : { usage }),
    });
    if (projected !== agentRun) this.repository.saveAgentRun(projected);
    return projected;
  }

  /** Cooperative cancellation watcher: polls the durable control request
   *  while the provider stream blocks. When the OWNER observes a pending
   *  request it marks acknowledgedAt, then awaits adapter.cancel() on the
   *  OWNED adapter only (never fire-and-forget). Workers never terminalize
   *  the parent — the coordinator does that after all workers settle. */
  private startCancellationWatcher(input: {
    readonly qaRunId: QARunId;
    readonly agentRunId: AgentRunId;
    readonly adapter: HarnessAdapter;
    readonly onCancelDelivered: () => void;
  }): { stop: () => void; wasCancelDelivered: () => boolean; delivery: () => Promise<void> } {
    let delivered = false;
    let delivery: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      try {
        const request = this.repository.getRunControlRequest(input.qaRunId);
        if (request === undefined || request.completedAt !== undefined) return;
        const owned = this.activeAdapters.get(input.agentRunId);
        if (owned === undefined || owned !== input.adapter) return;
        if (delivered) return;
        // Only the local owner acknowledges: adapter registration proves
        // this runtime owns the worker. Foreign runtimes only persist
        // requests; they never acknowledge or cancel here.
        delivered = true;
        if (request.acknowledgedAt === undefined) {
          this.repository.saveRunControlRequest({
            ...request,
            acknowledgedAt: nowIsoTimestamp(),
          });
        }
        input.onCancelDelivered();
        delivery = owned.cancel(input.agentRunId).catch(() => undefined);
      } catch {
        // Watcher must never break the worker stream; the owner still
        // reconciles durable state at terminalization.
      }
    }, CANCELLATION_POLL_INTERVAL_MS);
    if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    return {
      stop: () => clearInterval(timer),
      wasCancelDelivered: () => delivered,
      delivery: () => delivery,
    };
  }

  private async consumeWithTimeout(
    adapter: HarnessAdapter,
    request: ReturnType<typeof HarnessRunRequestSchema.parse>,
    timeoutMs: number,
    onEvent: (event: HarnessEvent) => Promise<void>,
  ): Promise<{ cancelled: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    let watcher:
      | { stop: () => void; wasCancelDelivered: () => boolean; delivery: () => Promise<void> }
      | undefined;
    let cancelDelivered = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RunTimeoutError()), timeoutMs);
    });
    try {
      watcher = this.startCancellationWatcher({
        qaRunId: request.qaRunId,
        agentRunId: request.agentRunId,
        adapter,
        onCancelDelivered: () => {
          cancelDelivered = true;
        },
      });
      const consume = (async () => {
        for await (const event of adapter.run(request)) {
          if (watcher?.wasCancelDelivered() === true) break;
          await onEvent(event);
        }
      })();
      await Promise.race([consume, timeout]);
      // Await the owned adapter shutdown before reporting cancellation:
      // completion is claimed only after cancel() settles.
      if (watcher?.wasCancelDelivered() === true) await watcher.delivery();
      return { cancelled: watcher?.wasCancelDelivered() === true || cancelDelivered };
    } catch (cause) {
      if (cause instanceof RunTimeoutError) await adapter.cancel(request.agentRunId);
      throw cause;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      watcher?.stop();
    }
  }

  getRunDetails(runId: QARunId): RunDetails {
    const run = this.repository.getRun(runId);
    if (run === undefined) throw new RunEngineError('RUN_NOT_FOUND', 'Run not found: ' + runId);
    return {
      run,
      agentRuns: this.repository.listAgentRuns(runId),
      findings: this.repository.listFindings(runId),
      evidence: this.repository.listEvidence(runId),
      activities: this.repository.listActivities(runId),
      events: this.repository.listRunEvents(runId),
      exports: this.repository.listExports(runId),
    };
  }

  getRunSummary(runId: QARunId): RunSummary {
    const run = this.repository.getRun(runId);
    if (run === undefined) throw new RunEngineError('RUN_NOT_FOUND', 'Run not found: ' + runId);
    const agentRuns = this.repository.listAgentRuns(runId);
    const findings = this.repository.listFindings(runId);
    const evidence = this.repository.listEvidence(runId);
    const exports = this.repository.listExports(runId);
    return {
      run,
      agentRuns,
      findings,
      evidence,
      exports,
      counts: {
        agentRuns: agentRuns.length,
        findings: findings.length,
        evidence: evidence.length,
        activities: this.repository.countRunActivities(runId),
        events: this.repository.countRunEvents(runId),
        exports: exports.length,
      },
    };
  }

  getRunStatus(runId: QARunId): RunStatus {
    const run = this.repository.getRun(runId);
    if (run === undefined) throw new RunEngineError('RUN_NOT_FOUND', 'Run not found: ' + runId);
    const counts = this.repository.countAgentRunsByStatus(runId);
    const agentRuns = this.repository.listAgentRuns(runId);
    const usage = aggregateAgentUsage(
      agentRuns.flatMap((agentRun) => (agentRun.usage === undefined ? [] : [agentRun.usage])),
    );
    const tokens = {
      ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      ...(usage.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: usage.cachedInputTokens }),
      ...(usage.inputTokens === undefined || usage.outputTokens === undefined
        ? {}
        : { totalTokens: usage.inputTokens + usage.outputTokens }),
      ...(usage.turns === undefined ? {} : { turns: usage.turns }),
    };
    return {
      runId: run.id,
      projectId: run.projectId,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      completedAt: run.completedAt ?? null,
      agents: {
        configured: run.configuration.agentStackIds.length,
        queued: counts.get('queued') ?? 0,
        starting: counts.get('starting') ?? 0,
        planning: counts.get('planning') ?? 0,
        running: counts.get('running') ?? 0,
        completed: counts.get('completed') ?? 0,
        failed: counts.get('failed') ?? 0,
        cancelled: counts.get('cancelled') ?? 0,
        timedOut: counts.get('timed_out') ?? 0,
        interrupted: counts.get('interrupted') ?? 0,
      },
      findings: { total: this.repository.countRunFindings(runId) },
      ...(Object.keys(tokens).length === 0 ? {} : { tokens }),
    };
  }

  listRuns(projectId: ProjectId): QARun[] {
    return this.repository.listRuns(projectId);
  }

  exportRun(runId: QARunId, format: 'log' | 'json') {
    const run = this.repository.getRun(runId);
    if (run === undefined) {
      throw new RunEngineError('RUN_NOT_FOUND', 'Run not found: ' + runId);
    }
    if (!['completed', 'partial', 'failed', 'cancelled'].includes(run.status)) {
      throw new RunEngineError(
        'RUN_NOT_COMPLETE',
        'Run export is available after the run reaches a terminal status',
      );
    }
    return this.exporter.export(runId, format);
  }

  /** Finish-pass §7-8: strict local ownership. When the run carries a
   *  runtimeInstanceId, ONLY the lease with the identical instanceId owns
   *  it. Freshness answers liveness, never ownership. Legacy runs without
   *  an instanceId fall back to local live-adapter registration only. */
  isLocalRunOwner(run: QARun): boolean {
    const lease = this.requireRuntimeLease();
    if (run.runtimeInstanceId !== undefined) {
      return run.runtimeInstanceId === lease.instanceId;
    }
    for (const agentRun of this.repository.listAgentRuns(run.id)) {
      if (this.activeAdapters.has(agentRun.id)) return true;
    }
    return false;
  }

  /** Finish-pass §8: is the recorded owner currently healthy? Liveness
   *  only — never ownership. */
  isRunOwnerFresh(run: QARun): boolean {
    const lease = this.requireRuntimeLease();
    if (run.runtimeInstanceId === undefined) return false;
    return lease.isFresh(run.runtimeInstanceId);
  }

  /** Finish-pass §9-10: request-only cancellation. ANY live runtime may
   *  persist the durable request; only the local owner proceeds further.
   *  Foreign callers (CLI B) stop here with `cancellation_requested` —
   *  they never acknowledge or terminalize another runtime's execution. */
  requestRunCancellation(runId: QARunId): {
    readonly runId: QARunId;
    readonly status: 'cancellation_requested' | 'cancelled' | 'already_terminal';
    readonly cancelledAgents: number;
    readonly ownerAcknowledged: boolean;
  } {
    const lease = this.requireRuntimeLease();
    const run = this.repository.getRun(runId);
    if (run === undefined) throw new RunEngineError('RUN_NOT_FOUND', 'Run not found: ' + runId);
    if (['completed', 'partial', 'failed', 'cancelled'].includes(run.status)) {
      return { runId, status: 'already_terminal', cancelledAgents: 0, ownerAcknowledged: false };
    }
    const existing = this.repository.getRunControlRequest(runId);
    const timestamp = nowIsoTimestamp();
    if (existing === undefined) {
      this.repository.saveRunControlRequest({
        id: 'cancel_' + runId.slice(4),
        qaRunId: runId,
        projectId: run.projectId,
        requestType: 'cancel',
        requestingRuntimeId: lease.instanceId,
        requestedAt: timestamp,
      });
    }
    // Owner-driven flow: worker watchers observe the request, await owned
    // adapter shutdown, settle, then the coordinator terminalizes the
    // parent after allSettled. No manual acknowledgement here — not even
    // for the local owner: the running coordinator's workers do it.
    const pending = this.repository.getRunControlRequest(runId);
    return {
      runId,
      status: 'cancellation_requested',
      cancelledAgents: 0,
      ownerAcknowledged: pending?.acknowledgedAt !== undefined,
    };
  }

  /** Synchronous owner acknowledge for the narrow single-process case:
   *  the caller IS the local owner AND holds live adapters AND the run is
   *  not currently executing inside this coordinator's run() (e.g. stale
   *  rows, tests, retest cascade within the owner process). Refuses foreign
   *  runtimes outright. Production cross-process cancellation never calls
   *  this from a foreign process — the owner's workers drive it. */
  acknowledgeRunCancellation(runId: QARunId): {
    readonly runId: QARunId;
    readonly status: 'cancellation_requested' | 'cancelled' | 'already_terminal';
    readonly cancelledAgents: number;
    readonly ownerAcknowledged: boolean;
  } {
    this.requireRuntimeLease();
    const run = this.repository.getRun(runId);
    if (run === undefined) throw new RunEngineError('RUN_NOT_FOUND', 'Run not found: ' + runId);
    if (['completed', 'partial', 'failed', 'cancelled'].includes(run.status)) {
      const pending = this.repository.getRunControlRequest(runId);
      if (pending !== undefined && pending.completedAt === undefined) {
        this.repository.saveRunControlRequest({ ...pending, completedAt: nowIsoTimestamp() });
      }
      return { runId, status: 'already_terminal', cancelledAgents: 0, ownerAcknowledged: false };
    }
    if (!this.isLocalRunOwner(run)) {
      throw new RunEngineError(
        'RUN_EXECUTION_FAILED',
        'Run ' + runId + ' is owned by another runtime instance; cancellation refused',
      );
    }
    const timestamp = nowIsoTimestamp();
    const pending = this.repository.getRunControlRequest(runId);
    if (pending !== undefined && pending.acknowledgedAt === undefined) {
      this.repository.saveRunControlRequest({ ...pending, acknowledgedAt: timestamp });
    }
    const ownedAgentIds = this.repository
      .listAgentRuns(run.id)
      .filter((agentRun) => this.activeAdapters.has(agentRun.id))
      .map((agentRun) => agentRun.id);
    let cancelledAgents = 0;
    this.repository.transaction(() => {
      const fresh = this.repository.getRun(run.id);
      if (
        fresh !== undefined &&
        ['completed', 'partial', 'failed', 'cancelled'].includes(fresh.status)
      ) {
        return;
      }
      for (const agentRun of this.repository.listAgentRuns(run.id)) {
        const reconciled = this.repository.getAgentRun(agentRun.id);
        const current = reconciled ?? agentRun;
        if (
          ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(current.status)
        ) {
          continue;
        }
        if (!ownedAgentIds.includes(current.id)) continue;
        assertAgentRunTransition(current.status, 'cancelled');
        this.repository.saveAgentRun(
          AgentRunSchema.parse({
            ...current,
            status: 'cancelled',
            completedAt: timestamp,
          }),
        );
        cancelledAgents += 1;
      }
      // Synchronous ack only marks agents; parent terminalization belongs
      // to the coordinator after workers settle (or a later owner pass).
      // Do NOT mark the QARun cancelled or complete the request here when
      // owned adapters are still registered — their workers own that.
      if (ownedAgentIds.length === 0) {
        for (const activity of this.repository.listActivities(run.id)) {
          if (activity.status !== 'running' && activity.status !== 'waiting') continue;
          this.repository.saveActivity({
            ...activity,
            status: 'failed',
            title: (activity.title + ' — cancelled by operator').slice(0, 300),
            completedAt: timestamp,
          });
        }
        this.repository.saveRun(
          QARunSchema.parse({ ...run, status: 'cancelled', completedAt: timestamp }),
        );
      }
    });
    const terminal = this.repository.getRun(run.id);
    if (
      terminal !== undefined &&
      ['completed', 'partial', 'failed', 'cancelled'].includes(terminal.status) &&
      ownedAgentIds.length === 0
    ) {
      const done = this.repository.getRunControlRequest(runId);
      if (done !== undefined && done.completedAt === undefined) {
        this.repository.saveRunControlRequest({ ...done, completedAt: nowIsoTimestamp() });
      }
      try {
        this.projects.unlockProjectAfterRun(run.projectId, run.id);
      } catch {
        this.projects.recoverAbandonedRunLock(run.projectId, run.id);
      }
      return { runId, status: 'cancelled', cancelledAgents, ownerAcknowledged: true };
    }
    return { runId, status: 'cancellation_requested', cancelledAgents, ownerAcknowledged: true };
  }

  /** Owner-process cancel: request, then acknowledge as the verified local
   *  owner. Foreign runtimes are refused by acknowledgeRunCancellation;
   *  cross-process callers use requestRunCancellation and let the owner
   *  workers drive cancellation. Preserved for in-process callers (tests,
   *  retest cascade within the owner process).
   */
  /** Legacy single-process cancel: request + immediately acknowledge as
   *  owner. Preserved for in-process callers (tests, retest cascade).
   *  Cross-process callers should use requestRunCancellation and let the
   *  owner acknowledge. */
  cancelRun(runId: QARunId): { runId: QARunId; status: 'cancelled'; cancelledAgents: number } {
    const requested = this.requestRunCancellation(runId);
    if (requested.status === 'already_terminal') {
      const terminal = this.repository.getRun(runId);
      throw new RunEngineError(
        'RUN_NOT_COMPLETE',
        'Run ' +
          runId +
          ' is already terminal (' +
          (terminal?.status ?? 'unknown') +
          '); nothing to cancel',
      );
    }
    if (requested.status === 'cancelled') {
      return { runId, status: 'cancelled' as const, cancelledAgents: requested.cancelledAgents };
    }
    const acknowledged = this.acknowledgeRunCancellation(runId);
    if (acknowledged.status !== 'cancelled') {
      throw new RunEngineError(
        'RUN_EXECUTION_FAILED',
        'Run ' + runId + ' cancellation requested; owner has not terminalized yet',
      );
    }
    return { runId, status: 'cancelled' as const, cancelledAgents: acknowledged.cancelledAgents };
  }

  async recover(): Promise<void> {
    const lease = this.requireRuntimeLease();
    await this.projects.recoverAbandonedOperations(lease);
    const timestamp = nowIsoTimestamp();
    // Closure §16: a cancellation request whose owner died must not stay
    // `cancellation_requested` forever. If the requesting and owning
    // runtimes are both stale, complete the request record honestly — the
    // run itself terminalizes as interrupted below (never fake-cancelled).
    for (const pending of this.repository.listPendingRunControlRequests()) {
      const run = this.repository.getRun(pending.qaRunId as QARunId);
      if (run === undefined) continue;
      if (['completed', 'partial', 'failed', 'cancelled'].includes(run.status)) {
        this.repository.saveRunControlRequest({ ...pending, completedAt: timestamp });
        continue;
      }
      const ownerFresh =
        (run.runtimeInstanceId !== undefined && lease.isFresh(run.runtimeInstanceId as never)) ||
        lease.isFresh(pending.requestingRuntimeId as never);
      if (!ownerFresh) {
        this.repository.saveRunControlRequest({ ...pending, completedAt: timestamp });
      }
    }
    for (const run of this.repository.listNonterminalRuns()) {
      const managedCopy = this.repository.getManagedCopy(run.projectId);
      const lockOwner =
        managedCopy?.state === 'locked_for_run' && managedCopy.lockedByQARunId === run.id
          ? managedCopy.runtimeInstanceId
          : undefined;
      if (
        (run.runtimeInstanceId !== undefined && lease.isFresh(run.runtimeInstanceId)) ||
        (lockOwner !== undefined && lease.isFresh(lockOwner))
      )
        continue;
      this.repository.transaction(() => {
        for (const agentRun of this.repository.listAgentRuns(run.id)) {
          if (
            ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(
              agentRun.status,
            )
          )
            continue;
          this.repository.saveAgentRun(
            AgentRunSchema.parse({
              ...agentRun,
              status: 'interrupted',
              completedAt: timestamp,
              failure: {
                code: 'APP_INTERRUPTED',
                message: 'Sentry stopped before the agent completed.',
                retryable: true,
              },
            }),
          );
        }
        const agents = this.repository.listAgentRuns(run.id);
        const outcome = aggregateAgentRunOutcome(
          agents.map((agent) => ({
            status: agent.status === 'cancelled' ? 'failed' : agent.status,
            producedUsableOutput: this.repository.agentProducedUsableOutput(agent.id),
          })),
        );
        for (const activity of this.repository.listActivities(run.id)) {
          if (activity.status !== 'running' && activity.status !== 'waiting') continue;
          const recoveredStatus =
            activity.kind === 'run'
              ? outcome === 'completed'
                ? 'completed'
                : outcome === 'partial'
                  ? 'warning'
                  : 'failed'
              : 'failed';
          this.repository.saveActivity(
            RunActivitySchema.parse({
              ...activity,
              status: recoveredStatus,
              title: (activity.title + ' — interrupted by unexpected Sentry stop').slice(0, 300),
              completedAt: timestamp,
            }),
          );
        }
        this.repository.saveRun(
          QARunSchema.parse({ ...run, status: outcome, completedAt: timestamp }),
        );
      });
      this.projects.recoverAbandonedRunLock(run.projectId, run.id);
    }
    for (const copy of this.repository.listManagedCopiesByState(['locked_for_run'])) {
      if (copy.lockedByQARunId !== undefined) {
        if (copy.runtimeInstanceId !== undefined && lease.isFresh(copy.runtimeInstanceId)) continue;
        const run = this.repository.getRun(copy.lockedByQARunId);
        if (
          run === undefined ||
          ['completed', 'partial', 'failed', 'cancelled'].includes(run.status)
        ) {
          this.projects.recoverAbandonedRunLock(copy.projectId, copy.lockedByQARunId);
        }
      }
    }
    // Verification crash recovery uses the same lease freshness — no
    // parallel lease system (§64). Stale-owned running verifications
    // become interrupted with completed observations preserved.
    await recoverVerifications(this.repository, (instanceId) => lease.isFresh(instanceId as never));
    // Retest crash recovery (§55): stale-owned nonterminal retest runs
    // become interrupted; completed assessments and occurrences persist.
    recoverRetests(this.repository, (instanceId) => lease.isFresh(instanceId as never));
  }

  private requireRuntimeLease(): RuntimeInstanceLease {
    if (this.runtimeLease === undefined) {
      throw new RuntimePersistenceError(
        'RUNTIME_LEASE_LOST',
        'This runtime operation requires an active runtime instance lease',
      );
    }
    this.runtimeLease.assertHealthy();
    return this.runtimeLease;
  }
}

export * from './errors.js';

export * from './activity-projector.js';
export * from './exporters.js';
export * from './merge-service.js';
export * from './issue-service.js';
export * from './retest-service.js';
export * from './verification-service.js';
export * from './simulation.js';
