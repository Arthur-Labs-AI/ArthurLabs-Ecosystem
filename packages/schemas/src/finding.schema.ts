import { z } from 'zod';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  EvidenceIdSchema,
  IsoTimestampSchema,
  RelativePathSchema,
  SchemaVersionSchema,
} from './primitives.js';
import { FINDING_CATEGORIES, FINDING_CONFIDENCES, FINDING_SEVERITIES } from './enums.js';

export const CodeLocationSchema = z
  .object({
    relativePath: RelativePathSchema,
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
    symbol: z.string().min(1).max(300).optional(),
    message: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (l) => l.endLine === undefined || (l.startLine !== undefined && l.endLine >= l.startLine),
    {
      message: 'endLine must be >= startLine (and requires startLine)',
    },
  );
export type CodeLocation = z.infer<typeof CodeLocationSchema>;

const BaseFinding = z.object({
  schemaVersion: SchemaVersionSchema,
  id: z.string().refine((v) => /^find_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
    message: 'Must be a valid FindingId',
  }),
  qaRunId: z
    .string()
    .refine((v) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), { message: 'Must be a valid QARunId' }),
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
});

function categoryRule(f: { category?: string; categoryDetail?: string }): boolean {
  if (f.category !== 'other') return f.categoryDetail === undefined || f.categoryDetail.length > 0;
  return true;
}

export const FindingSchema = z
  .discriminatedUnion('category', [
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
  ])
  .and(z.object({}).refine(categoryRule));
export type Finding = z.infer<typeof FindingSchema>;

export { FINDING_CATEGORIES };
