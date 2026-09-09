import { z } from 'zod';
import { IsoTimestampSchema, ProjectIdSchema, RelativePathSchema } from './primitives.js';
import {
  CICD_PROVIDERS,
  CICD_RECOMMENDATION_CATEGORIES,
  CICD_RECOMMENDATION_SEVERITIES,
} from './enums.js';

export const CICDRecommendationSchema = z
  .object({
    id: z.string().min(1).max(100),
    category: z.enum(CICD_RECOMMENDATION_CATEGORIES),
    severity: z.enum(CICD_RECOMMENDATION_SEVERITIES),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(5000),
  })
  .strict();
export type CICDRecommendation = z.infer<typeof CICDRecommendationSchema>;

export const CICDFileProposalSchema = z
  .object({
    relativePath: RelativePathSchema,
    mode: z.enum(['create', 'overwrite', 'patch']),
    contentArtifactId: z.string().min(1).max(200).optional(),
    summary: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type CICDFileProposal = z.infer<typeof CICDFileProposalSchema>;

export const CICDPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().refine((v) => /^cicd_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid CICDPlanId',
    }),
    projectId: ProjectIdSchema,
    snapshotId: z.string().refine((v) => /^snap_[0-9A-HJKMNP-TV-Z]{26}$/.test(v), {
      message: 'Must be a valid SnapshotId',
    }),
    provider: z.enum(CICD_PROVIDERS),
    mode: z.enum(['create', 'improve']),
    detectedExistingConfiguration: z.boolean(),
    recommendations: z.array(CICDRecommendationSchema).default([]),
    generatedFiles: z.array(CICDFileProposalSchema).default([]),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type CICDPlan = z.infer<typeof CICDPlanSchema>;
