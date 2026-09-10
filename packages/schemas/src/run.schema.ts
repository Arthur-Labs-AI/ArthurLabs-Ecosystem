import { z } from 'zod';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  IsoTimestampSchema,
  ProjectIdSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
  NonNegativeIntSchema,
  NonNegativeNumberSchema,
} from './primitives.js';
import {
  AGENT_RUN_STATUSES,
  AGENT_TASK_TYPES,
  QARUN_MODES,
  QARUN_STATUSES,
  VERIFICATION_LEVELS,
} from './enums.js';
import { AgentUsageSchema } from './usage.schema.js';

export const QARunConfigurationSchema = z
  .object({
    agentStackIds: z.array(AgentStackIdSchema).min(1),
    verificationLevel: z.enum(VERIFICATION_LEVELS),
    policy: z.object({ id: z.string().min(1).max(100), version: z.number().int().min(1) }).strict(),
    executionProfileId: z.string().min(1).max(100).optional(),
    limits: z
      .object({
        maxTotalCostUsd: NonNegativeNumberSchema.optional(),
        maxDurationMs: NonNegativeIntSchema.optional(),
      })
      .strict()
      .optional(),
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

export const QARunSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: QARunIdSchema,
    projectId: ProjectIdSchema,
    snapshotId: SnapshotIdSchema,
    mode: z.enum(QARUN_MODES),
    status: z.enum(QARUN_STATUSES),
    configuration: QARunConfigurationSchema,
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
    summary: QARunSummarySchema.optional(),
  })
  .strict();
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
  .strict();
export type AgentRun = z.infer<typeof AgentRunSchema>;
