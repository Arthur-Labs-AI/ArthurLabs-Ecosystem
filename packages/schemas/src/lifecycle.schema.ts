import { z } from 'zod';
import {
  IsoTimestampSchema,
  NonNegativeSafeIntSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  Sha256Schema,
  RuntimeInstanceIdSchema,
} from './primitives.js';
import { MANAGED_PROJECT_COPY_STATES } from './enums.js';

export const ProjectRevisionStatsSchema = z
  .object({
    fileCount: NonNegativeSafeIntSchema,
    directoryCount: NonNegativeSafeIntSchema.optional(),
    totalBytes: NonNegativeSafeIntSchema,
  })
  .strict();
export type ProjectRevisionStats = z.infer<typeof ProjectRevisionStatsSchema>;

export const ProjectRevisionGitStateSchema = z
  .object({
    detected: z.boolean(),
    branch: z.string().min(1).max(200).optional(),
    headCommit: z.string().min(1).max(200).optional(),
    dirty: z.boolean().optional(),
  })
  .strict();
export type ProjectRevisionGitState = z.infer<typeof ProjectRevisionGitStateSchema>;

export const ProjectRevisionSourceStateSchema = z
  .object({ git: ProjectRevisionGitStateSchema.optional() })
  .strict();
export type ProjectRevisionSourceState = z.infer<typeof ProjectRevisionSourceStateSchema>;

/** Immutable record of one atomically imported managed-copy state.
 *  hashVersion 1 = legacy full-tree hash (no exclusions); 2 = default
 *  import exclusion set applied. Hashes are only comparable within the
 *  same version; lineage refuses cross-version comparison. */
export const ProjectRevisionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: ProjectRevisionIdSchema,
    projectId: ProjectIdSchema,
    sourcePath: z.string().min(1).max(2000),
    importedAt: IsoTimestampSchema,
    contentHash: Sha256Schema,
    hashVersion: z.literal(2).optional(),
    stats: ProjectRevisionStatsSchema.optional(),
    sourceState: ProjectRevisionSourceStateSchema.optional(),
  })
  .strict();
export type ProjectRevision = z.infer<typeof ProjectRevisionSchema>;

export const ManagedProjectCopySchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    projectId: ProjectIdSchema,
    currentRevisionId: ProjectRevisionIdSchema.optional(),
    state: z.enum(MANAGED_PROJECT_COPY_STATES),
    lockedByQARunId: QARunIdSchema.optional(),
    runtimeInstanceId: RuntimeInstanceIdSchema.optional(),
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((copy, ctx) => {
    if (
      (copy.state === 'ready' || copy.state === 'locked_for_run') &&
      copy.currentRevisionId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currentRevisionId'],
        message: copy.state + ' managed copy requires currentRevisionId',
      });
    }
    if (copy.state === 'locked_for_run' && copy.lockedByQARunId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lockedByQARunId'],
        message: 'locked_for_run requires lockedByQARunId',
      });
    }
    if (copy.state !== 'locked_for_run' && copy.lockedByQARunId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lockedByQARunId'],
        message: 'Only locked_for_run may carry lockedByQARunId',
      });
    }
    const requiresOwner = new Set(['updating', 'locked_for_run', 'deleting']).has(copy.state);
    if (requiresOwner && copy.runtimeInstanceId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtimeInstanceId'],
        message: copy.state + ' managed copy requires runtimeInstanceId',
      });
    }
    if (!requiresOwner && copy.runtimeInstanceId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtimeInstanceId'],
        message: 'Only active managed-copy states may carry runtimeInstanceId',
      });
    }
  });
export type ManagedProjectCopy = z.infer<typeof ManagedProjectCopySchema>;
