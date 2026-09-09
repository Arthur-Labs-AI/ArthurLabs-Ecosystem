import { z } from 'zod';
import {
  ArtifactIdSchema,
  IsoTimestampSchema,
  RelativePathSchema,
  Sha256Schema,
  NonNegativeIntSchema,
} from './primitives.js';
import { ARTIFACT_TYPES } from './enums.js';

export const ArtifactSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    id: ArtifactIdSchema,
    qaRunId: z
      .string()
      .refine((v) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), { message: 'Must be a valid QARunId' })
      .optional(),
    type: z.enum(ARTIFACT_TYPES),
    relativeStoragePath: RelativePathSchema,
    mimeType: z.string().min(1).max(200).optional(),
    sizeBytes: NonNegativeIntSchema.optional(),
    sha256: Sha256Schema.optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
