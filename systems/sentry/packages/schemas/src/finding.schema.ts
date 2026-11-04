import { z } from 'zod';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  EvidenceIdSchema,
  FindingIdSchema,
  IsoTimestampSchema,
  QARunIdSchema,
  SchemaVersionSchema,
} from './primitives.js';
import { FINDING_CATEGORIES, FINDING_CONFIDENCES, FINDING_SEVERITIES } from './enums.js';
import { CodeLocationSchema } from './code-location.schema.js';

const BaseFinding = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: FindingIdSchema,
    qaRunId: QARunIdSchema,
    agentRunId: AgentRunIdSchema,
    sourceAgentStackId: AgentStackIdSchema,
    title: z.string().min(1).max(200),
    categoryDetail: z.string().min(1).max(200).optional(),
    severity: z.enum(FINDING_SEVERITIES),
    confidence: z.enum(FINDING_CONFIDENCES),
    description: z.string().min(1).max(20000),
    expectedBehavior: z.string().min(1).max(5000).optional(),
    actualBehavior: z.string().min(1).max(5000).optional(),
    locations: z.array(CodeLocationSchema).min(1),
    evidenceIds: z.array(EvidenceIdSchema).default([]),
    reproductionSteps: z.array(z.string().min(1).max(2000)).default([]),
    rootCause: z.string().min(1).max(5000).optional(),
    recommendedFix: z.string().min(1).max(5000).optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict();

export const FindingSchema = z.discriminatedUnion('category', [
  BaseFinding.extend({ category: z.literal('build') }),
  BaseFinding.extend({ category: z.literal('runtime') }),
  BaseFinding.extend({ category: z.literal('logic') }),
  BaseFinding.extend({ category: z.literal('api') }),
  BaseFinding.extend({ category: z.literal('frontend') }),
  BaseFinding.extend({ category: z.literal('database') }),
  BaseFinding.extend({ category: z.literal('authentication') }),
  BaseFinding.extend({ category: z.literal('authorization') }),
  BaseFinding.extend({ category: z.literal('security') }),
  BaseFinding.extend({ category: z.literal('configuration') }),
  BaseFinding.extend({ category: z.literal('performance') }),
  BaseFinding.extend({ category: z.literal('concurrency') }),
  BaseFinding.extend({ category: z.literal('dependency') }),
  BaseFinding.extend({ category: z.literal('testing') }),
  BaseFinding.extend({ category: z.literal('cicd') }),
  BaseFinding.extend({ category: z.literal('deployment') }),
  BaseFinding.extend({ category: z.literal('maintainability') }),
  BaseFinding.extend({ category: z.literal('documentation') }),
  BaseFinding.extend({
    category: z.literal('other'),
    categoryDetail: z.string().min(1).max(200),
  }),
]);
export type Finding = z.infer<typeof FindingSchema>;

export { FINDING_CATEGORIES };
export { CodeLocationSchema, type CodeLocation } from './code-location.schema.js';
