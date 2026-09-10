import { z } from 'zod';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  EvidenceIdSchema,
  IsoTimestampSchema,
  ProjectContextSnapshotIdSchema,
  ProjectIdSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
  NonNegativeIntSchema,
  UnifiedIssueIdSchema,
} from './primitives.js';
import {
  AGENT_RUN_STATUSES,
  AGENT_TASK_TYPES,
  QARUN_MODES,
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

const QARunBaseSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: QARunIdSchema,
    projectId: ProjectIdSchema,
    snapshotId: SnapshotIdSchema,
    projectContextSnapshotId: ProjectContextSnapshotIdSchema,
    status: z.enum(QARUN_STATUSES),
    configuration: QARunConfigurationSchema,
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
    summary: QARunSummarySchema.optional(),
  })
  .strict();

const STANDARD_QA_RUN_MODES = QARUN_MODES.filter((mode) => mode !== 'retest') as [
  Exclude<(typeof QARUN_MODES)[number], 'retest'>,
  ...Exclude<(typeof QARUN_MODES)[number], 'retest'>[],
];

export const QARunSchema = z.discriminatedUnion('mode', [
  QARunBaseSchema.extend({ mode: z.enum(STANDARD_QA_RUN_MODES) }).strict(),
  QARunBaseSchema.extend({
    mode: z.literal('retest'),
    retestTarget: RetestTargetSchema,
    retestResult: RetestResultSchema.optional(),
  }).strict(),
]);
export type QARun = z.infer<typeof QARunSchema>;

export const AgentRuntimeIdentitySchema = z
  .object({
    modelId: z.string().min(1).max(200).optional(),
    modelVersion: z.string().min(1).max(100).optional(),
    adapterId: z.string().min(1).max(100).optional(),
    adapterVersion: z.string().min(1).max(100).optional(),
    harnessVersion: z.string().min(1).max(100).optional(),
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
