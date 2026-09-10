import { z } from 'zod';
import { CONTEXT_SOURCE_KINDS } from './enums.js';
import {
  IsoTimestampSchema,
  ProjectContextSnapshotIdSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  RelativePathSchema,
  SchemaVersionSchema,
} from './primitives.js';

export const ContextProvenanceSchema = z
  .object({
    kind: z.enum(CONTEXT_SOURCE_KINDS),
    relativePath: RelativePathSchema.optional(),
    description: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type ContextProvenance = z.infer<typeof ContextProvenanceSchema>;

export const ContextFactSchema = z
  .object({
    statement: z.string().min(1).max(5000),
    sources: z.array(ContextProvenanceSchema).default([]),
  })
  .strict();
export type ContextFact = z.infer<typeof ContextFactSchema>;

export const CriticalFlowSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(5000),
    entryPoints: z.array(RelativePathSchema).default([]),
    sources: z.array(ContextProvenanceSchema).default([]),
  })
  .strict();
export type CriticalFlow = z.infer<typeof CriticalFlowSchema>;

export const DetectedStackSchema = z
  .object({
    languages: z.array(z.string().min(1).max(100)).default([]),
    frameworks: z.array(z.string().min(1).max(100)).default([]),
    packageManagers: z.array(z.string().min(1).max(100)).default([]),
    testFrameworks: z.array(z.string().min(1).max(100)).default([]),
    sources: z.array(ContextProvenanceSchema).default([]),
  })
  .strict();
export type DetectedStack = z.infer<typeof DetectedStackSchema>;

export const ProjectContextSnapshotSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: ProjectContextSnapshotIdSchema,
    projectId: ProjectIdSchema,
    projectRevisionId: ProjectRevisionIdSchema,
    purpose: z.string().min(1).max(1000).optional(),
    architectureSummary: z.string().min(1).max(20_000).optional(),
    criticalFlows: z.array(CriticalFlowSchema).default([]),
    businessRules: z.array(ContextFactSchema).default([]),
    constraints: z.array(ContextFactSchema).default([]),
    knownLimitations: z.array(ContextFactSchema).default([]),
    outOfScope: z.array(ContextFactSchema).default([]),
    detectedStack: DetectedStackSchema.optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type ProjectContextSnapshot = z.infer<typeof ProjectContextSnapshotSchema>;

/** Embedded immutable run-scoped operator guidance. */
export const RunInstructionsSchema = z
  .object({
    message: z.string().min(1).max(50_000),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type RunInstructions = z.infer<typeof RunInstructionsSchema>;
