import { z } from 'zod';
import {
  AgentStackIdSchema,
  ArtifactIdSchema,
  FixProposalIdSchema,
  IsoTimestampSchema,
  QARunIdSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
  UnifiedIssueIdSchema,
} from './primitives.js';
import { FIX_FILE_OPERATIONS } from './enums.js';

export const SuggestedFileChangeSchema = z
  .object({
    relativePath: RelativePathSchema,
    operation: z.enum(FIX_FILE_OPERATIONS),
    description: z.string().min(1).max(5000),
    previousRelativePath: RelativePathSchema.optional(),
  })
  .strict()
  .refine((c) => c.operation !== 'rename' || c.previousRelativePath !== undefined, {
    message: 'rename requires previousRelativePath',
  });
export type SuggestedFileChange = z.infer<typeof SuggestedFileChangeSchema>;

/** Advisory output only. It carries no permission or ability to modify a project. */
export const FixProposalSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: FixProposalIdSchema,
    qaRunId: QARunIdSchema,
    unifiedIssueId: UnifiedIssueIdSchema,
    sourceSnapshotId: SnapshotIdSchema,
    generatedByAgentStackId: AgentStackIdSchema,
    summary: z.string().min(1).max(5000),
    rationale: z.string().min(1).max(10_000),
    suggestedChanges: z.array(SuggestedFileChangeSchema).min(1),
    affectedPaths: z.array(RelativePathSchema).min(1),
    suggestedPatchArtifactId: ArtifactIdSchema.optional(),
    suggestedRegressionTests: z.array(z.string().min(1).max(2000)).default([]),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type FixProposal = z.infer<typeof FixProposalSchema>;
