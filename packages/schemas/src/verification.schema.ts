import { z } from 'zod';
import { EvidenceIdSchema, IsoTimestampSchema, SchemaVersionSchema } from './primitives.js';
import { VERIFICATION_STATUSES } from './enums.js';

export const VerificationAttemptSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: z.string().refine((v) => /^verify_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid VerificationId',
    }),
    qaRunId: z.string().refine((v) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid QARunId',
    }),
    unifiedIssueId: z.string().refine((v) => /^issue_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid UnifiedIssueId',
    }),
    status: z.enum(VERIFICATION_STATUSES),
    evidenceIds: z.array(EvidenceIdSchema).default([]),
    notes: z.string().min(1).max(5000).optional(),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type VerificationAttempt = z.infer<typeof VerificationAttemptSchema>;
