/** Phase 7 cross-revision Retest domain (§24-§27).
 *
 *  Historical FindingCluster / IssueOccurrence
 *      → RetestSpec (sourceSnapshot A, targetSnapshot B)
 *      → RetestRun
 *      → RetestAssessment (deterministic)
 *
 *  Ordinary VerificationRun keeps its Phase 6 meaning (verify an issue
 *  against its own historical snapshot, §23); it is never reinterpreted
 *  as cross-revision testing. Retest reuses verifier trust primitives
 *  (recipe, sandbox, strong identity, sig3) where technically appropriate.
 */
import { z } from 'zod';
import {
  AgentStackIdSchema,
  EvidenceIdSchema,
  IsoTimestampSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
} from './primitives.js';
import { RetestStateSchema } from './phase7-issue.schema.js';
import { createHash } from 'node:crypto';

export const RETEST_VERSION = 1 as const;

const RetestRunIdSchema = z.string().regex(/^retest_[0-9A-HJKMNP-TV-Z]{26}$/);
const RetestAssessmentIdSchema = z.string().regex(/^reassess_[0-9A-HJKMNP-TV-Z]{26}$/);
const Phase7IssueIdSchema = z.string().regex(/^issue_[0-9A-HJKMNP-TV-Z]{26}$/);
const IssueOccurrenceIdSchema = z.string().regex(/^occ_[0-9A-HJKMNP-TV-Z]{26}$/);

export const RetestSpecSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    issueId: Phase7IssueIdSchema,
    sourceOccurrenceId: IssueOccurrenceIdSchema,
    sourceSnapshotId: SnapshotIdSchema,
    targetSnapshotId: SnapshotIdSchema,
    sourceMergeResultId: z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/),
    sourceFindingClusterId: z.string().regex(/^cluster_[0-9A-HJKMNP-TV-Z]{26}$/),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.sourceSnapshotId === spec.targetSnapshotId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSnapshotId'],
        message: 'source and target snapshots must differ (§15, cross-revision)',
      });
    }
  });
export type RetestSpec = z.infer<typeof RetestSpecSchema>;

export const RETEST_RUN_STATUSES = [
  'created',
  'agents_running',
  'merging',
  'assessing',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type RetestRunStatus = (typeof RETEST_RUN_STATUSES)[number];

export const RetestRunSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: RetestRunIdSchema,
    retestVersion: z.literal(RETEST_VERSION),
    projectId: ProjectIdSchema,
    issueId: Phase7IssueIdSchema,
    sourceProjectRevisionId: ProjectRevisionIdSchema,
    targetProjectRevisionId: ProjectRevisionIdSchema,
    sourceSnapshotId: SnapshotIdSchema,
    // Unknown until the target freeze (§15): a created row carries no
    // target snapshot yet. Non-created rows must carry one that differs
    // from the source snapshot.
    targetSnapshotId: SnapshotIdSchema.optional(),
    sourceQaRunId: QARunIdSchema,
    targetQaRunId: QARunIdSchema.optional(),
    sourceMergeResultId: z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/),
    sourceFindingClusterId: z.string().regex(/^cluster_[0-9A-HJKMNP-TV-Z]{26}$/),
    agentStackIds: z.array(AgentStackIdSchema).min(1),
    status: z.enum(RETEST_RUN_STATUSES),
    runtimeInstanceId: z.string().min(1).max(200).optional(),
    parentRetestRunId: RetestRunIdSchema.optional(),
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    // The target snapshot exists only after the freeze: created and
    // agents_running rows may omit it; merging and beyond must carry it.
    if (
      (run.status === 'merging' ||
        run.status === 'assessing' ||
        run.status === 'completed' ||
        run.status === 'partial' ||
        run.status === 'failed' ||
        run.status === 'cancelled' ||
        run.status === 'interrupted') &&
      run.targetSnapshotId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSnapshotId'],
        message: 'frozen retest runs must carry the target snapshot',
      });
    }
    if (run.targetSnapshotId !== undefined && run.sourceSnapshotId === run.targetSnapshotId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSnapshotId'],
        message: 'source and target snapshots must differ',
      });
    }
    if (run.sourceProjectRevisionId === run.targetProjectRevisionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetProjectRevisionId'],
        message: 'source and target revisions must differ',
      });
    }
    if (run.status !== 'created' && run.startedAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'started retest runs must carry startedAt',
      });
    }
    const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
    if (terminal.has(run.status) && run.completedAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'terminal retest runs must carry completedAt',
      });
    }
  });
export type RetestRun = z.infer<typeof RetestRunSchema>;

export const RetestAssessmentSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: RetestAssessmentIdSchema,
    retestVersion: z.literal(RETEST_VERSION),
    retestRunId: RetestRunIdSchema,
    issueId: Phase7IssueIdSchema,
    projectId: ProjectIdSchema,
    sourceRevisionId: ProjectRevisionIdSchema,
    targetRevisionId: ProjectRevisionIdSchema,
    sourceOccurrenceId: IssueOccurrenceIdSchema,
    targetQaRunId: QARunIdSchema,
    targetMergeResultId: z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/),
    newEvidenceIds: z.array(EvidenceIdSchema).default([]),
    result: RetestStateSchema,
    rationale: z.string().min(1).max(5000),
    limitations: z.array(z.string().min(1).max(1000)).default([]),
    assessedAt: IsoTimestampSchema,
  })
  .strict();
export type RetestAssessment = z.infer<typeof RetestAssessmentSchema>;

/** Deterministic retest input digest (§78): issue, source occurrence,
 *  source/target snapshots, agents, recipe/version — so later audit can
 *  prove exactly what was retested. */
export function retestInputDigest(input: {
  readonly issueId: string;
  readonly sourceOccurrenceId: string;
  readonly sourceSnapshotId: string;
  readonly targetSnapshotId: string;
  readonly agentStackIds: readonly string[];
  readonly recipeVersion: number;
}): string {
  const canonical = JSON.stringify({
    issueId: input.issueId,
    sourceOccurrenceId: input.sourceOccurrenceId,
    sourceSnapshotId: input.sourceSnapshotId,
    targetSnapshotId: input.targetSnapshotId,
    agentStackIds: [...input.agentStackIds].sort(),
    recipeVersion: input.recipeVersion,
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}
