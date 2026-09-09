import { z } from 'zod';
import { NonNegativeIntSchema, NonNegativeNumberSchema } from './primitives.js';

/**
 * Agent usage/cost. Unknown stays undefined: zero means genuinely zero.
 */
export const AgentUsageSchema = z
  .object({
    inputTokens: NonNegativeIntSchema.optional(),
    outputTokens: NonNegativeIntSchema.optional(),
    cachedInputTokens: NonNegativeIntSchema.optional(),
    estimatedCostUsd: NonNegativeNumberSchema.optional(),
    providerReportedCostUsd: NonNegativeNumberSchema.optional(),
    turns: NonNegativeIntSchema.optional(),
    durationMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
