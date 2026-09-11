import {
  createAgentRunId,
  createQARunId,
  nowIsoTimestamp,
  type AgentStackId,
  type ProjectId,
  type QARunId,
} from '@qa/shared';
import {
  AgentRunSchema,
  HarnessRunRequestSchema,
  QARunSchema,
  RunActivitySchema,
  type AgentRun,
  type Evidence,
  type Finding,
  type HarnessEvent,
  type HarnessRunRequest,
  type HarnessWorkspace,
  type QARun,
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
  type SentryRepository,
} from '@qa/persistence';
import { ProjectManager } from '@qa/project-manager';
import { SnapshotEngine } from '@qa/snapshot-engine';
import { WorkspaceFactory } from '@qa/workspace-factory';
import { RunActivityProjector } from './activity-projector.js';
import { RunExporter } from './exporters.js';
import { RunEngineError } from './errors.js';

export interface RunOptions {
  readonly agentStackIds?: readonly AgentStackId[];
  readonly executionKind: 'simulation' | 'production';
  readonly verificationLevel?: VerificationLevel;
  readonly instructions?: string;
  readonly runTimeoutMs?: number;
  readonly onHarnessRequest?: (request: HarnessRunRequest) => void;
  readonly onHarnessEventPersisted?: (event: HarnessEvent, agentRun: AgentRun) => void;
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

export class RunCoordinator {
  private readonly projects: ProjectManager;
  private readonly snapshots: SnapshotEngine;
  private readonly workspaces: WorkspaceFactory;
  private readonly activities: RunActivityProjector;
  private readonly exporter: RunExporter;

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
    for (const registration of selected) await registration.preflight?.();
    const runId = createQARunId();
    this.projects.lockProjectForRun(projectId, runId);
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
      let run = QARunSchema.parse({
        schemaVersion: 1,
        id: runId,
        projectId,
        runtimeInstanceId: runtimeLease.instanceId,
        executionKind: options.executionKind,
        snapshotId: snapshot.id,
        projectContextSnapshotId: context.id,
        mode: 'full',
        status: 'agents_running',
        configuration: {
          agentStackIds: selected.map((item) => item.stack.id),
          verificationLevel: options.verificationLevel ?? 'strict',
          ...(options.instructions === undefined
            ? {}
            : { instructions: { message: options.instructions, createdAt } }),
          policy: { id: 'qa-standard', version: 1 },
          executionSafeguards: {
            runTimeoutMs:
              options.runTimeoutMs ?? (options.executionKind === 'production' ? 1_800_000 : 2_000),
          },
        },
        createdAt,
        startedAt: createdAt,
      });
      this.repository.saveRun(run);
      const root = this.activities.stage({
        qaRunId: runId,
        source: 'sentry',
        kind: 'run',
        title:
          options.executionKind === 'simulation'
            ? 'Full QA — SIMULATED / FAKE HARNESS RUN'
            : 'Full QA — REAL AGENT RUN',
        status: 'running',
      });
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

      const workers = selected.map((registration, index) =>
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
              ...(revision.sourceState === undefined ? {} : { sourceState: revision.sourceState }),
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
      const agentRuns = this.repository.listAgentRuns(runId);
      const outcome = aggregateAgentRunOutcome(
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
          outcome === 'completed' ? 'completed' : outcome === 'partial' ? 'warning' : 'failed',
        completedAt,
      });
      await this.exporter.export(runId, 'log');
      await this.exporter.export(runId, 'json');
      return this.getRunDetails(runId);
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
    const stack = input.registration.stack;
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
      await this.consumeWithTimeout(adapter, request, timeoutMs, async (event) => {
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
      });
      agentRun = AgentRunSchema.parse({
        ...agentRun,
        runtimeIdentity: {
          ...agentRun.runtimeIdentity,
          ...input.registration.runtimeIdentity,
        },
      });
      this.repository.saveAgentRun(agentRun);
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
      const protocolViolation =
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
      this.repository.saveAgentRun(agentRun);
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

  private async consumeWithTimeout(
    adapter: HarnessAdapter,
    request: ReturnType<typeof HarnessRunRequestSchema.parse>,
    timeoutMs: number,
    onEvent: (event: HarnessEvent) => Promise<void>,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RunTimeoutError()), timeoutMs);
    });
    try {
      const consume = (async () => {
        for await (const event of adapter.run(request)) await onEvent(event);
      })();
      await Promise.race([consume, timeout]);
    } catch (cause) {
      if (cause instanceof RunTimeoutError) await adapter.cancel(request.agentRunId);
      throw cause;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

  async recover(): Promise<void> {
    const lease = this.requireRuntimeLease();
    await this.projects.recoverAbandonedOperations(lease);
    const timestamp = nowIsoTimestamp();
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
export * from './simulation.js';
