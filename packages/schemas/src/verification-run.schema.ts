import { z } from 'zod';
import {
  ArtifactIdSchema,
  EvidenceIdSchema,
  FindingIdSchema,
  IsoTimestampSchema,
  OperationIdSchema,
  ProjectContextSnapshotIdSchema,
  QARunIdSchema,
  SchemaVersionSchema,
  SnapshotIdSchema,
  VerificationAttemptIdSchema,
  VerificationObservationIdSchema,
  VerificationRunIdSchema,
  VerificationStepIdSchema,
} from './primitives.js';

/** Verifier/algorithm versions: bumped when behavior changes so
 *  historical VerificationResults are never silently reinterpreted.
 *  v3 (Phase 6.1.1): systemd-sandboxed replay, strong negative
 *  evidence, strict framework-aware identity, cwdRelative replay,
 *  sig3 hashed signatures, atomic revision retention. v1+v2 rows
 *  remain readable via the unions below; never reinterpreted. */
export const VERIFIER_VERSION = 3 as const;
export const VERIFICATION_RECIPE_VERSION = 3 as const;
export const VERIFICATION_SIGNATURE_VERSION = 3 as const;

export const VerificationRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);
export type VerificationRunStatus = z.infer<typeof VerificationRunStatusSchema>;

export const VerificationAttemptStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type VerificationAttemptStatus = z.infer<typeof VerificationAttemptStatusSchema>;

/** Small explicit outcome enum (§20). No generic `verified`: source
 *  confirmation and runtime reproduction are different claims (§25). */
export const VerificationOutcomeSchema = z.enum([
  'reproduced',
  'partially_verified',
  'not_reproducible',
  'inconclusive',
]);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

export const VerificationStepTypeSchema = z.enum([
  'source_integrity',
  'command_replay',
  'test_replay',
  'environment_check',
  'unsupported_claim',
]);
export type VerificationStepType = z.infer<typeof VerificationStepTypeSchema>;

export const VerificationStepOutcomeSchema = z.enum([
  'matched',
  'mismatched',
  'blocked',
  'error',
  'unsupported',
]);
export type VerificationStepOutcome = z.infer<typeof VerificationStepOutcomeSchema>;

export const VerificationAssertionSubjectSchema = z.enum([
  'behavior',
  'source_location',
  'test_failure',
  'command_failure',
  'root_cause',
]);
export type VerificationAssertionSubject = z.infer<typeof VerificationAssertionSubjectSchema>;

export const VerificationAssertionStateSchema = z.enum([
  'confirmed',
  'contradicted',
  'inconclusive',
]);
export type VerificationAssertionState = z.infer<typeof VerificationAssertionStateSchema>;

export const VerificationEnvironmentFingerprintSchema = z
  .object({
    platform: z.string().min(1).max(100),
    architecture: z.string().min(1).max(100),
    nodeVersion: z.string().min(1).max(100),
    packageManagerVersions: z.record(z.string(), z.string()).default({}),
    runtimes: z.array(z.string().min(1).max(200)).default([]),
  })
  .strict();
export type VerificationEnvironmentFingerprint = z.infer<
  typeof VerificationEnvironmentFingerprintSchema
>;

export const VerificationWarningSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
  })
  .strict();
export type VerificationWarning = z.infer<typeof VerificationWarningSchema>;

const VerificationRunBase = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: VerificationRunIdSchema,
    mergeResultId: z.string().regex(/^merge_[0-9A-HJKMNP-TV-Z]{26}$/),
    qaRunId: QARunIdSchema,
    projectSnapshotId: SnapshotIdSchema,
    projectContextSnapshotId: ProjectContextSnapshotIdSchema.optional(),
    // Readable-history unions: v1+v2 rows decode, new rows stamp v3.
    verifierVersion: z.union([z.literal(1), z.literal(2), z.literal(VERIFIER_VERSION)]),
    recipeVersion: z.union([z.literal(1), z.literal(2), z.literal(VERIFICATION_RECIPE_VERSION)]),
    signatureVersion: z.union([z.literal(1), z.literal(2), z.literal(VERIFICATION_SIGNATURE_VERSION)]),
    status: VerificationRunStatusSchema,
    // Lease binding for crash recovery (§64-65): the owning runtime
    // instance; a sweeper marks stale-owned running rows interrupted.
    runtimeInstanceId: z.string().min(1).max(200).optional(),
    requestedClusterIds: z.array(z.string().regex(/^cluster_[0-9A-HJKMNP-TV-Z]{26}$/)),
    environmentFingerprint: VerificationEnvironmentFingerprintSchema.optional(),
    warnings: z.array(VerificationWarningSchema).default([]),
    attemptIds: z.array(VerificationAttemptIdSchema).default([]),
    createdAt: IsoTimestampSchema,
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type VerificationRunBase = z.infer<typeof VerificationRunBase>;

export const VerificationRunSchema = VerificationRunBase.superRefine((value, context) => {
  if (value.status !== 'queued' && value.startedAt === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startedAt'],
      message: 'started runs must carry startedAt',
    });
  }
  if (
    (value.status === 'completed' ||
      value.status === 'partial' ||
      value.status === 'failed' ||
      value.status === 'cancelled' ||
      value.status === 'interrupted') &&
    value.completedAt === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completedAt'],
      message: 'terminal runs must carry completedAt',
    });
  }
});
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

export const VerificationRecipeStepSchema = z
  .object({
    id: VerificationStepIdSchema,
    type: VerificationStepTypeSchema,
    // Deterministic recipe fingerprint: identical canonical input always
    // yields the identical step (dedup key across source findings, §50).
    recipeFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceEvidenceIds: z.array(EvidenceIdSchema),
    sourceOperationIds: z.array(OperationIdSchema),
    // Expected observations (§44): explicit, never vague.
    expected: z.record(z.string(), z.string()).default({}),
    nonExecutableInstructions: z.array(z.string().min(1).max(5000)).default([]),
    status: VerificationAttemptStatusSchema,
    // Internal match strength (§21): strong matches alone are decisive.
    // Optional + additive; absent means unassessed (never weak by default).
    matchStrength: z.enum(['strong_match', 'weak_match']).optional(),
    outcome: VerificationStepOutcomeSchema.optional(),
    observationIds: z.array(VerificationObservationIdSchema).default([]),
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type VerificationRecipeStep = z.infer<typeof VerificationRecipeStepSchema>;

const VerificationRunAttemptBase = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: VerificationAttemptIdSchema,
    verificationRunId: VerificationRunIdSchema,
    findingClusterId: z.string().regex(/^cluster_[0-9A-HJKMNP-TV-Z]{26}$/),
    status: VerificationAttemptStatusSchema,
    recipeVersion: z.union([z.literal(1), z.literal(2), z.literal(VERIFICATION_RECIPE_VERSION)]),
    recipeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    outcome: VerificationOutcomeSchema.optional(),
    steps: z.array(VerificationRecipeStepSchema),
    sourceFindingIds: z.array(FindingIdSchema).min(1),
    sourceEvidenceIds: z.array(EvidenceIdSchema),
    workspaceProvenance: z
      .object({
        snapshotId: SnapshotIdSchema,
        workspacePath: z.string().min(1).max(2000),
        materializedAt: IsoTimestampSchema,
        baselineMatch: z.boolean(),
      })
      .strict()
      .optional(),
    failure: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(2000),
      })
      .strict()
      .optional(),
    limitations: z.array(z.string().min(1).max(2000)).default([]),
    startedAt: IsoTimestampSchema.optional(),
    completedAt: IsoTimestampSchema.optional(),
  })
  .strict();
export type VerificationRunAttemptBase = z.infer<typeof VerificationRunAttemptBase>;

export const VerificationRunAttemptSchema = VerificationRunAttemptBase.superRefine(
  (value, context) => {
    // Completed attempts always carry an outcome; outcome never precedes
    // completion. Immutability of completed results is enforced below.
    if (value.status === 'completed' && value.outcome === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'completed attempts must carry an outcome',
      });
    }
    if (value.status !== 'completed' && value.outcome !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'outcome requires completed status',
      });
    }
  },
);
export type VerificationRunAttempt = z.infer<typeof VerificationRunAttemptSchema>;

export const VerificationObservationSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: VerificationObservationIdSchema,
    verificationAttemptId: VerificationAttemptIdSchema,
    stepId: VerificationStepIdSchema,
    type: VerificationStepTypeSchema,
    command: z.string().min(1).max(2000).optional(),
    testName: z.string().min(1).max(500).optional(),
    testStatus: z.enum(['passed', 'failed', 'skipped']).optional(),
    sourceCheck: z
      .object({
        relativePath: z.string().min(1).max(2000),
        exists: z.boolean(),
        isRegularFile: z.boolean(),
        lineRangePresent: z.boolean(),
        contentHashMatch: z.boolean().optional(),
      })
      .strict()
      .optional(),
    exitCode: z.number().int().optional(),
    diagnosticFingerprint: z.string().min(1).max(2000).optional(),
    artifactIds: z.array(ArtifactIdSchema).default([]),
    outcome: VerificationStepOutcomeSchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
  })
  .strict();
export type VerificationObservation = z.infer<typeof VerificationObservationSchema>;

export const VerificationAssertionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    verificationAttemptId: VerificationAttemptIdSchema,
    subject: VerificationAssertionSubjectSchema,
    state: VerificationAssertionStateSchema,
    detail: z.string().min(1).max(2000),
    sourceEvidenceIds: z.array(EvidenceIdSchema).default([]),
    observationIds: z.array(VerificationObservationIdSchema).default([]),
  })
  .strict();
export type VerificationAssertion = z.infer<typeof VerificationAssertionSchema>;
