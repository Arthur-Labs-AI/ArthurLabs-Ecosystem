import { z } from 'zod';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  EvidenceIdSchema,
  IsoTimestampSchema,
  ProjectContextSnapshotIdSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
  NonNegativeIntSchema,
  UnifiedIssueIdSchema,
  RuntimeInstanceIdSchema,
} from './primitives.js';
import {
  AGENT_RUN_STATUSES,
  AGENT_TASK_TYPES,
  QARUN_STATUSES,
  VERIFICATION_LEVELS,
} from './enums.js';
import { AgentUsageSchema } from './usage.schema.js';
import { ExecutionSafeguardsSchema } from './agent.schema.js';
import { RunInstructionsSchema } from './context.schema.js';

export const DEFAULT_VERIFICATION_LEVEL = 'strict' as const;

export const QARunConfigurationSchema = z
  .object({
    agentStackIds: z.array(AgentStackIdSchema).min(1),
    verificationLevel: z.enum(VERIFICATION_LEVELS),
    instructions: RunInstructionsSchema.optional(),
    policy: z.object({ id: z.string().min(1).max(100), version: z.number().int().min(1) }).strict(),
    executionProfileId: z.string().min(1).max(100).optional(),
    executionSafeguards: ExecutionSafeguardsSchema.optional(),
  })
  .strict();
export type QARunConfiguration = z.infer<typeof QARunConfigurationSchema>;

export const QARunSummarySchema = z
  .object({
    agentRuns: z
      .object({
        configured: NonNegativeIntSchema,
        completed: NonNegativeIntSchema,
        failed: NonNegativeIntSchema,
        interrupted: NonNegativeIntSchema.optional(),
      })
      .strict(),
    findings: z.object({ total: NonNegativeIntSchema }).strict(),
    issues: z
      .object({
        critical: NonNegativeIntSchema,
        high: NonNegativeIntSchema,
        medium: NonNegativeIntSchema,
        low: NonNegativeIntSchema,
        info: NonNegativeIntSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type QARunSummary = z.infer<typeof QARunSummarySchema>;

export const RetestTargetSchema = z
  .object({
    sourceQARunId: QARunIdSchema,
    unifiedIssueId: UnifiedIssueIdSchema,
  })
  .strict();
export type RetestTarget = z.infer<typeof RetestTargetSchema>;

export const RetestResultSchema = z
  .object({
    outcome: z.enum(['fixed', 'still_reproducible', 'partially_fixed', 'inconclusive']),
    evidenceIds: z.array(EvidenceIdSchema).default([]),
    completedAt: IsoTimestampSchema,
  })
  .strict();
export type RetestResult = z.infer<typeof RetestResultSchema>;

/** Phase 7 run lineage (§37). Explicit links between related runs —
 *  e.g. FULL → TARGETED follow-up, occurrence → RETEST run, Retest B →
 *  Retest C. All optional: Phase 1–6 historical rows decode unchanged.
 *  One field per semantic; never overloaded. */
const QARunLineageSchema = z
  .object({
    parentRunId: QARunIdSchema.optional(),
    sourceIssueId: UnifiedIssueIdSchema.optional(),
    sourceOccurrenceId: z
      .string()
      .regex(/^occ_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    sourceRevisionId: ProjectRevisionIdSchema.optional(),
    targetRevisionId: ProjectRevisionIdSchema.optional(),
  })
  .strict();
export type QARunLineage = z.infer<typeof QARunLineageSchema>;

const QARunBaseSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: QARunIdSchema,
    projectId: ProjectIdSchema,
    snapshotId: SnapshotIdSchema,
    projectContextSnapshotId: ProjectContextSnapshotIdSchema,
    runtimeInstanceId: RuntimeInstanceIdSchema.optional(),
    executionKind: z.enum(['simulation', 'production']).optional(),
    status: z.enum(QARUN_STATUSES),
    configuration: QARunConfigurationSchema,
    lineage: QARunLineageSchema.optional(),
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
    summary: QARunSummarySchema.optional(),
  })
  .strict();

/** Production QARun modes: full | targeted (§30-§33). The `retest`
 *  branch below is a LEGACY decoder for historical rows only — production
 *  must never create QARun mode=retest (use RetestRun + child run). */
export const QARunSchema = z.discriminatedUnion('mode', [
  QARunBaseSchema.extend({ mode: z.enum(['full', 'targeted'] as const) }).strict(),
  QARunBaseSchema.extend({
    mode: z.literal('retest'),
    retestTarget: RetestTargetSchema,
    retestResult: RetestResultSchema.optional(),
  }).strict(),
]);

export const CanonicalQARunSchema = QARunBaseSchema.extend({
  mode: z.enum(['full', 'targeted'] as const),
}).strict();
export type QARun = z.infer<typeof QARunSchema>;

export const AgentRuntimeIdentitySchema = z
  .object({
    modelId: z.string().min(1).max(200).optional(),
    modelVersion: z.string().min(1).max(100).optional(),
    adapterId: z.string().min(1).max(100).optional(),
    adapterVersion: z.string().min(1).max(100).optional(),
    harnessVersion: z.string().min(1).max(100).optional(),
    sdkVersion: z.string().min(1).max(100).optional(),
    executable: z.string().min(1).max(2000).optional(),
    executableVersion: z.string().min(1).max(200).optional(),
    policyId: z.string().min(1).max(100).optional(),
    policyVersion: z.number().int().min(1).optional(),
  })
  .strict();
export type AgentRuntimeIdentity = z.infer<typeof AgentRuntimeIdentitySchema>;

export const AgentRunFailureSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
    retryable: z.boolean().default(false),
  })
  .strict();
export type AgentRunFailure = z.infer<typeof AgentRunFailureSchema>;

export const AgentRunSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: AgentRunIdSchema,
    qaRunId: QARunIdSchema,
    agentStackId: AgentStackIdSchema,
    taskType: z.enum(AGENT_TASK_TYPES),
    status: z.enum(AGENT_RUN_STATUSES),
    runtimeIdentity: AgentRuntimeIdentitySchema.optional(),
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
    failure: AgentRunFailureSchema.optional(),
    usage: AgentUsageSchema.optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const requiresFailure =
      run.status === 'failed' || run.status === 'interrupted' || run.status === 'timed_out';
    if (requiresFailure && run.failure === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: run.status + ' AgentRun requires structured failure details',
      });
    }
    if (!requiresFailure && run.failure !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure'],
        message: 'Only failed, interrupted, or timed_out AgentRuns may carry failure details',
      });
    }
  });
export type AgentRun = z.infer<typeof AgentRunSchema>;
