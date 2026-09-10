import { z } from 'zod';
import {
  ArtifactIdSchema,
  IsoTimestampSchema,
  ProjectIdSchema,
  QARunIdSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  Sha256Schema,
  NonNegativeIntSchema,
} from './primitives.js';
import { ARTIFACT_TYPES } from './enums.js';

export const ArtifactSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: ArtifactIdSchema,
    projectId: ProjectIdSchema.optional(),
    qaRunId: QARunIdSchema.optional(),
    type: z.enum(ARTIFACT_TYPES),
    relativeStoragePath: RelativePathSchema,
    mimeType: z.string().min(1).max(200).optional(),
    sizeBytes: NonNegativeIntSchema.optional(),
    sha256: Sha256Schema.optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
