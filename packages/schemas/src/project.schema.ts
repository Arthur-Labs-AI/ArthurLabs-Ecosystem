import { z } from 'zod';
import { IsoTimestampSchema, ProjectIdSchema } from './primitives.js';

export const ProjectMetadataSchema = z
  .object({
    git: z.object({ detected: z.boolean() }).strict().optional(),
    stack: z
      .object({ languages: z.array(z.string()), frameworks: z.array(z.string()) })
      .strict()
      .optional(),
    packageManagers: z.array(z.string()).optional(),
    testFrameworks: z.array(z.string()).optional(),
    ciProviders: z.array(z.string()).optional(),
  })
  .strict();
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const ProjectSchema = z
  .object({
    id: ProjectIdSchema,
    name: z.string().min(1).max(200),
    sourcePath: z.string().min(1).max(1000),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    lastOpenedAt: IsoTimestampSchema.optional(),
    metadata: ProjectMetadataSchema.default({}),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;
