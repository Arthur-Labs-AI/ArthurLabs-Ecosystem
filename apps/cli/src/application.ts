// Development-only direct execution (SENTRY_CLI_TRANSPORT=direct). This module
// opens the Windows database and constructs RunCoordinator/harness adapters
// for deterministic local tests. It is NOT the production path: production
// `sentry cli` always goes through the Desktop broker (frontend-application).
import {
  SentryDatabase,
  SentryRepository,
  RuntimeInstanceLease,
  resolveInside,
  resolveSentryDataRoot,
} from '@qa/persistence';
import { ProjectManager, ProjectManagerError } from '@qa/project-manager';
import { createFakeHarnessRegistry, RunCoordinator } from '@qa/run-engine';
import { HarnessAdapterRegistry } from '@qa/harness-protocol';
import {
  createOpenCodeRegistration,
  doctorOpenCode,
  OPENCODE_TESTED_VERSION,
} from '@qa/harness-opencode';
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
  type CliSuccessEnvelope,
} from '@qa/schemas';
import type { ParsedCliCommand } from './arguments.js';
import { CliUsageError } from './arguments.js';
import { summarizeRunStartAgents } from './run-summary.js';

/** Parse user-supplied CLI arguments: Zod failures here are genuinely
 *  invalid arguments. Internal domain/persistence Zod failures must NOT
 *  route through here — they fall to the execution-failure envelope.
 *  (Live evidence: an internal fingerprint overflow was misreported as
 *  INVALID_ARGUMENT, hiding the real defect.) */
function parseArgument<T>(schema: { parse(value: unknown): T }, value: unknown, name: string): T {
  try {
    return schema.parse(value);
  } catch {
    throw new CliUsageError('Invalid ' + name + ': ' + String(value).slice(0, 200));
  }
}
import { cleanupReport, configReport, projectDoctor, storageReport } from './doctors.js';

interface RuntimeContext {
  readonly repository: SentryRepository;
  readonly projects: ProjectManager;
  readonly runs: RunCoordinator;
  readonly dataRoot: string;
  readonly lease?: RuntimeInstanceLease;
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
    return await operation({ repository, projects, runs, dataRoot, lease });
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

export { summarizeRunStartAgents } from './run-summary.js';

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
        runCancellation: true,
        targetedExecution: true,
      },
      agentStacks: [
        { id: 'opencode', displayName: 'OpenCode QA Agent', harness: 'opencode' },
        { id: 'deepseek', displayName: 'DeepSeek QA Agent', harness: 'deepseek-harness' },
        { id: 'glm', displayName: 'GLM QA Agent', harness: 'claude-code' },
      ],
    });
  }
  if (input.command === 'agent.list') {
    const [opencodeHealth, deepseekHealth, glmHealth] = await Promise.all([
      doctorOpenCode(),
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
        entry(opencodeHealth, 'opencode', 'OpenCode QA Agent', 'opencode', 'SENTRY_OPENCODE_MODEL'),
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
    if (input.agent === 'opencode') {
      const result = await doctorOpenCode();
      return success(input.command, {
        agent: 'opencode',
        ...result,
        testedVersion: OPENCODE_TESTED_VERSION,
      });
    }
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
    throw new CliUsageError('Unknown agent: ' + input.agent);
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
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
    return withReadRuntime(async ({ projects }) => {
      const record = projects.getProject(projectId);
      if (record === undefined) {
        throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
      }
      return success(input.command, record);
    });
  }
  if (input.command === 'project.update') {
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
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
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
    return withMutationRuntime(async ({ projects }) => {
      await projects.deleteProject(projectId);
      return success(input.command, { projectId, deleted: true });
    }, options);
  }
  if (input.command === 'run.simulate') {
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
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
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
    const registry = new HarnessAdapterRegistry()
      .register(createOpenCodeRegistration())
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
          ...(input.mode === 'targeted'
            ? {
                mode: 'targeted' as const,
                target: {
                  includePaths: (input.paths ?? '')
                    .split(',')
                    .map((value) => value.trim())
                    .filter((value) => value.length > 0),
                  ...(input.instructions === undefined
                    ? {}
                    : { userInstructions: input.instructions }),
                },
              }
            : {}),
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
          ...(input.runTimeoutMs === undefined ? {} : { runTimeoutMs: input.runTimeoutMs }),
          ...(input.webAccess === true ? { webAccess: true } : {}),
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
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
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
    const runId = parseArgument(QARunIdSchema, input.runId, 'run-id');
    return withReadRuntime(async ({ runs }) => success(input.command, runs.getRunSummary(runId)));
  }
  if (input.command === 'run.status') {
    const runId = parseArgument(QARunIdSchema, input.runId, 'run-id');
    return withReadRuntime(async ({ runs }) => success(input.command, runs.getRunStatus(runId)));
  }
  if (input.command === 'run.cancel') {
    const runId = parseArgument(QARunIdSchema, input.runId, 'run-id');
    return withMutationRuntime(async ({ runs, repository }) => {
      // Finish-pass request-only: a foreign CLI persists the durable request
      // and stops. Only the owning runtime terminalizes live execution.
      // CLI_CONTRACT_VERSION stays 1 (additive shape).
      const outcome = runs.requestRunCancellation(runId);
      return success(input.command, {
        runId: outcome.runId,
        status: outcome.status,
        cancelledAgents: outcome.cancelledAgents,
        ownerAcknowledged: outcome.ownerAcknowledged,
        findings: { total: repository.countRunFindings(runId) },
      });
    }, options);
  }
  if (input.command === 'project.revisions') {
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
    return withReadRuntime(async ({ projects, repository }) => {
      const record = projects.getProject(projectId);
      if (record === undefined) {
        throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
      }
      const runsByRevision = new Map<string, string[]>();
      for (const run of repository.listRuns(projectId)) {
        const snapshot = repository.getSnapshot(run.snapshotId);
        if (snapshot === undefined) continue;
        const list = runsByRevision.get(snapshot.projectRevisionId) ?? [];
        list.push(run.id);
        runsByRevision.set(snapshot.projectRevisionId, list);
      }
      return success(input.command, {
        projectId,
        currentRevisionId: record.revision.id,
        revisions: repository.listRevisions(projectId).map((revision) => ({
          revisionId: revision.id,
          importedAt: revision.importedAt,
          contentHash: revision.contentHash,
          current: revision.id === record.revision.id,
          runIds: runsByRevision.get(revision.id) ?? [],
        })),
      });
    });
  }
  if (input.command === 'doctor.storage') {
    return withReadRuntime(async ({ repository, dataRoot }) => {
      const report = await storageReport({ dataRoot, repository });
      return success(input.command, {
        dataRoot: report.dataRoot,
        databaseBytes: report.databaseBytes,
        artifactFiles: report.artifactFiles,
        artifactBytes: report.artifactBytes,
        projectsBytes: report.projectsBytes,
        projects: report.projects,
        revisions: report.revisions,
        runs: report.runs,
        orphans: report.orphans,
      });
    });
  }
  if (input.command === 'doctor.cleanup') {
    return withMutationRuntime(async ({ repository, dataRoot }) => {
      const report = await cleanupReport({ dataRoot, repository }, { apply: input.apply });
      return success(input.command, report);
    }, options);
  }
  if (input.command === 'doctor.config') {
    return withReadRuntime(async ({ dataRoot }) => success(input.command, configReport(dataRoot)));
  }
  if (input.command === 'project.doctor') {
    const projectId = parseArgument(ProjectIdSchema, input.projectId, 'project-id');
    return withReadRuntime(async ({ repository, dataRoot }) => {
      try {
        const report = await projectDoctor({ dataRoot, repository, projectId });
        return success(input.command, report);
      } catch (cause) {
        if (cause instanceof Error && cause.message.startsWith('PROJECT_NOT_FOUND')) {
          throw new ProjectManagerError('PROJECT_NOT_FOUND', 'Project not found: ' + projectId);
        }
        throw cause;
      }
    });
  }
  if (input.command === 'run.result') {
    const resultRunId = parseArgument(QARunIdSchema, input.runId, 'run-id');
    return withReadRuntime(async ({ runs }) => {
      const exported = (await runs.exportContent(resultRunId, 'json')) as {
        contentBase64?: string;
      };
      if (typeof exported.contentBase64 !== 'string') throw new Error('Export bytes missing');
      return success(input.command, {
        runId: resultRunId,
        format: 'json' as const,
        result: JSON.parse(
          Buffer.from(exported.contentBase64, 'base64').toString('utf8'),
        ) as unknown,
      });
    });
  }
  if (input.command !== 'run.export') throw new CliUsageError('Unknown command');
  const runId = parseArgument(QARunIdSchema, input.runId, 'run-id');
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
