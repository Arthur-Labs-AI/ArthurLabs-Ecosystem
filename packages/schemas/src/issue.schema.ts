import { z } from 'zod';
import {
  AgentStackIdSchema,
  EvidenceIdSchema,
  FindingIdSchema,
  IsoTimestampSchema,
  SchemaVersionSchema,
} from './primitives.js';
import { FINDING_CATEGORIES, FINDING_SEVERITIES, UNIFIED_ISSUE_STATUSES } from './enums.js';

/**
 * UnifiedIssue: platform-level grouping of one or more Findings.
 * References by ID only — never embeds full Finding objects (no cycles).
 */
export const UnifiedIssueSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: z.string().refine((v) => /^issue_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid UnifiedIssueId',
    }),
    qaRunId: z.string().refine((v) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid QARunId',
    }),
    title: z.string().min(1).max(200),
    category: z.enum(FINDING_CATEGORIES),
    severity: z.enum(FINDING_SEVERITIES),
    status: z.enum(UNIFIED_ISSUE_STATUSES),
    findingIds: z.array(FindingIdSchema).min(1),
    sourceAgentStackIds: z.array(AgentStackIdSchema).min(1),
    evidenceIds: z.array(EvidenceIdSchema).default([]),
    verificationId: z
      .string()
      .refine((v) => /^verify_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
        message: 'Must be a valid VerificationId',
      })
      .optional(),
    rootCause: z.string().min(1).max(5000).optional(),
    recommendedFix: z.string().min(1).max(5000).optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type UnifiedIssue = z.infer<typeof UnifiedIssueSchema>;
