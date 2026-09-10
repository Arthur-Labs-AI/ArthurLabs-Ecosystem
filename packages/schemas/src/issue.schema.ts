import { z } from 'zod';
import {
  AgentStackIdSchema,
  EvidenceIdSchema,
  FindingIdSchema,
  IsoTimestampSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  UnifiedIssueIdSchema,
  VerificationIdSchema,
} from './primitives.js';
import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  ISSUE_AGREEMENT_STATES,
  UNIFIED_ISSUE_STATUSES,
} from './enums.js';

/**
 * UnifiedIssue: platform-level grouping of one or more Findings.
 * References by ID only — never embeds full Finding objects (no cycles).
 */
export const UnifiedIssueSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: UnifiedIssueIdSchema,
    qaRunId: QARunIdSchema,
    title: z.string().min(1).max(200),
    category: z.enum(FINDING_CATEGORIES),
    severity: z.enum(FINDING_SEVERITIES),
    status: z.enum(UNIFIED_ISSUE_STATUSES),
    agreementState: z.enum(ISSUE_AGREEMENT_STATES),
    findingIds: z.array(FindingIdSchema).min(1),
    sourceAgentStackIds: z.array(AgentStackIdSchema).min(1),
    evidenceIds: z.array(EvidenceIdSchema).default([]),
    verificationId: VerificationIdSchema.optional(),
    rootCause: z.string().min(1).max(5000).optional(),
    recommendedFix: z.string().min(1).max(5000).optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type UnifiedIssue = z.infer<typeof UnifiedIssueSchema>;
