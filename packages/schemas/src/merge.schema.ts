import { z } from 'zod';
import {
  AgentRunIdSchema,
  AgentStackIdSchema,
  EvidenceIdSchema,
  FindingIdSchema,
  IsoTimestampSchema,
  ProjectContextSnapshotIdSchema,
  QARunIdSchema,
  SnapshotIdSchema,
} from './primitives.js';
import { FINDING_CATEGORIES, FINDING_CONFIDENCES, FINDING_SEVERITIES } from './enums.js';

/** Merger/normalizer versions: bumped when the algorithm changes so
 *  historical MergeResults are never silently reinterpreted. */
export const MERGER_VERSION = 1 as const;
export const NORMALIZER_VERSION = 1 as const;

export const AgreementStateSchema = z.enum([
  'single_source',
  'multi_source',
  'all_available_sources',
]);
export type AgreementState = z.infer<typeof AgreementStateSchema>;

export const FieldDisagreementSchema = z
  .object({
    field: z.enum(['severity', 'confidence', 'category', 'location', 'rootCause']),
    valuesByAgentStackId: z.record(z.string(), z.string()),
  })
  .strict();
export type FieldDisagreement = z.infer<typeof FieldDisagreementSchema>;

const FindingClusterBase = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^cluster_[0-9A-HJKMNP-TV-Z]{26}$/),
    qaRunId: QARunIdSchema,
    projectSnapshotId: SnapshotIdSchema,
    mergerVersion: z.literal(MERGER_VERSION),
    normalizerVersion: z.literal(NORMALIZER_VERSION),
    sourceFindingIds: z.array(FindingIdSchema).min(1),
    sourceAgentRunIds: z.array(AgentRunIdSchema).min(1),
    sourceAgentStackIds: z.array(AgentStackIdSchema).min(1),
    representativeFindingId: FindingIdSchema,
    agreementState: AgreementStateSchema,
    expectedAgentCount: z.number().int().min(1),
    usableAgentCount: z.number().int().min(1),
    supportingAgentCount: z.number().int().min(1),
    unavailableAgentStackIds: z.array(AgentStackIdSchema),
    severityValues: z.array(z.enum(FINDING_SEVERITIES)).min(1),
    confidenceValues: z.array(z.enum(FINDING_CONFIDENCES)).min(1),
    categoryValues: z.array(z.enum(FINDING_CATEGORIES)).min(1),
    evidenceIds: z.array(EvidenceIdSchema),
    fieldDisagreements: z.array(FieldDisagreementSchema),
    hasReproducedEvidence: z.boolean(),
    hasOperationEvidence: z.boolean(),
    hasSourceEvidence: z.boolean(),
    hasOnlyModelReasoning: z.boolean(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type FindingClusterBase = z.infer<typeof FindingClusterBase>;

export const FindingClusterSchema = FindingClusterBase.superRefine(
  (value: FindingClusterBase, context: z.RefinementCtx) => {
    if (value.supportingAgentCount > value.usableAgentCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supportingAgentCount'],
        message: 'supportingAgentCount cannot exceed usableAgentCount',
      });
    }
    if (value.usableAgentCount > value.expectedAgentCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usableAgentCount'],
        message: 'usableAgentCount cannot exceed expectedAgentCount',
      });
    }
    if (!value.sourceFindingIds.includes(value.representativeFindingId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['representativeFindingId'],
        message: 'representative must be a member finding',
      });
    }
  },
);
export type FindingCluster = z.infer<typeof FindingClusterSchema>;

const MergeResultBase = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/),
    qaRunId: QARunIdSchema,
    projectSnapshotId: SnapshotIdSchema,
    projectContextSnapshotId: ProjectContextSnapshotIdSchema.optional(),
    mergerVersion: z.literal(MERGER_VERSION),
    normalizerVersion: z.literal(NORMALIZER_VERSION),
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expectedAgentStackIds: z.array(AgentStackIdSchema),
    usableAgentRunIds: z.array(AgentRunIdSchema),
    unavailableAgentStackIds: z.array(AgentStackIdSchema),
    sourceFindingCount: z.number().int().min(0),
    clusterCount: z.number().int().min(0),
    singleSourceCount: z.number().int().min(0),
    multiSourceCount: z.number().int().min(0),
    allAvailableCount: z.number().int().min(0),
    clusters: z.array(FindingClusterSchema),
    durationMs: z.number().int().min(0),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type MergeResultBase = z.infer<typeof MergeResultBase>;

export const MergeResultSchema = MergeResultBase.superRefine(
  (value: MergeResultBase, context: z.RefinementCtx) => {
    if (value.clusters.length !== value.clusterCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clusterCount'],
        message: 'clusterCount must equal clusters.length',
      });
    }
    const singles = value.clusters.filter(
      (c: { agreementState: string }) => c.agreementState === 'single_source',
    ).length;
    const multis = value.clusters.filter(
      (c: { agreementState: string }) => c.agreementState === 'multi_source',
    ).length;
    const alls = value.clusters.filter(
      (c: { agreementState: string }) => c.agreementState === 'all_available_sources',
    ).length;
    if (
      singles !== value.singleSourceCount ||
      multis !== value.multiSourceCount ||
      alls !== value.allAvailableCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['singleSourceCount'],
        message: 'agreement counters must match cluster states',
      });
    }
  },
);
export type MergeResult = z.infer<typeof MergeResultSchema>;
