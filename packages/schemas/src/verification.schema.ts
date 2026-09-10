import { z } from 'zod';
import {
  EvidenceIdSchema,
  IsoTimestampSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  UnifiedIssueIdSchema,
  VerificationIdSchema,
} from './primitives.js';
import { VERIFICATION_STATUSES } from './enums.js';

export const VerificationAttemptSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: VerificationIdSchema,
    qaRunId: QARunIdSchema,
    unifiedIssueId: UnifiedIssueIdSchema,
    status: z.enum(VERIFICATION_STATUSES),
    evidenceIds: z.array(EvidenceIdSchema).default([]),
    notes: z.string().min(1).max(5000).optional(),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type VerificationAttempt = z.infer<typeof VerificationAttemptSchema>;
