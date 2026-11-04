import { z } from 'zod';
import { NonNegativeIntSchema } from './primitives.js';

/**
 * Agent token/runtime usage. Unknown stays undefined: zero means genuinely zero.
 */
export const AgentUsageSchema = z
  .object({
    inputTokens: NonNegativeIntSchema.optional(),
    outputTokens: NonNegativeIntSchema.optional(),
    cachedInputTokens: NonNegativeIntSchema.optional(),
    turns: NonNegativeIntSchema.optional(),
    durationMs: NonNegativeIntSchema.optional(),
  })
  .strict();
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
