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

export const RETEST_VERSION = 2 as const;
/** Retest v1 rows remain decodable (legacy history); new Retests persist v2. */
export const RETEST_LEGACY_VERSION = 1 as const;

const RetestRunIdSchema = z.string().regex(/^retest_[0-9A-HJKMNP-TV-Z]{26}$/);
const RetestAssessmentIdSchema = z.string().regex(/^reassess_[0-9A-HJKMNP-TV-Z]{26}$/);
const Phase7IssueIdSchema = z.string().regex(/^issue_[0-9A-HJKMNP-TV-Z]{26}$/);
const IssueOccurrenceIdSchema = z.string().regex(/^occ_[0-9A-HJKMNP-TV-Z]{26}$/);

export const RetestSpecSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    retestRunId: RetestRunIdSchema,
    issueId: Phase7IssueIdSchema,
    sourceOccurrenceId: IssueOccurrenceIdSchema,
    sourceSnapshotId: SnapshotIdSchema,
    targetSnapshotId: SnapshotIdSchema,
    sourceMergeResultId: z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/),
    sourceFindingClusterId: z.string().regex(/^cluster_[0-9A-HJKMNP-TV-Z]{26}$/),
    sourceRevisionId: ProjectRevisionIdSchema,
    targetRevisionId: ProjectRevisionIdSchema,
    agentStackIds: z.array(AgentStackIdSchema).min(1),
    historicalPaths: z.array(z.string().min(1).max(500)),
    resolvedTargetPaths: z.array(z.string().min(1).max(500)),
    resolutionStrategy: z.enum(['exact_paths', 'nearest_ancestor', 'full_snapshot_fallback']),
    recipeVersion: z.number().int().min(1),
    retestVersion: z.literal(RETEST_VERSION),
    inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    limitations: z.array(z.string().min(1).max(1000)).default([]),
    createdAt: IsoTimestampSchema,
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

export const RetestRunFailureSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    retryable: z.boolean().default(false),
  })
  .strict();
export type RetestRunFailure = z.infer<typeof RetestRunFailureSchema>;

export const RetestRunSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: RetestRunIdSchema,
    retestVersion: z.union([z.literal(RETEST_VERSION), z.literal(RETEST_LEGACY_VERSION)]),
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
    failure: RetestRunFailureSchema.optional(),
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    // Target snapshot invariant (closure §20): merging/assessing/completed/
    // partial always froze B, so they must carry it. failed/cancelled/
    // interrupted require it only when target work had already frozen B
    // (targetQaRunId present means the freeze happened via the child run).
    if (
      (run.status === 'merging' ||
        run.status === 'assessing' ||
        run.status === 'completed' ||
        run.status === 'partial') &&
      run.targetSnapshotId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSnapshotId'],
        message: 'frozen retest runs must carry the target snapshot',
      });
    }
    if (
      (run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') &&
      run.targetQaRunId !== undefined &&
      run.targetSnapshotId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetSnapshotId'],
        message: 'retest runs that froze target work must carry the target snapshot',
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
    retestVersion: z.union([z.literal(RETEST_VERSION), z.literal(RETEST_LEGACY_VERSION)]),
    retestRunId: RetestRunIdSchema,
    issueId: Phase7IssueIdSchema,
    projectId: ProjectIdSchema,
    sourceRevisionId: ProjectRevisionIdSchema,
    targetRevisionId: ProjectRevisionIdSchema,
    sourceOccurrenceId: IssueOccurrenceIdSchema,
    sourceMergeResultId: z
      .string()
      .regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    targetQaRunId: QARunIdSchema,
    // Closure §28-§29: target IDs always refer to revision-B resources.
    // Absent target artifacts stay absent — never substitute source IDs.
    targetMergeResultId: z
      .string()
      .regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    targetVerificationRunId: z
      .string()
      .regex(/^vrun_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    newEvidenceIds: z.array(EvidenceIdSchema).default([]),
    result: RetestStateSchema,
    rationale: z.string().min(1).max(5000),
    limitations: z.array(z.string().min(1).max(1000)).default([]),
    assessedAt: IsoTimestampSchema,
  })
  .strict();
export type RetestAssessment = z.infer<typeof RetestAssessmentSchema>;

/** Deterministic retest input digest (closure §38): issue, source
 *  occurrence, source/target snapshots + revisions, selected agents,
 *  resolved targets, retest + recipe versions — so later audit can prove
 *  exactly what was retested. */
export function retestInputDigest(input: {
  readonly issueId: string;
  readonly sourceOccurrenceId: string;
  readonly sourceSnapshotId: string;
  readonly targetSnapshotId: string;
  readonly agentStackIds: readonly string[];
  readonly recipeVersion: number;
  readonly sourceRevisionId?: string;
  readonly targetRevisionId?: string;
  readonly sourceMergeResultId?: string;
  readonly sourceFindingClusterId?: string;
  readonly resolvedTargetPaths?: readonly string[];
  readonly retestVersion?: number;
}): string {
  const canonical = JSON.stringify({
    issueId: input.issueId,
    sourceOccurrenceId: input.sourceOccurrenceId,
    sourceSnapshotId: input.sourceSnapshotId,
    targetSnapshotId: input.targetSnapshotId,
    agentStackIds: [...input.agentStackIds].sort(),
    recipeVersion: input.recipeVersion,
    sourceRevisionId: input.sourceRevisionId ?? null,
    targetRevisionId: input.targetRevisionId ?? null,
    sourceMergeResultId: input.sourceMergeResultId ?? null,
    sourceFindingClusterId: input.sourceFindingClusterId ?? null,
    resolvedTargetPaths: [...(input.resolvedTargetPaths ?? [])].sort(),
    retestVersion: input.retestVersion ?? RETEST_VERSION,
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}
