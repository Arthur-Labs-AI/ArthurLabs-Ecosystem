import { z } from 'zod';
import {
  ArtifactIdSchema,
  IsoTimestampSchema,
  NonNegativeSafeIntSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  Sha256Schema,
  SnapshotIdSchema,
  NonNegativeIntSchema,
} from './primitives.js';
import { SNAPSHOT_FILE_TYPES } from './enums.js';

export const SnapshotSourceStateSchema = z
  .object({
    git: z
      .object({
        branch: z.string().min(1).max(200).optional(),
        headCommit: z.string().min(1).max(200).optional(),
        dirty: z.boolean(),
        modifiedFiles: NonNegativeIntSchema.optional(),
        untrackedFiles: NonNegativeIntSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SnapshotSourceState = z.infer<typeof SnapshotSourceStateSchema>;

export const SnapshotFileEntrySchema = z
  .object({
    relativePath: RelativePathSchema,
    sha256: Sha256Schema,
    sizeBytes: NonNegativeIntSchema,
    type: z.enum(SNAPSHOT_FILE_TYPES),
  })
  .strict();
export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntrySchema>;

export const SnapshotManifestSummarySchema = z
  .object({
    entryCount: NonNegativeSafeIntSchema,
    fileCount: NonNegativeSafeIntSchema,
    directoryCount: NonNegativeSafeIntSchema,
    symlinkCount: NonNegativeSafeIntSchema,
    totalBytes: NonNegativeSafeIntSchema,
    artifactId: ArtifactIdSchema,
  })
  .strict();
export type SnapshotManifestSummary = z.infer<typeof SnapshotManifestSummarySchema>;

export const ProjectSnapshotSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: SnapshotIdSchema,
    projectId: ProjectIdSchema,
    projectRevisionId: ProjectRevisionIdSchema,
    createdAt: IsoTimestampSchema,
    sourceState: SnapshotSourceStateSchema.default({}),
    manifest: SnapshotManifestSummarySchema,
    contentHash: Sha256Schema,
  })
  .strict();
export type ProjectSnapshot = z.infer<typeof ProjectSnapshotSchema>;
