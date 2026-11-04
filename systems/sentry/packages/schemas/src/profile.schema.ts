import { z } from 'zod';
import {
  AgentStackIdSchema,
  IsoTimestampSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  SchemaVersionSchema,
} from './primitives.js';

/** Longest profile text stored and handed to an agent. */
export const PROJECT_PROFILE_TEXT_MAX = 8000;

/**
 * One agent's own orientation notes about a project, written before any run.
 * Facts about structure only: it is UNVERIFIED context for later runs, never
 * evidence, and never holds findings or verdicts.
 */
export const ProjectProfileSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    projectId: ProjectIdSchema,
    agentStackId: AgentStackIdSchema,
    projectRevisionId: ProjectRevisionIdSchema,
    /** Content hash of the revision the profile describes; a different hash makes it stale. */
    contentHash: z.string().min(1).max(200),
    text: z.string().min(1).max(PROJECT_PROFILE_TEXT_MAX),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

/** What a run did with the profiles: recorded on the run so runs can be compared. */
export const RunProfileUsageSchema = z
  .object({
    requested: z.boolean(),
    usedAgentStackIds: z.array(AgentStackIdSchema).default([]),
    staleAgentStackIds: z.array(AgentStackIdSchema).default([]),
    missingAgentStackIds: z.array(AgentStackIdSchema).default([]),
  })
  .strict();
export type RunProfileUsage = z.infer<typeof RunProfileUsageSchema>;
