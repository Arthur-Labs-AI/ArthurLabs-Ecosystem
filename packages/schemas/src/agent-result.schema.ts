import { z } from 'zod';
import {
  EVIDENCE_STRENGTHS,
  FINDING_CATEGORIES,
  FINDING_CONFIDENCES,
  FINDING_SEVERITIES,
} from './enums.js';
import { RelativePathSchema } from './primitives.js';

export const SentryInvestigationPlanV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectUnderstanding: z.string().min(1).max(20_000),
    criticalFlows: z.array(z.string().min(1).max(2_000)).max(100),
    weakPoints: z.array(z.string().min(1).max(2_000)).max(100),
    plannedChecks: z.array(z.string().min(1).max(2_000)).min(1).max(200),
  })
  .strict();
export type SentryInvestigationPlanV1 = z.infer<typeof SentryInvestigationPlanV1Schema>;

const CorrelationKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);

export const SentryAgentEvidenceV1Schema = z
  .object({
    key: CorrelationKeySchema,
    type: z.enum(['command', 'runtime', 'code_reference', 'test', 'log', 'manual']),
    strength: z.enum(EVIDENCE_STRENGTHS),
    description: z.string().min(1).max(5_000),
    relativePath: RelativePathSchema.optional(),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
    command: z.string().min(1).max(2_000).optional(),
    exitCode: z.number().int().optional(),
    framework: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(500).optional(),
    status: z.enum(['passed', 'failed']).optional(),
    source: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lineEnd !== undefined && value.lineStart === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lineStart'],
        message: 'lineStart is required with lineEnd',
      });
    }
    if (
      value.lineStart !== undefined &&
      value.lineEnd !== undefined &&
      value.lineEnd < value.lineStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lineEnd'],
        message: 'lineEnd must be >= lineStart',
      });
    }
    if (value.type === 'code_reference' && value.relativePath === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relativePath'],
        message: 'code_reference evidence requires relativePath',
      });
    }
    if (value.type === 'command' && (value.command === undefined || value.exitCode === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'command evidence requires command and exitCode',
      });
    }
    if (
      value.type === 'test' &&
      (value.framework === undefined || value.name === undefined || value.status === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['framework'],
        message: 'test evidence requires framework, name, and status',
      });
    }
  });
export type SentryAgentEvidenceV1 = z.infer<typeof SentryAgentEvidenceV1Schema>;

const SentryAgentFindingV1Schema = z
  .object({
    title: z.string().min(1).max(200),
    category: z.enum(FINDING_CATEGORIES),
    categoryDetail: z.string().min(1).max(200).optional(),
    severity: z.enum(FINDING_SEVERITIES),
    confidence: z.enum(FINDING_CONFIDENCES),
    description: z.string().min(1).max(20_000),
    expectedBehavior: z.string().min(1).max(5_000).optional(),
    actualBehavior: z.string().min(1).max(5_000).optional(),
    locations: z
      .array(
        z
          .object({
            relativePath: RelativePathSchema,
            lineStart: z.number().int().min(1).optional(),
            lineEnd: z.number().int().min(1).optional(),
            symbol: z.string().min(1).max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    evidenceKeys: z.array(CorrelationKeySchema).max(100),
    reproductionSteps: z.array(z.string().min(1).max(2_000)).max(100),
    rootCause: z.string().min(1).max(5_000).optional(),
    recommendedFix: z.string().min(1).max(5_000).optional(),
  })
  .strict();

export const SentryAgentResultV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().min(1).max(20_000),
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(500),
            status: z.enum(['passed', 'failed', 'inconclusive', 'not_run']),
            details: z.string().min(1).max(5_000).optional(),
          })
          .strict(),
      )
      .max(300),
    hypotheses: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            rationale: z.string().min(1).max(10_000),
            relatedPaths: z.array(RelativePathSchema).max(100),
            plannedChecks: z.array(z.string().min(1).max(2_000)).min(1).max(100),
          })
          .strict(),
      )
      .max(100),
    evidence: z.array(SentryAgentEvidenceV1Schema).max(500),
    findings: z.array(SentryAgentFindingV1Schema).max(500),
    limitations: z.array(z.string().min(1).max(2_000)).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const [index, evidence] of value.evidence.entries()) {
      if (keys.has(evidence.key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence', index, 'key'],
          message: 'Evidence keys must be unique',
        });
      keys.add(evidence.key);
    }
    value.findings.forEach((finding, findingIndex) => {
      finding.evidenceKeys.forEach((key, keyIndex) => {
        if (!keys.has(key))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['findings', findingIndex, 'evidenceKeys', keyIndex],
            message: 'Unknown evidence key',
          });
      });
    });
  });
export type SentryAgentResultV1 = z.infer<typeof SentryAgentResultV1Schema>;
