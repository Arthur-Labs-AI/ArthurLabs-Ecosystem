/**
 * Agent Stack: stable product identity (e.g. 'Muse QA Agent') decoupled
 * from replaceable configuration (model version + harness adapter).
 * No hard-coded model unions exist anywhere: provider/modelId/adapterId
 * are open strings validated for shape, never enumerated.
 */
import { z } from 'zod';
import {
  AgentStackIdSchema,
  SchemaVersionSchema,
  NonNegativeIntSchema,
  NonNegativeNumberSchema,
} from './primitives.js';
import { OPERATING_SYSTEMS } from './enums.js';

export const ModelDefinitionSchema = z
  .object({
    provider: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(200).optional(),
    configuration: z.record(z.unknown()).optional(),
  })
  .strict();
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>;

export const HarnessDefinitionSchema = z
  .object({
    adapterId: z.string().min(1).max(100),
    expectedProtocolVersion: z.number().int().min(1),
    configuration: z.record(z.unknown()).optional(),
  })
  .strict();
export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>;

export const ExecutionRequirementsSchema = z
  .object({
    operatingSystem: z.enum(OPERATING_SYSTEMS).optional(),
    requiresDocker: z.boolean().optional(),
    requiresWSL: z.boolean().optional(),
    supportsLocalExecution: z.boolean().optional(),
  })
  .strict();
export type ExecutionRequirements = z.infer<typeof ExecutionRequirementsSchema>;

export const QAPolicyReferenceSchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.number().int().min(1),
  })
  .strict();
export type QAPolicyReference = z.infer<typeof QAPolicyReferenceSchema>;

export const AgentRunLimitsSchema = z
  .object({
    maxDurationMs: NonNegativeIntSchema.optional(),
    maxTurns: NonNegativeIntSchema.optional(),
    maxInputTokens: NonNegativeIntSchema.optional(),
    maxOutputTokens: NonNegativeIntSchema.optional(),
    maxCostUsd: NonNegativeNumberSchema.optional(),
    commandTimeoutMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;

export const AgentStackDefinitionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: AgentStackIdSchema,
    displayName: z.string().min(1).max(200),
    enabled: z.boolean(),
    model: ModelDefinitionSchema,
    harness: HarnessDefinitionSchema,
    execution: ExecutionRequirementsSchema.default({}),
    policy: QAPolicyReferenceSchema,
    limits: AgentRunLimitsSchema.optional(),
  })
  .strict();
export type AgentStackDefinition = z.infer<typeof AgentStackDefinitionSchema>;
