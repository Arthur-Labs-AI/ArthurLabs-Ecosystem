/** Phase 7 Issue lineage (§28-§36). Stable product-level defect identity
 *  across revisions — distinct from Finding (one AgentRun) and
 *  FindingCluster (one MergeResult).
 *
 *  Append-oriented (§36): Issue + IssueEvent[] + IssueOccurrence[] +
 *  RetestAssessment[] are never overwritten; currentState is derived from
 *  history. Explicit retest links are authoritative (§33); never fuzzy-merge
 *  two bugs into one historical Issue (§32).
 */
import { z } from 'zod';
import {
  IsoTimestampSchema,
  ProjectIdSchema,
  ProjectRevisionIdSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
} from './primitives.js';
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from './enums.js';
import { createHash } from 'node:crypto';

export const ISSUE_STATES = [
  'open',
  'still_reproducible',
  'partially_fixed',
  'fixed',
  'inconclusive',
] as const;
export type IssueState = (typeof ISSUE_STATES)[number];
export const IssueStateSchema = z.enum(ISSUE_STATES);

export const ISSUE_EVENT_KINDS = [
  'created',
  'occurrence_recorded',
  'retest_assessed',
  'state_changed',
] as const;
export type IssueEventKind = (typeof ISSUE_EVENT_KINDS)[number];

const Phase7IssueIdSchema = z.string().regex(/^issue_[0-9A-HJKMNP-TV-Z]{26}$/);
const IssueOccurrenceIdSchema = z.string().regex(/^occ_[0-9A-HJKMNP-TV-Z]{26}$/);
const IssueEventIdSchema = z.string().regex(/^iev_[0-9A-HJKMNP-TV-Z]{26}$/);

export const IssueSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: Phase7IssueIdSchema,
    projectId: ProjectIdSchema,
    title: z.string().min(1).max(200),
    category: z.enum(FINDING_CATEGORIES),
    severity: z.enum(FINDING_SEVERITIES),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();
export type Issue = z.infer<typeof IssueSchema>;

export const IssueOccurrenceSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IssueOccurrenceIdSchema,
    issueId: Phase7IssueIdSchema,
    projectId: ProjectIdSchema,
    projectRevisionId: ProjectRevisionIdSchema,
    projectSnapshotId: SnapshotIdSchema,
    qaRunId: QARunIdSchema,
    mergeResultId: z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/),
    findingClusterId: z.string().regex(/^cluster_[0-9A-HJKMNP-TV-Z]{26}$/),
    verificationRunId: z
      .string()
      .regex(/^vrun_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type IssueOccurrence = z.infer<typeof IssueOccurrenceSchema>;

export const IssueEventSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: IssueEventIdSchema,
    issueId: Phase7IssueIdSchema,
    projectId: ProjectIdSchema,
    kind: z.enum(ISSUE_EVENT_KINDS),
    fromState: IssueStateSchema.optional(),
    toState: IssueStateSchema,
    occurrenceId: IssueOccurrenceIdSchema.optional(),
    retestAssessmentId: z
      .string()
      .regex(/^reassess_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional(),
    message: z.string().min(1).max(2000),
    createdAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.kind === 'created' && event.fromState !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fromState'],
        message: 'created events carry no fromState',
      });
    }
    if (event.kind === 'occurrence_recorded' && event.occurrenceId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['occurrenceId'],
        message: 'occurrence_recorded requires occurrenceId',
      });
    }
    if (event.kind === 'retest_assessed' && event.retestAssessmentId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retestAssessmentId'],
        message: 'retest_assessed requires retestAssessmentId',
      });
    }
  });
export type IssueEvent = z.infer<typeof IssueEventSchema>;

/** Derive the current projection from append-only history (§35-§36).
 *  New issues start `open`; the latest event wins. Reopening is allowed:
 *  fixed → still_reproducible records the regression (§89). */
export function projectIssueState(events: readonly IssueEvent[]): IssueState {
  let state: IssueState = 'open';
  for (const event of events) state = event.toState;
  return state;
}

/** Deterministic idempotency key for issue ingest (§74, §76): one
 *  (mergeResultId, clusterId) pair always maps to the same occurrence. */
export function issueIngestKey(input: {
  readonly mergeResultId: string;
  readonly findingClusterId: string;
}): string {
  return (
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify({
          mergeResultId: input.mergeResultId,
          findingClusterId: input.findingClusterId,
        }),
        'utf8',
      )
      .digest('hex')
  );
}

export const RETEST_STATES = [
  'fixed',
  'still_reproducible',
  'partially_fixed',
  'inconclusive',
] as const;
export type RetestState = (typeof RETEST_STATES)[number];
export const RetestStateSchema = z.enum(RETEST_STATES);
