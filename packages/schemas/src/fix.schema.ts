import { z } from 'zod';
import {
  AgentStackIdSchema,
  ArtifactIdSchema,
  EvidenceIdSchema,
  IsoTimestampSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  Sha256Schema,
} from './primitives.js';
import { FIX_FILE_OPERATIONS, FIX_PROPOSAL_STATUSES, VALIDATION_CHECK_STATUSES } from './enums.js';

export const FixFileChangeSchema = z
  .object({
    relativePath: RelativePathSchema,
    operation: z.enum(FIX_FILE_OPERATIONS),
    previousRelativePath: RelativePathSchema.optional(),
    originalHash: Sha256Schema.optional(),
    proposedHash: Sha256Schema.optional(),
  })
  .strict()
  .refine((c) => c.operation !== 'rename' || c.previousRelativePath !== undefined, {
    message: 'rename requires previousRelativePath',
  });
export type FixFileChange = z.infer<typeof FixFileChangeSchema>;

export const ValidationCheckSchema = z
  .object({
    status: z.enum(VALIDATION_CHECK_STATUSES),
    evidenceIds: z.array(EvidenceIdSchema).default([]),
  })
  .strict();
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

export const FixValidationResultSchema = z
  .object({
    build: ValidationCheckSchema.optional(),
    tests: ValidationCheckSchema.optional(),
    targetedRegression: ValidationCheckSchema.optional(),
  })
  .strict();
export type FixValidationResult = z.infer<typeof FixValidationResultSchema>;

export const FixProposalSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: z.string().refine((v) => /^fix_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid FixProposalId',
    }),
    qaRunId: z.string().refine((v) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid QARunId',
    }),
    unifiedIssueId: z.string().refine((v) => /^issue_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid UnifiedIssueId',
    }),
    sourceSnapshotId: z.string().refine((v) => /^snap_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid SnapshotId',
    }),
    generatedByAgentStackId: AgentStackIdSchema,
    status: z.enum(FIX_PROPOSAL_STATUSES),
    changedFiles: z.array(FixFileChangeSchema).min(1),
    patchArtifactId: ArtifactIdSchema.optional(),
    validation: FixValidationResultSchema.default({}),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type FixProposal = z.infer<typeof FixProposalSchema>;
