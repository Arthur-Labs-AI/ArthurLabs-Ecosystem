import { z } from 'zod';
import { RUN_ACTIVITY_KINDS, RUN_ACTIVITY_SOURCES, RUN_ACTIVITY_STATUSES } from './enums.js';
import {
  AgentRunIdSchema,
  ArtifactIdSchema,
  IsoTimestampSchema,
  QARunIdSchema,
  RunActivityIdSchema,
  SchemaVersionSchema,
} from './primitives.js';

export const RunActivitySchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: RunActivityIdSchema,
    qaRunId: QARunIdSchema,
    agentRunId: AgentRunIdSchema.optional(),
    parentActivityId: RunActivityIdSchema.optional(),
    source: z.enum(RUN_ACTIVITY_SOURCES),
    kind: z.enum(RUN_ACTIVITY_KINDS),
    status: z.enum(RUN_ACTIVITY_STATUSES),
    title: z.string().min(1).max(300),
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
    artifactIds: z.array(ArtifactIdSchema).default([]),
  })
  .strict()
  .superRefine((activity, ctx) => {
    const terminal = new Set(['completed', 'warning', 'failed', 'cancelled', 'skipped']).has(
      activity.status,
    );
    if (terminal && activity.completedAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'Terminal activity status requires completedAt',
      });
    }
    if (activity.completedAt !== undefined && activity.startedAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'completedAt requires startedAt',
      });
    }
    if (
      activity.startedAt !== undefined &&
      activity.completedAt !== undefined &&
      activity.completedAt < activity.startedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'completedAt must not precede startedAt',
      });
    }
  });
export type RunActivity = z.infer<typeof RunActivitySchema>;

export const RunExportManifestSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    qaRunId: QARunIdSchema,
    format: z.enum(['log', 'json']),
    artifactId: ArtifactIdSchema,
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type RunExportManifest = z.infer<typeof RunExportManifestSchema>;
