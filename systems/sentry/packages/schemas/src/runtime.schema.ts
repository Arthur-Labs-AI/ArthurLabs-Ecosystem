import { z } from 'zod';
import {
  IsoTimestampSchema,
  NonNegativeSafeIntSchema,
  OperationIdSchema,
  ProjectIdSchema,
  RelativePathSchema,
  RuntimeInstanceIdSchema,
  SchemaVersionSchema,
} from './primitives.js';

export const RuntimeInstanceSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: RuntimeInstanceIdSchema,
    processId: NonNegativeSafeIntSchema,
    hostname: z.string().min(1).max(255).optional(),
    startedAt: IsoTimestampSchema,
    heartbeatAt: IsoTimestampSchema,
    releasedAt: IsoTimestampSchema.optional(),
    lastHeartbeatError: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type RuntimeInstance = z.infer<typeof RuntimeInstanceSchema>;

export const RuntimeOperationSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: OperationIdSchema,
    projectId: ProjectIdSchema,
    runtimeInstanceId: RuntimeInstanceIdSchema,
    type: z.enum(['project_update', 'project_delete']),
    stage: z.enum([
      'preparing',
      'backup_created',
      'promoted',
      'committed',
      'deleting',
      'tombstoned',
      'database_deleted',
    ]),
    stagedArtifactPath: RelativePathSchema.optional(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((operation, ctx) => {
    const updateStages = new Set(['preparing', 'backup_created', 'promoted', 'committed']);
    const valid =
      operation.type === 'project_update'
        ? updateStages.has(operation.stage)
        : new Set(['deleting', 'tombstoned', 'database_deleted']).has(operation.stage);
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stage'],
        message: operation.stage + ' is not valid for ' + operation.type,
      });
    }
  });
export type RuntimeOperation = z.infer<typeof RuntimeOperationSchema>;
