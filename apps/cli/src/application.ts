import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  resolveInside,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager, ProjectManagerError } from '@qa/project-manager';
import {
  createFakeHarnessRegistry,
  mergeRun,
  MergeServiceError,
  RunCoordinator,
  RunEngineError,
  VerificationServiceError,
  verifyMerge,
} from '@qa/run-engine';
import { HarnessAdapterRegistry } from '@qa/harness-protocol';
import { createMuseRegistration, doctorMuse, MUSE_SDK_VERSION } from '@qa/harness-muse';
import {
  createDeepSeekRegistration,
  doctorDeepSeek,
  DEEPSEEK_SDK_VERSION,
} from '@qa/harness-deepseek';
import { createGlmRegistration, doctorGlm, CLAUDE_CODE_VERSION } from '@qa/harness-claude-code';
import {
  AgentStackDefinitionSchema,
  CLI_CONTRACT_VERSION,
  CliSuccessEnvelopeSchema,
  ProjectIdSchema,
  QARunIdSchema,
  type AgentRun,
  type CliSuccessEnvelope,
} from '@qa/schemas';
import type { ParsedCliCommand } from './arguments.js';

interface RuntimeContext {
  readonly repository: SentryRepository;
  readonly projects: ProjectManager;
  readonly runs: RunCoordinator;
  readonly dataRoot: string;
}

export interface ExecuteOptions {
  readonly onDiagnostic?: (message: string) => void;
}

async function withReadRuntime<T>(operation: (runtime: RuntimeContext) => Promise<T>): Promise<T> {
  const dataRoot = resolveSentryDataRoot();
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const projects = new ProjectManager(dataRoot, repository);
  const runs = new RunCoordinator(dataRoot, repository);
  try {
    return await operation({ repository, projects, runs, dataRoot });
  } finally {
    database.close();
  }
}

async function withMutationRuntime<T>(
  operation: (runtime: RuntimeContext) => Promise<T>,
  options: ExecuteOptions,
  registry: HarnessAdapterRegistry = new HarnessAdapterRegistry(),
): Promise<T> {
  const dataRoot = resolveSentryDataRoot();
  const database = new SentryDatabase({ dataRoot });
  const repository = new SentryRepository(database);
  const lease = new RuntimeInstanceLease(repository, {
    onHeartbeatError: (error) => options.onDiagnostic?.(error.code + ': ' + error.message),
  });
  let leaseStarted = false;
  try {
    lease.start();
    leaseStarted = true;
    const projects = new ProjectManager(dataRoot, repository, { runtimeLease: lease });
    const runs = new RunCoordinator(dataRoot, repository, lease, registry);
    await runs.recover();
    return await operation({ repository, projects, runs, dataRoot });
  } finally {
    try {
      if (leaseStarted) lease.release();
    } finally {
      database.close();
    }
  }
}

function success(command: CliSuccessEnvelope['command'], data: unknown): CliSuccessEnvelope {
  return CliSuccessEnvelopeSchema.parse({
    schemaVersion: CLI_CONTRACT_VERSION,
    command,
    ok: true,
    data,
  });
}

function boundedRunFailureMessage(message: string): string {
  return message
    .replace(/\b(Bearer)\s+\S+/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

export function summarizeRunStartAgents(
  agentRuns: ReadonlyArray<
    Pick<AgentRun, 'agentStackId' | 'status'> & { readonly failure?: AgentRun['failure'] }
  >,
) {
  return {
    configured: agentRuns.length,
    completed: agentRuns.filter((agent) => agent.status === 'completed').length,
    failed: agentRuns.filter((agent) => agent.status === 'failed').length,
    timedOut: agentRuns.filter((agent) => agent.status === 'timed_out').length,
    interrupted: agentRuns.filter((agent) => agent.status === 'interrupted').length,
    cancelled: agentRuns.filter((agent) => agent.status === 'cancelled').length,
    runs: agentRuns.map((agent) => ({
      agentStackId: agent.agentStackId,
      status: agent.status,
      ...(agent.failure === undefined
        ? {}
        : {
            failure: {
              code: agent.failure.code,
              message: boundedRunFailureMessage(agent.failure.message),
              retryable: agent.failure.retryable,
            },
          }),
    })),
  };
}

export async function executeCommand(
  input: ParsedCliCommand,
  options: ExecuteOptions = {},
): Promise<CliSuccessEnvelope> {
  if (input.command === 'capabilities') {
    return success(input.command, {
      cliContractVersion: 1,
      features: {
        projectLifecycle: true,
        runInspection: true,
        fakeRunSimulation: true,
        realAgentExecution: true,
        retestExecution: false,
        runCancellation: false,
      },
      agentStacks: [
        { id: 'muse', displayName: 'Muse QA Agent', harness: 'muse-code' },
        { id: 'deepseek', displayName: 'DeepSeek QA Agent', harness: 'deepseek-harness' },
        { id: 'glm', displayName: 'GLM QA Agent', harness: 'claude-code' },
      ],
    });
  }
  if (input.command === 'agent.list') {
    const [museHealth, deepseekHealth, glmHealth] = await Promise.all([
      doctorMuse(),
      doctorDeepSeek(),
      doctorGlm(),
    ]);
    const entry = (
      health: {
        readonly checks: ReadonlyArray<{
          readonly name: string;
          readonly status: 'pass' | 'fail' | 'warn';
        }>;
        readonly runtimeVerified?: boolean;
        readonly readiness?: string;
      },
      id: string,
      displayName: string,
      harness: string,
      modelEnvironmentVariable: string,
    ) => {
      const pass = (name: string) =>
        health.checks.some((check) => check.name === name && check.status === 'pass');
      const configured = pass('model') && pass('binary');
      return {
        id,
        displayName,
        harness,
        available: configured,
        configured,
        binaryAvailable: pass('binary'),
        runtimeVerified: health.runtimeVerified ?? false,
        status: health.readiness ?? (configured ? 'configured' : 'unconfigured'),
        modelEnvironmentVariable,
      };
    };
    return success(input.command, {
      agents: [
        entry(museHealth, 'muse', 'Muse QA Agent', 'muse-code', 'SENTRY_MUSE_MODEL'),
        entry(
          deepseekHealth,
          'deepseek',
          'DeepSeek QA Agent',
          'deepseek-harness',
          'SENTRY_DEEPSEEK_MODEL',
        ),
        entry(glmHealth, 'glm', 'GLM QA Agent', 'claude-code', 'SENTRY_GLM_MODEL'),
      ],
    });
  }
  if (input.command === 'agent.doctor') {
    if (input.agent === 'deepseek') {
      const result = await doctorDeepSeek();
      return success(input.command, {
        agent: 'deepseek',
        ...result,
        sdkVersion: DEEPSEEK_SDK_VERSION,
      });
    }
    if (input.agent === 'glm') {
      const result = await doctorGlm();
      return success(input.command, { agent: 'glm', ...result, sdkVersion: CLAUDE_CODE_VERSION });
    }
    const result = await doctorMuse();
    return success(input.command, { agent: 'muse', ...result, sdkVersion: MUSE_SDK_VERSION });
  }
  if (input.command === 'project.add') {
    return withMutationRuntime(async ({ projects }) => {
      const added = await projects.addProject(input.sourcePath);
      return success(input.command, {
        projectId: added.project.id,
        revisionId: added.revision.id,
        ...(added.context === undefined ? {} : { contextSnapshotId: added.context.id }),
      });
    }, options);
  }
  if (input.command === 'project.list') {
    return withReadRuntime(async ({ repository }) => {
      const projects = repository.listProjects().flatMap((project) => {
        const copy = repository.getManagedCopy(project.id);
        if (copy?.currentRevisionId === undefined) return [];
        return [
          {
            projectId: project.id,
            name: project.name,
            state: copy.state,
            currentRevisionId: copy.currentRevisionId,
            sourcePath: project.sourcePath,
            updatedAt: project.updatedAt,
            runCount: repository.countProjectRuns(project.id),
          },
        ];
      });
      return success(input.command, { projects });
    });
  }
  if (input.command === 'project.show') {
    const projectId = ProjectIdSchema.parse(input.projectId);
    return withReadRuntime(async ({ projects }) => {
      const record = projects.getProject(projectId);
      if (record === undefined) {
        throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
      }
      return success(input.command, record);
    });
  }
  if (input.command === 'project.update') {
    const projectId = ProjectIdSchema.parse(input.projectId);
    return withMutationRuntime(async ({ projects }) => {
      const updated = await projects.updateProjectCopy(projectId, input.sourcePath);
      return success(input.command, {
        projectId,
        revisionId: updated.revision.id,
        ...(updated.context === undefined ? {} : { contextSnapshotId: updated.context.id }),
      });
    }, options);
  }
  if (input.command === 'project.delete') {
    const projectId = ProjectIdSchema.parse(input.projectId);
    return withMutationRuntime(async ({ projects }) => {
      await projects.deleteProject(projectId);
      return success(input.command, { projectId, deleted: true });
    }, options);
  }
  if (input.command === 'run.simulate') {
    const projectId = ProjectIdSchema.parse(input.projectId);
    const agentStackIds = input.agents
      ?.split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((name) => (name.startsWith('stack_') ? name : 'stack_' + name + '_main'))
      .map((id) => AgentStackDefinitionSchema.shape.id.parse(id));
    return withMutationRuntime(
      async ({ runs }) => {
        const details = await runs.run(projectId, {
          executionKind: 'simulation',
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(agentStackIds === undefined ? {} : { agentStackIds }),
        });
        return success(input.command, {
          simulated: true,
          runId: details.run.id,
          projectId: details.run.projectId,
          status: details.run.status,
          findings: { total: details.findings.length },
        });
      },
      options,
      createFakeHarnessRegistry(input.scenario),
    );
  }
  if (input.command === 'run.start') {
    const projectId = ProjectIdSchema.parse(input.projectId);
    const registry = new HarnessAdapterRegistry()
      .register(createMuseRegistration())
      .register(createDeepSeekRegistration())
      .register(createGlmRegistration());
    const requestedStackIds = input.agents.map((name) =>
      AgentStackDefinitionSchema.shape.id.parse('stack_' + name + '_main'),
    );
    return withMutationRuntime(
      async ({ runs }) => {
        const details = await runs.run(projectId, {
          executionKind: 'production',
          agentStackIds: requestedStackIds,
          verificationLevel: 'strict',
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.runTimeoutMs === undefined ? {} : { runTimeoutMs: input.runTimeoutMs }),
        });
        return success(input.command, {
          simulated: false,
          runId: details.run.id,
          projectId: details.run.projectId,
          status: details.run.status,
          agents: summarizeRunStartAgents(details.agentRuns),
          findings: { total: details.findings.length },
        });
      },
      options,
      registry,
    );
  }
  if (input.command === 'run.list') {
    const projectId = ProjectIdSchema.parse(input.projectId);
    return withReadRuntime(async ({ runs, repository }) => {
      if (repository.getProject(projectId) === undefined) {
        throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
      }
      return success(input.command, {
        runs: runs.listRuns(projectId).map((run) => ({
          runId: run.id,
          projectId: run.projectId,
          mode: run.mode,
          status: run.status,
          createdAt: run.createdAt,
          ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
          ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
        })),
      });
    });
  }
  if (input.command === 'run.show') {
    const runId = QARunIdSchema.parse(input.runId);
    return withReadRuntime(async ({ runs }) => success(input.command, runs.getRunSummary(runId)));
  }
  if (input.command === 'run.status') {
    const runId = QARunIdSchema.parse(input.runId);
    return withReadRuntime(async ({ runs }) => success(input.command, runs.getRunStatus(runId)));
  }
  if (input.command === 'run.merge') {
    const mergeRunId = QARunIdSchema.parse(input.runId);
    return withMutationRuntime(async ({ repository }) => {
      try {
        const { result, reused } = mergeRun(repository, mergeRunId);
        return success(input.command, {
          runId: mergeRunId,
          mergeResultId: result.id,
          reused,
          clusters: result.clusterCount,
          sourceFindings: result.sourceFindingCount,
          usableAgents: result.usableAgentRunIds.length,
          unavailableAgents: result.unavailableAgentStackIds,
        });
      } catch (cause) {
        if (cause instanceof MergeServiceError) {
          throw new RunEngineError(
            cause.code === 'RUN_NOT_FOUND'
              ? 'RUN_NOT_FOUND'
              : cause.code === 'RUN_NOT_TERMINAL'
                ? 'RUN_NOT_COMPLETE'
                : 'RUN_EXECUTION_FAILED',
            cause.message,
          );
        }
        throw cause;
      }
    }, options);
  }
  if (input.command === 'verify.start') {
    return withMutationRuntime(async ({ repository, dataRoot }) => {
      try {
        const clusterIds =
          input.clusters === undefined
            ? undefined
            : input.clusters
                .split(',')
                .map((id) => id.trim())
                .filter((id) => id.length > 0);
        const { run, attempts } = await verifyMerge(repository, dataRoot, input.mergeResultId, {
          ...(clusterIds === undefined ? {} : { clusterIds }),
        });
        const count = (outcome: string) => attempts.filter((a) => a.outcome === outcome).length;
        return success(input.command, {
          verificationRunId: run.id,
          mergeResultId: run.mergeResultId,
          status: run.status,
          attempts: {
            total: attempts.length,
            reproduced: count('reproduced'),
            partiallyVerified: count('partially_verified'),
            notReproducible: count('not_reproducible'),
            inconclusive: count('inconclusive'),
            failed: attempts.filter((a) => a.status !== 'completed').length,
          },
        });
      } catch (cause) {
        if (cause instanceof VerificationServiceError) {
          throw new RunEngineError(
            cause.code === 'MERGE_RESULT_NOT_FOUND' || cause.code === 'CLUSTER_NOT_FOUND'
              ? 'RUN_NOT_FOUND'
              : cause.code === 'NO_VERIFIABLE_CLUSTERS'
                ? 'RUN_EXECUTION_FAILED'
                : 'RUN_NOT_COMPLETE',
            cause.message,
          );
        }
        throw cause;
      }
    }, options);
  }
  if (input.command === 'verify.show') {
    return withReadRuntime(async ({ repository }) => {
      const run = repository.getVerificationRun(input.verificationRunId);
      if (run === undefined) {
        throw new RunEngineError('RUN_NOT_FOUND', 'VerificationRun not found: ' + input.verificationRunId);
      }
      return success(input.command, {
        run,
        attempts: repository.listVerificationAttempts(run.id).map((attempt) => ({
          ...attempt,
          steps: repository.listVerificationSteps(attempt.id),
          observations: repository.listVerificationObservations(attempt.id),
          assertions: repository.listVerificationAssertions(attempt.id),
        })),
      });
    });
  }
  const runId = QARunIdSchema.parse(input.runId);
  return withMutationRuntime(async ({ runs, repository, dataRoot }) => {
    const manifest = await runs.exportRun(runId, input.format);
    const artifact = repository.getArtifact(manifest.artifactId);
    if (artifact === undefined) throw new Error('Export artifact metadata missing');
    return success(input.command, {
      runId,
      format: input.format,
      artifactId: manifest.artifactId,
      path: resolveInside(dataRoot, artifact.relativeStoragePath),
    });
  }, options);
}
