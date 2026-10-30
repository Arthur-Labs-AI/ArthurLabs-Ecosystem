import { z } from 'zod';
import { AgentRunFailureSchema, AgentRunSchema } from './run.schema.js';
import {
  ArtifactIdSchema,
  AgentStackIdSchema,
  IsoTimestampSchema,
  ProjectContextSnapshotIdSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  QARunIdSchema,
} from './primitives.js';
import { ManagedProjectCopySchema, ProjectRevisionSchema } from './lifecycle.schema.js';
import { ProjectSchema } from './project.schema.js';
import { ProjectContextSnapshotSchema } from './context.schema.js';
import { QARunSchema } from './run.schema.js';
import { FindingSchema } from './finding.schema.js';
import { EvidenceSchema } from './evidence.schema.js';
import { RunExportManifestSchema } from './activity.schema.js';
import {
  AGENT_RUN_STATUSES,
  MANAGED_PROJECT_COPY_STATES,
  QARUN_MODES,
  QARUN_STATUSES,
} from './enums.js';
import { NonNegativeIntSchema } from './primitives.js';

export const CLI_CONTRACT_VERSION = 1 as const;

export const CLI_COMMANDS = [
  'capabilities',
  'agent.list',
  'agent.doctor',
  'project.add',
  'project.list',
  'project.show',
  'project.update',
  'project.delete',
  'project.revisions',
  'run.simulate',
  'run.start',
  'run.list',
  'run.show',
  'run.status',
  'run.result',
  'run.export',
  'run.cancel',
  'doctor.storage',
  'doctor.cleanup',
  'doctor.config',
  'project.doctor',
] as const;
export const CliCommandSchema = z.enum(CLI_COMMANDS);
export type CliCommand = z.infer<typeof CliCommandSchema>;

export const CLI_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'PROJECT_NOT_FOUND',
  'RUN_NOT_FOUND',
  'RUN_NOT_COMPLETE',
  'PROJECT_LOCKED',
  'ACTIVE_RUN_EXISTS',
  'PROJECT_COPY_DRIFT',
  'PROJECT_SOURCE_NOT_FOUND',
  'PROJECT_SOURCE_UNREADABLE',
  'PROJECT_PATH_OVERLAP',
  'PROJECT_COPY_FAILED',
  'PROJECT_UPDATE_FAILED',
  'PROJECT_DELETE_FAILED',
  'INSUFFICIENT_STORAGE',
  'SQLITE_BUSY',
  'RUNTIME_LEASE_CONFLICT',
  'RUNTIME_LEASE_LOST',
  'HARNESS_PROTOCOL_VIOLATION',
  'RUN_EXECUTION_FAILED',
  'AGENT_STACK_UNAVAILABLE',
  // Historical: Muse harness removed (Muse → OpenCode migration). Codes retained so
  // previously emitted CLI error envelopes still validate; never produced for new runs.
  'OPENCODE_BINARY_NOT_FOUND',
  'OPENCODE_STACK_UNAVAILABLE',
  'OPENCODE_MODEL_NOT_CONFIGURED',
  'OPENCODE_CREDENTIAL_MISSING',
  'OPENCODE_START_FAILED',
  'QA_REPORT_DEADLINE',
  'OPENCODE_AUTH_FAILED',
  'OPENCODE_SANDBOX_UNAVAILABLE',
  'OPENCODE_INVALID_RESULT',
  'OPENCODE_SUBAGENT_FORBIDDEN',
  'OPENCODE_REPORT_TOOL_FORBIDDEN',
  'OPENCODE_CANCEL_FAILED',
  'OPENCODE_PROJECT_CONFIG_ISOLATION_FAILED',
  'OPENCODE_SESSION_MISMATCH',
  'OPENCODE_PROTOCOL_INVALID',
  'OPENCODE_VERSION_MISMATCH',
  'OPENCODE_UPSTREAM_FAILED',
  'MUSE_BINARY_NOT_FOUND',
  'MUSE_STACK_UNAVAILABLE',
  'MUSE_MODEL_NOT_CONFIGURED',
  'MUSE_START_FAILED',
  'MUSE_AUTH_FAILED',
  'MUSE_SANDBOX_UNAVAILABLE',
  'MUSE_INVALID_RESULT',
  'MUSE_SUBAGENT_FORBIDDEN',
  'MUSE_REPORT_TOOL_FORBIDDEN',
  'MUSE_CANCEL_FAILED',
  'DEEPSEEK_BINARY_NOT_FOUND',
  'DEEPSEEK_STACK_UNAVAILABLE',
  'DEEPSEEK_MODEL_NOT_CONFIGURED',
  'DEEPSEEK_START_FAILED',
  'DEEPSEEK_AUTH_FAILED',
  'DEEPSEEK_PROVIDER_FAILED',
  'DEEPSEEK_SANDBOX_UNAVAILABLE',
  'DEEPSEEK_INVALID_RESULT',
  'DEEPSEEK_SUBAGENT_FORBIDDEN',
  'DEEPSEEK_REPORT_TOOL_FORBIDDEN',
  'DEEPSEEK_CANCEL_FAILED',
  'GLM_BINARY_NOT_FOUND',
  'GLM_STACK_UNAVAILABLE',
  'GLM_MODEL_NOT_CONFIGURED',
  'GLM_START_FAILED',
  'GLM_AUTH_FAILED',
  'GLM_SANDBOX_UNAVAILABLE',
  'GLM_INVALID_RESULT',
  'GLM_SUBAGENT_FORBIDDEN',
  'GLM_REPORT_TOOL_FORBIDDEN',
  'GLM_TOOL_LOOP',
  'GLM_TOOL_LOOP_WARNING',
  'GLM_TOOL_PERMISSION_UNAVAILABLE',
  'GLM_CLAUDE_VERSION_UNVERIFIED',
  'GLM_CLAUDE_VERSION_UNSUPPORTED',
  'GLM_CLAUDE_RUNTIME_MISMATCH',
  'GLM_CANCEL_FAILED',
  'GLM_INIT_TIMEOUT',
  'GLM_TURN_TIMEOUT',
  'GLM_PROVIDER_RATE_LIMITED',
  'GLM_PROVIDER_TRANSIENT',
  'GLM_PROVIDER_BAD_REQUEST',
  'GLM_BINARY_START_FAILED',
  'INTERNAL_ERROR',
  'SENTRY_DESKTOP_NOT_RUNNING',
  'PROVIDER_NOT_READY',
  'RUN_MAY_HAVE_STARTED',
  'CLI_COMMAND_FORBIDDEN',
  'RESPONSE_TOO_LARGE',
  'PROTOCOL_VERSION_MISMATCH',
  'EXPORT_TOO_LARGE',
  'RUNTIME_MESSAGE_TOO_LARGE',
] as const;
export const CliErrorCodeSchema = z.enum(CLI_ERROR_CODES);
export type CliErrorCode = z.infer<typeof CliErrorCodeSchema>;

const CliErrorDetailsValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const CliErrorSchema = z
  .object({
    code: CliErrorCodeSchema,
    message: z.string().min(1).max(1000),
    retryable: z.boolean(),
    details: z.record(CliErrorDetailsValueSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.details !== undefined && Object.keys(value.details).length > 20) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['details'],
        message: 'Too many error detail fields',
      });
    }
  });
export type CliError = z.infer<typeof CliErrorSchema>;

export const ProjectMutationResultSchema = z
  .object({
    projectId: ProjectIdSchema,
    revisionId: ProjectRevisionIdSchema,
    contextSnapshotId: ProjectContextSnapshotIdSchema.optional(),
  })
  .strict();
export const ProjectAddResultSchema = ProjectMutationResultSchema;
export const ProjectUpdateResultSchema = ProjectMutationResultSchema;
export type ProjectMutationResult = z.infer<typeof ProjectMutationResultSchema>;

export const ProjectListItemSchema = z
  .object({
    projectId: ProjectIdSchema,
    name: z.string().min(1).max(200),
    state: z.enum(MANAGED_PROJECT_COPY_STATES),
    currentRevisionId: ProjectRevisionIdSchema,
    sourcePath: z.string().min(1).max(2000),
    updatedAt: IsoTimestampSchema,
    runCount: NonNegativeIntSchema,
  })
  .strict();
export const ProjectListResultSchema = z
  .object({ projects: z.array(ProjectListItemSchema) })
  .strict();
export type ProjectListResult = z.infer<typeof ProjectListResultSchema>;

export const ProjectShowResultSchema = z
  .object({
    project: ProjectSchema,
    managedCopy: ManagedProjectCopySchema,
    revision: ProjectRevisionSchema,
    context: ProjectContextSnapshotSchema.optional(),
  })
  .strict();
export type ProjectShowResult = z.infer<typeof ProjectShowResultSchema>;

export const ProjectDeleteResultSchema = z
  .object({ projectId: ProjectIdSchema, deleted: z.literal(true) })
  .strict();
export type ProjectDeleteResult = z.infer<typeof ProjectDeleteResultSchema>;

export const RunListItemSchema = z
  .object({
    runId: QARunIdSchema,
    projectId: ProjectIdSchema,
    mode: z.enum(QARUN_MODES),
    status: z.enum(QARUN_STATUSES),
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export const RunListResultSchema = z.object({ runs: z.array(RunListItemSchema) }).strict();
export type RunListResult = z.infer<typeof RunListResultSchema>;

export const RunRecordCountsSchema = z
  .object({
    agentRuns: NonNegativeIntSchema,
    findings: NonNegativeIntSchema,
    evidence: NonNegativeIntSchema,
    activities: NonNegativeIntSchema,
    events: NonNegativeIntSchema,
    exports: NonNegativeIntSchema,
  })
  .strict();

export const RunShowResultSchema = z
  .object({
    run: QARunSchema,
    agentRuns: z.array(AgentRunSchema),
    findings: z.array(FindingSchema),
    evidence: z.array(EvidenceSchema),
    exports: z.array(RunExportManifestSchema),
    counts: RunRecordCountsSchema,
  })
  .strict();
export type RunShowResult = z.infer<typeof RunShowResultSchema>;

const AgentStatusCountsShape = Object.fromEntries(
  AGENT_RUN_STATUSES.map((status) => [
    status === 'timed_out' ? 'timedOut' : status,
    NonNegativeIntSchema,
  ]),
) as Record<string, typeof NonNegativeIntSchema>;

export const RunAgentStatusCountsSchema = z
  .object({ configured: NonNegativeIntSchema, ...AgentStatusCountsShape })
  .strict();

export const RunTokenTotalsSchema = z
  .object({
    inputTokens: NonNegativeIntSchema.optional(),
    outputTokens: NonNegativeIntSchema.optional(),
    cachedInputTokens: NonNegativeIntSchema.optional(),
    totalTokens: NonNegativeIntSchema.optional(),
    turns: NonNegativeIntSchema.optional(),
  })
  .strict();

export const RunStatusResultSchema = z
  .object({
    runId: QARunIdSchema,
    projectId: ProjectIdSchema,
    mode: z.enum(QARUN_MODES),
    status: z.enum(QARUN_STATUSES),
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.nullable(),
    agents: RunAgentStatusCountsSchema,
    findings: z.object({ total: NonNegativeIntSchema }).strict(),
    tokens: RunTokenTotalsSchema.optional(),
  })
  .strict();
export type RunStatusResult = z.infer<typeof RunStatusResultSchema>;

export const RunSimulateResultSchema = z
  .object({
    simulated: z.literal(true),
    runId: QARunIdSchema,
    projectId: ProjectIdSchema,
    status: z.enum(QARUN_STATUSES),
    findings: z.object({ total: NonNegativeIntSchema }).strict(),
  })
  .strict();
export type RunSimulateResult = z.infer<typeof RunSimulateResultSchema>;

export const RunStartResultSchema = z
  .object({
    simulated: z.literal(false),
    runId: QARunIdSchema,
    projectId: ProjectIdSchema,
    status: z.enum(QARUN_STATUSES),
    // Async automation flow: runId + operationId return as soon as the row
    // exists while the WSL runtime owns the run. The per-agent breakdown
    // and findings arrive after terminal status (or via --wait).
    operationId: z.string().min(1).max(200).optional(),
    agents: z
      .object({
        configured: NonNegativeIntSchema,
        completed: NonNegativeIntSchema,
        failed: NonNegativeIntSchema,
        timedOut: NonNegativeIntSchema,
        interrupted: NonNegativeIntSchema,
        cancelled: NonNegativeIntSchema,
        runs: z.array(
          z
            .object({
              agentStackId: AgentStackIdSchema,
              status: z.enum(AGENT_RUN_STATUSES),
              failure: AgentRunFailureSchema.extend({ message: z.string().min(1).max(500) })
                .strict()
                .optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    findings: z.object({ total: NonNegativeIntSchema }).strict().optional(),
  })
  .strict();
export type RunStartResult = z.infer<typeof RunStartResultSchema>;

export const AgentReadinessSchema = z.enum([
  'unconfigured',
  'configured',
  'ready',
  'degraded',
  'unavailable',
]);
export type AgentReadiness = z.infer<typeof AgentReadinessSchema>;

export const AgentListResultSchema = z
  .object({
    agents: z.array(
      z
        .object({
          id: z.string().min(1).max(100),
          displayName: z.string().min(1).max(200),
          harness: z.string().min(1).max(100),
          // Legacy boolean kept for contract stability: true only when model
          // + binary are present (NOT proof of live authentication).
          available: z.boolean(),
          configured: z.boolean().optional(),
          binaryAvailable: z.boolean().optional(),
          runtimeVerified: z.boolean().optional(),
          status: AgentReadinessSchema.optional(),
          modelEnvironmentVariable: z.string().min(1).max(100),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentListResult = z.infer<typeof AgentListResultSchema>;

export const AgentDoctorResultSchema = z
  .object({
    // 'muse' retained historically: old envelopes still validate.
    agent: z.enum(['muse', 'opencode', 'deepseek', 'glm']),
    status: z.enum(['healthy', 'degraded', 'unavailable']),
    checks: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(['pass', 'warn', 'fail']),
          message: z.string().optional(),
        })
        .strict(),
    ),
    checkedAt: IsoTimestampSchema,
    executable: z.string().optional(),
    executableSource: z.enum(['explicit', 'environment', 'managed', 'path']).optional(),
    executableVersion: z.string().optional(),
    modelId: z.string().optional(),
    provider: z.string().optional(),
    // sdkVersion names the pinned SDK where one exists (deepseek/glm).
    // The SDK-less OpenCode harness reports testedVersion instead.
    sdkVersion: z.string().optional(),
    testedVersion: z.string().optional(),
    credentialConfigured: z.boolean().optional(),
    readiness: AgentReadinessSchema.optional(),
    configured: z.boolean().optional(),
    binaryAvailable: z.boolean().optional(),
    runtimeVerified: z.boolean().optional(),
  })
  .strict();
export type AgentDoctorResult = z.infer<typeof AgentDoctorResultSchema>;

export const RunResultResultSchema = z
  .object({
    runId: QARunIdSchema,
    format: z.literal('json'),
    // The canonical structured JSON result for exactly this run, decoded
    // from the runtime runs.exportContent bytes. No competing format.
    result: z.unknown(),
  })
  .strict();
export type RunResultResult = z.infer<typeof RunResultResultSchema>;

export const RunExportResultSchema = z
  .object({
    runId: QARunIdSchema,
    format: z.enum(['log', 'json']),
    // Broker-mediated exports materialize bytes at the requested --out
    // path; there is no Windows artifact path to report.
    artifactId: ArtifactIdSchema.optional(),
    path: z.string().min(1).max(2000),
  })
  .strict();
export type RunExportResult = z.infer<typeof RunExportResultSchema>;

export const RunCancelResultSchema = z
  .object({
    runId: QARunIdSchema,
    status: z.enum(['cancellation_requested', 'cancelled', 'already_terminal']),
    cancelledAgents: NonNegativeIntSchema,
    ownerAcknowledged: z.boolean().optional(),
    findings: z.object({ total: NonNegativeIntSchema }).strict(),
  })
  .strict();
export type RunCancelResult = z.infer<typeof RunCancelResultSchema>;

export const ProjectRevisionsResultSchema = z
  .object({
    projectId: ProjectIdSchema,
    currentRevisionId: ProjectRevisionIdSchema,
    revisions: z.array(
      z
        .object({
          revisionId: ProjectRevisionIdSchema,
          importedAt: IsoTimestampSchema,
          contentHash: z.string().min(1).max(200),
          current: z.boolean(),
          runIds: z.array(QARunIdSchema),
        })
        .strict(),
    ),
  })
  .strict();
export type ProjectRevisionsResult = z.infer<typeof ProjectRevisionsResultSchema>;

export const OrphanReportSchema = z
  .object({
    pathClass: z.literal('agent_workspace'),
    path: z.string().min(1).max(2000),
    ageMs: NonNegativeIntSchema,
    reason: z.string().min(1).max(500),
  })
  .strict();

export const DoctorStorageResultSchema = z
  .object({
    dataRoot: z.string().min(1).max(2000),
    databaseBytes: NonNegativeIntSchema,
    artifactFiles: NonNegativeIntSchema,
    artifactBytes: NonNegativeIntSchema,
    projectsBytes: NonNegativeIntSchema,
    projects: NonNegativeIntSchema,
    revisions: NonNegativeIntSchema,
    runs: NonNegativeIntSchema,
    orphans: z.array(OrphanReportSchema),
  })
  .strict();
export type DoctorStorageResult = z.infer<typeof DoctorStorageResultSchema>;

export const DoctorCleanupResultSchema = z
  .object({
    applied: z.boolean(),
    operationId: z.string().min(1).max(200),
    orphans: z.array(
      OrphanReportSchema.extend({
        removed: z.boolean(),
        detail: z.string().min(1).max(500).optional(),
      }).strict(),
    ),
  })
  .strict();
export type DoctorCleanupResult = z.infer<typeof DoctorCleanupResultSchema>;

export const DoctorConfigResultSchema = z
  .object({
    dataRoot: z.string().min(1).max(2000),
    cliContractVersion: z.literal(CLI_CONTRACT_VERSION),
    defaultAgents: z.array(z.string().min(1).max(100)),
    runTimeoutMs: NonNegativeIntSchema,
    simulationTimeoutMs: NonNegativeIntSchema,
    orphanMinAgeMs: NonNegativeIntSchema,
    sandboxBackend: z.string().min(1).max(100),
    supportedPlatforms: z.array(z.string().min(1).max(50)),
  })
  .strict();
export type DoctorConfigResult = z.infer<typeof DoctorConfigResultSchema>;

export const ProjectDoctorResultSchema = z
  .object({
    projectId: ProjectIdSchema,
    ready: z.boolean(),
    managedCopyState: z.string().min(1).max(100),
    currentRevisionId: ProjectRevisionIdSchema.optional(),
    revisionCount: NonNegativeIntSchema,
    runCount: NonNegativeIntSchema,
    detectedEcosystem: z.array(z.string().min(1).max(100)),
    runtimes: z.array(
      z.object({ name: z.string().min(1).max(100), available: z.boolean() }).strict(),
    ),
    sandbox: z
      .object({
        sandboxAvailable: z.boolean(),
        reason: z.string().min(1).max(500).optional(),
      })
      .strict(),
    warnings: z.array(z.string().min(1).max(1000)),
  })
  .strict();
export type ProjectDoctorResult = z.infer<typeof ProjectDoctorResultSchema>;

export const CapabilitiesResultSchema = z
  .object({
    cliContractVersion: z.literal(CLI_CONTRACT_VERSION),
    features: z
      .object({
        projectLifecycle: z.literal(true),
        runInspection: z.literal(true),
        fakeRunSimulation: z.literal(true),
        realAgentExecution: z.literal(true),
        runCancellation: z.literal(true),
        targetedExecution: z.literal(true),
      })
      .strict(),
    // Additive Phase 4 extension: stable stack identities with their
    // harness bindings. Optional so older machine consumers keep parsing.
    agentStacks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            displayName: z.string().min(1).max(200),
            harness: z.string().min(1).max(100),
          })
          .strict(),
      )
      .optional(),
    // Automation clients probe these before issuing commands. Optional so older
    // machine consumers keep parsing.
    runResultExport: z.literal(true).optional(),
    runCancellation: z.literal(true).optional(),
    asyncRunStart: z.literal(true).optional(),
    ipcProtocolVersion: z.number().int().optional(),
    productVersion: z.string().min(1).max(100).optional(),
    // Production truth: which commands the Desktop broker actually serves.
    // `features.fakeRunSimulation` stays true for contract history (it
    // describes the direct/development transport); clients must consult
    // productionCommands to decide what production `sentry cli` supports.
    productionCommands: z
      .object({
        runSimulation: z.literal(false),
        realRunExecution: z.literal(true),
        runResult: z.literal(true),
        runExport: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CapabilitiesResult = z.infer<typeof CapabilitiesResultSchema>;

export const CliResultSchemas = {
  capabilities: CapabilitiesResultSchema,
  'agent.list': AgentListResultSchema,
  'agent.doctor': AgentDoctorResultSchema,
  'project.add': ProjectAddResultSchema,
  'project.list': ProjectListResultSchema,
  'project.show': ProjectShowResultSchema,
  'project.update': ProjectUpdateResultSchema,
  'project.delete': ProjectDeleteResultSchema,
  'run.simulate': RunSimulateResultSchema,
  'run.start': RunStartResultSchema,
  'run.list': RunListResultSchema,
  'run.show': RunShowResultSchema,
  'run.status': RunStatusResultSchema,
  'run.result': RunResultResultSchema,
  'run.export': RunExportResultSchema,
  'run.cancel': RunCancelResultSchema,
  'project.revisions': ProjectRevisionsResultSchema,
  'doctor.storage': DoctorStorageResultSchema,
  'doctor.cleanup': DoctorCleanupResultSchema,
  'doctor.config': DoctorConfigResultSchema,
  'project.doctor': ProjectDoctorResultSchema,
} as const;

function successEnvelope<C extends CliCommand>(
  command: C,
  dataSchema: (typeof CliResultSchemas)[C],
) {
  return z
    .object({
      schemaVersion: z.literal(CLI_CONTRACT_VERSION),
      command: z.literal(command),
      ok: z.literal(true),
      data: dataSchema,
    })
    .strict();
}

export type CliSuccessEnvelope = {
  [C in CliCommand]: {
    readonly schemaVersion: typeof CLI_CONTRACT_VERSION;
    readonly command: C;
    readonly ok: true;
    readonly data: z.infer<(typeof CliResultSchemas)[C]>;
  };
}[CliCommand];

export const CliSuccessEnvelopeSchema = z.union(
  CLI_COMMANDS.map((command) => successEnvelope(command, CliResultSchemas[command])) as [
    ReturnType<typeof successEnvelope>,
    ReturnType<typeof successEnvelope>,
    ...ReturnType<typeof successEnvelope>[],
  ],
) as z.ZodType<CliSuccessEnvelope>;

export const CliErrorEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(CLI_CONTRACT_VERSION),
    command: z.union([CliCommandSchema, z.literal('unknown')]),
    ok: z.literal(false),
    error: CliErrorSchema,
  })
  .strict();
export type CliErrorEnvelope = z.infer<typeof CliErrorEnvelopeSchema>;

export const CliEnvelopeSchema = z.union([CliSuccessEnvelopeSchema, CliErrorEnvelopeSchema]);
export type CliEnvelope = z.infer<typeof CliEnvelopeSchema>;
