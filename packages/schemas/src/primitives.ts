/** Shared Zod primitives: timestamps, IDs, paths, hashes, versions.
 *
 * Every boundary schema in @qa/schemas builds on these so ID shape,
 * timestamp format and relative-path rules stay identical everywhere.
 */
import { z } from 'zod';
import {
  isAgentRunId,
  isAgentStackId,
  isArtifactId,
  isEvidenceId,
  isFindingId,
  isFixProposalId,
  isHarnessEventId,
  isProjectId,
  isProjectRevisionId,
  isProjectContextSnapshotId,
  isQARunId,
  isSnapshotId,
  isInvestigationPlanId,
  isInvestigationHypothesisId,
  isRunActivityId,
  isOperationId,
  isUnifiedIssueId,
  isVerificationId,
  isVerificationRunId,
  isVerificationAttemptId,
  isVerificationStepId,
  isVerificationObservationId,
  isCICDPlanId,
  isIsoTimestamp,
  isRuntimeInstanceId,
} from '@qa/shared';

/** ISO 8601 UTC timestamp string (e.g. 2026-09-09T19:15:31.521Z). */
export const IsoTimestampSchema = z.string().refine(isIsoTimestamp, {
  message: 'Must be an ISO 8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)',
});

function idSchema<Id extends string>(guard: (value: unknown) => value is Id, label: string) {
  return z.string().refine((value): value is Id => guard(value), {
    message: 'Must be a valid ' + label,
  });
}

export const ProjectIdSchema = idSchema(isProjectId, 'ProjectId (proj_...)');
export const ProjectRevisionIdSchema = idSchema(isProjectRevisionId, 'ProjectRevisionId (rev_...)');
export const SnapshotIdSchema = idSchema(isSnapshotId, 'SnapshotId (snap_...)');
export const ProjectContextSnapshotIdSchema = idSchema(
  isProjectContextSnapshotId,
  'ProjectContextSnapshotId (ctx_...)',
);
export const QARunIdSchema = idSchema(isQARunId, 'QARunId (run_...)');
export const AgentRunIdSchema = idSchema(isAgentRunId, 'AgentRunId (arun_...)');
export const AgentStackIdSchema = idSchema(isAgentStackId, 'AgentStackId (stack_...)');
export const InvestigationPlanIdSchema = idSchema(
  isInvestigationPlanId,
  'InvestigationPlanId (plan_...)',
);
export const InvestigationHypothesisIdSchema = idSchema(
  isInvestigationHypothesisId,
  'InvestigationHypothesisId (hyp_...)',
);
export const FindingIdSchema = idSchema(isFindingId, 'FindingId (find_...)');
export const EvidenceIdSchema = idSchema(isEvidenceId, 'EvidenceId (ev_...)');
export const UnifiedIssueIdSchema = idSchema(isUnifiedIssueId, 'UnifiedIssueId (issue_...)');
export const VerificationIdSchema = idSchema(isVerificationId, 'VerificationId (verify_...)');
export const VerificationRunIdSchema = idSchema(
  isVerificationRunId,
  'VerificationRunId (vrun_...)',
);
export const VerificationAttemptIdSchema = idSchema(
  isVerificationAttemptId,
  'VerificationAttemptId (vattempt_...)',
);
export const VerificationStepIdSchema = idSchema(
  isVerificationStepId,
  'VerificationStepId (vstep_...)',
);
export const VerificationObservationIdSchema = idSchema(
  isVerificationObservationId,
  'VerificationObservationId (vobs_...)',
);
export const FixProposalIdSchema = idSchema(isFixProposalId, 'FixProposalId (fix_...)');
export const CICDPlanIdSchema = idSchema(isCICDPlanId, 'CICDPlanId (cicd_...)');
export const ArtifactIdSchema = idSchema(isArtifactId, 'ArtifactId (artifact_...)');
export const HarnessEventIdSchema = idSchema(isHarnessEventId, 'HarnessEventId (evt_...)');
export const RunActivityIdSchema = idSchema(isRunActivityId, 'RunActivityId (activity_...)');
export const OperationIdSchema = idSchema(isOperationId, 'OperationId (op_...)');
export const RuntimeInstanceIdSchema = idSchema(
  isRuntimeInstanceId,
  'RuntimeInstanceId (runtime_...)',
);

/**
 * Project-relative path (forward slashes). Rejects absolute Windows
 * (C:\... / \\share), absolute Unix (/home/...) and '..' escapes so
 * transport payloads can never smuggle local machine paths.
 */
export const RelativePathSchema = z
  .string()
  .min(1, { message: 'Relative path must not be empty' })
  .max(500, { message: 'Relative path too long' })
  .refine((p) => !p.includes('\\'), { message: 'Use forward slashes, not backslashes' })
  .refine((p) => !/^[a-zA-Z]:[\\/]/.test(p), { message: 'Absolute Windows paths are rejected' })
  .refine((p) => !p.startsWith('/'), { message: 'Absolute Unix paths are rejected' })
  .refine((p) => !p.startsWith('\\\\'), { message: 'UNC network paths are rejected' })
  .refine((p) => !p.includes('\0'), { message: 'Path must not contain null bytes' })
  .refine((p) => !p.split('/').includes('..'), { message: 'Path must not escape with ..' });

/** Lowercase/uppercase hex SHA-256 digest. */
export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, { message: 'Must be a 64-char hex SHA-256 digest' });

/** Current-version marker for persisted / transported structures. Phase 1 is strict: only 1. */
export const SchemaVersionSchema = z.literal(1);

export const NonNegativeIntSchema = z.number().int().min(0);
export const NonNegativeSafeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const NonNegativeNumberSchema = z.number().min(0);
export const ShortTextSchema = z.string().min(1).max(200);
