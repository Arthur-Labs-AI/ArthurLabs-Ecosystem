import { z } from 'zod';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  InvestigationHypothesisIdSchema,
  InvestigationPlanIdSchema,
  IsoTimestampSchema,
  ProjectContextSnapshotIdSchema,
  QARunIdSchema,
  RelativePathSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
} from './primitives.js';

export const AgentInvestigationPlanSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: InvestigationPlanIdSchema,
    qaRunId: QARunIdSchema,
    agentRunId: AgentRunIdSchema,
    agentStackId: AgentStackIdSchema,
    projectSnapshotId: SnapshotIdSchema,
    projectContextSnapshotId: ProjectContextSnapshotIdSchema,
    projectUnderstanding: z.string().min(1).max(20_000),
    criticalFlows: z.array(z.string().min(1).max(2000)).default([]),
    weakPoints: z.array(z.string().min(1).max(2000)).default([]),
    plannedChecks: z.array(z.string().min(1).max(2000)).min(1),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type AgentInvestigationPlan = z.infer<typeof AgentInvestigationPlanSchema>;
export const InitialInvestigationPlanSchema = AgentInvestigationPlanSchema;
export type InitialInvestigationPlan = AgentInvestigationPlan;

export const EmergentHypothesisSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: InvestigationHypothesisIdSchema,
    qaRunId: QARunIdSchema,
    agentRunId: AgentRunIdSchema,
    title: z.string().min(1).max(200),
    rationale: z.string().min(1).max(10_000),
    relatedPaths: z.array(RelativePathSchema).default([]),
    plannedChecks: z.array(z.string().min(1).max(2000)).min(1),
    discoveredAt: IsoTimestampSchema,
  })
  .strict();
export type EmergentHypothesis = z.infer<typeof EmergentHypothesisSchema>;
