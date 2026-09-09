/**
 * Harness run-request DTOs. These cross the QA Core -> harness boundary,
 * so their Zod schemas live here (source of truth) and
 * @qa/harness-protocol re-exports them alongside the adapter contract.
 */
import { z } from 'zod';
import { AgentRunIdSchema, SchemaVersionSchema } from './primitives.js';
import { AgentRunLimitsSchema, ModelDefinitionSchema } from './agent.schema.js';
import { AGENT_TASK_TYPES } from './enums.js';

export const HarnessWorkspaceSchema = z
  .object({
    runtimePath: z.string().min(1).max(2000),
    snapshotId: z.string().refine((v) => /^snap_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid SnapshotId',
    }),
    writable: z.boolean(),
  })
  .strict();
export type HarnessWorkspace = z.infer<typeof HarnessWorkspaceSchema>;

export const HarnessTaskSchema = z
  .object({
    type: z.enum(AGENT_TASK_TYPES),
    prompt: z.string().min(1).max(100000),
    policyId: z.string().min(1).max(100),
    policyVersion: z.number().int().min(1),
    context: z.record(z.unknown()).optional(),
  })
  .strict();
export type HarnessTask = z.infer<typeof HarnessTaskSchema>;

export const HarnessRunRequestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    agentRunId: AgentRunIdSchema,
    qaRunId: z.string().refine((v) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid QARunId',
    }),
    workspace: HarnessWorkspaceSchema,
    model: ModelDefinitionSchema,
    task: HarnessTaskSchema,
    limits: AgentRunLimitsSchema.optional(),
  })
  .strict();
export type HarnessRunRequest = z.infer<typeof HarnessRunRequestSchema>;
