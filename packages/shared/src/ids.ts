/**
 * Opaque ID boundary.
 *
 * The domain never uses database auto-increment integers as identity.
 * Every generated ID is an opaque string with a human-recognizable prefix
 * (proj_, snap_, run_, ...) followed by a 26-character ULID-style suffix
 * (time-ordered Crockford base32). No workspace package may depend on a
 * third-party ID library: generation lives behind the create*Id() helpers.
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type ProjectId = Brand<string, 'ProjectId'>;
export type ProjectRevisionId = Brand<string, 'ProjectRevisionId'>;
export type SnapshotId = Brand<string, 'SnapshotId'>;
export type ProjectContextSnapshotId = Brand<string, 'ProjectContextSnapshotId'>;
export type QARunId = Brand<string, 'QARunId'>;
export type AgentRunId = Brand<string, 'AgentRunId'>;
export type AgentStackId = Brand<string, 'AgentStackId'>;
export type InvestigationPlanId = Brand<string, 'InvestigationPlanId'>;
export type InvestigationHypothesisId = Brand<string, 'InvestigationHypothesisId'>;
export type FindingId = Brand<string, 'FindingId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type UnifiedIssueId = Brand<string, 'UnifiedIssueId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type VerificationRunId = Brand<string, 'VerificationRunId'>;
export type VerificationAttemptId = Brand<string, 'VerificationAttemptId'>;
export type VerificationStepId = Brand<string, 'VerificationStepId'>;
export type VerificationObservationId = Brand<string, 'VerificationObservationId'>;
export type FixProposalId = Brand<string, 'FixProposalId'>;
export type CICDPlanId = Brand<string, 'CICDPlanId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type HarnessEventId = Brand<string, 'HarnessEventId'>;
export type RunActivityId = Brand<string, 'RunActivityId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type RuntimeInstanceId = Brand<string, 'RuntimeInstanceId'>;
export type IssueId = Brand<string, 'IssueId'>;
export type IssueOccurrenceId = Brand<string, 'IssueOccurrenceId'>;
export type IssueEventId = Brand<string, 'IssueEventId'>;
export type RetestRunId = Brand<string, 'RetestRunId'>;
export type RetestAssessmentId = Brand<string, 'RetestAssessmentId'>;

export const ID_PREFIXES = {
  project: 'proj',
  projectRevision: 'rev',
  snapshot: 'snap',
  projectContextSnapshot: 'ctx',
  qaRun: 'run',
  agentRun: 'arun',
  agentStack: 'stack',
  investigationPlan: 'plan',
  investigationHypothesis: 'hyp',
  finding: 'find',
  evidence: 'ev',
  unifiedIssue: 'issue',
  verification: 'verify',
  verificationRun: 'vrun',
  verificationAttempt: 'vattempt',
  verificationStep: 'vstep',
  verificationObservation: 'vobs',
  fixProposal: 'fix',
  cicdPlan: 'cicd',
  artifact: 'artifact',
  harnessEvent: 'evt',
  runActivity: 'activity',
  operation: 'op',
  runtimeInstance: 'runtime',
  issue: 'issue',
  issueOccurrence: 'occ',
  issueEvent: 'iev',
  retestRun: 'retest',
  retestAssessment: 'reassess',
} as const;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCrockford(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const b = bytes[i] as number;
    // 256 is exactly divisible by 32, so this mapping has no modulo bias.
    out += CROCKFORD[b % 32];
  }
  return out;
}

function timeCrockford(nowMs: number): string {
  let value = Math.floor(nowMs);
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/** Generate a ULID-shaped suffix (26 chars, time-ordered + random). */
export function ulidSuffix(nowMs: number = Date.now()): string {
  return timeCrockford(nowMs) + randomCrockford(16);
}

function make(prefix: string, nowMs?: number): string {
  return prefix + '_' + ulidSuffix(nowMs);
}

const SUFFIX = '[0-9A-HJKMNP-TV-Z]{26}';

function isPrefixed(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && new RegExp('^' + prefix + '_' + SUFFIX + '$').test(value);
}

export function createProjectId(nowMs?: number): ProjectId {
  return make(ID_PREFIXES.project, nowMs) as ProjectId;
}
export function createProjectRevisionId(nowMs?: number): ProjectRevisionId {
  return make(ID_PREFIXES.projectRevision, nowMs) as ProjectRevisionId;
}
export function createSnapshotId(nowMs?: number): SnapshotId {
  return make(ID_PREFIXES.snapshot, nowMs) as SnapshotId;
}
export function createProjectContextSnapshotId(nowMs?: number): ProjectContextSnapshotId {
  return make(ID_PREFIXES.projectContextSnapshot, nowMs) as ProjectContextSnapshotId;
}
export function createQARunId(nowMs?: number): QARunId {
  return make(ID_PREFIXES.qaRun, nowMs) as QARunId;
}
export function createAgentRunId(nowMs?: number): AgentRunId {
  return make(ID_PREFIXES.agentRun, nowMs) as AgentRunId;
}
export function createAgentStackId(nowMs?: number): AgentStackId {
  return make(ID_PREFIXES.agentStack, nowMs) as AgentStackId;
}
export function createInvestigationPlanId(nowMs?: number): InvestigationPlanId {
  return make(ID_PREFIXES.investigationPlan, nowMs) as InvestigationPlanId;
}
export function createInvestigationHypothesisId(nowMs?: number): InvestigationHypothesisId {
  return make(ID_PREFIXES.investigationHypothesis, nowMs) as InvestigationHypothesisId;
}
export function createFindingId(nowMs?: number): FindingId {
  return make(ID_PREFIXES.finding, nowMs) as FindingId;
}
export function createEvidenceId(nowMs?: number): EvidenceId {
  return make(ID_PREFIXES.evidence, nowMs) as EvidenceId;
}
export function createUnifiedIssueId(nowMs?: number): UnifiedIssueId {
  return make(ID_PREFIXES.unifiedIssue, nowMs) as UnifiedIssueId;
}
export function createVerificationId(nowMs?: number): VerificationId {
  return make(ID_PREFIXES.verification, nowMs) as VerificationId;
}
export function createVerificationRunId(nowMs?: number): VerificationRunId {
  return make(ID_PREFIXES.verificationRun, nowMs) as VerificationRunId;
}
export function createVerificationAttemptId(nowMs?: number): VerificationAttemptId {
  return make(ID_PREFIXES.verificationAttempt, nowMs) as VerificationAttemptId;
}
export function createVerificationStepId(nowMs?: number): VerificationStepId {
  return make(ID_PREFIXES.verificationStep, nowMs) as VerificationStepId;
}
export function createVerificationObservationId(nowMs?: number): VerificationObservationId {
  return make(ID_PREFIXES.verificationObservation, nowMs) as VerificationObservationId;
}
export function createFixProposalId(nowMs?: number): FixProposalId {
  return make(ID_PREFIXES.fixProposal, nowMs) as FixProposalId;
}
export function createCICDPlanId(nowMs?: number): CICDPlanId {
  return make(ID_PREFIXES.cicdPlan, nowMs) as CICDPlanId;
}
export function createArtifactId(nowMs?: number): ArtifactId {
  return make(ID_PREFIXES.artifact, nowMs) as ArtifactId;
}
export function createHarnessEventId(nowMs?: number): HarnessEventId {
  return make(ID_PREFIXES.harnessEvent, nowMs) as HarnessEventId;
}
export function createRunActivityId(nowMs?: number): RunActivityId {
  return make(ID_PREFIXES.runActivity, nowMs) as RunActivityId;
}
export function createOperationId(nowMs?: number): OperationId {
  return make(ID_PREFIXES.operation, nowMs) as OperationId;
}
export function createIssueId(nowMs?: number): IssueId {
  return make(ID_PREFIXES.issue, nowMs) as IssueId;
}
export function createIssueOccurrenceId(nowMs?: number): IssueOccurrenceId {
  return make(ID_PREFIXES.issueOccurrence, nowMs) as IssueOccurrenceId;
}
export function createIssueEventId(nowMs?: number): IssueEventId {
  return make(ID_PREFIXES.issueEvent, nowMs) as IssueEventId;
}
export function createRetestRunId(nowMs?: number): RetestRunId {
  return make(ID_PREFIXES.retestRun, nowMs) as RetestRunId;
}
export function createRetestAssessmentId(nowMs?: number): RetestAssessmentId {
  return make(ID_PREFIXES.retestAssessment, nowMs) as RetestAssessmentId;
}
export function createRuntimeInstanceId(nowMs?: number): RuntimeInstanceId {
  return make(ID_PREFIXES.runtimeInstance, nowMs) as RuntimeInstanceId;
}

export function isProjectId(v: unknown): v is ProjectId {
  return isPrefixed(v, ID_PREFIXES.project);
}
export function isProjectRevisionId(v: unknown): v is ProjectRevisionId {
  return isPrefixed(v, ID_PREFIXES.projectRevision);
}
export function isSnapshotId(v: unknown): v is SnapshotId {
  return isPrefixed(v, ID_PREFIXES.snapshot);
}
export function isProjectContextSnapshotId(v: unknown): v is ProjectContextSnapshotId {
  return isPrefixed(v, ID_PREFIXES.projectContextSnapshot);
}
export function isQARunId(v: unknown): v is QARunId {
  return isPrefixed(v, ID_PREFIXES.qaRun);
}
export function isAgentRunId(v: unknown): v is AgentRunId {
  return isPrefixed(v, ID_PREFIXES.agentRun);
}
export function isAgentStackId(v: unknown): v is AgentStackId {
  return (
    isPrefixed(v, ID_PREFIXES.agentStack) ||
    (typeof v === 'string' && /^stack_[a-z0-9][a-z0-9_-]{0,63}$/.test(v))
  );
}
export function isInvestigationPlanId(v: unknown): v is InvestigationPlanId {
  return isPrefixed(v, ID_PREFIXES.investigationPlan);
}
export function isInvestigationHypothesisId(v: unknown): v is InvestigationHypothesisId {
  return isPrefixed(v, ID_PREFIXES.investigationHypothesis);
}
export function isFindingId(v: unknown): v is FindingId {
  return isPrefixed(v, ID_PREFIXES.finding);
}
export function isEvidenceId(v: unknown): v is EvidenceId {
  return isPrefixed(v, ID_PREFIXES.evidence);
}
export function isUnifiedIssueId(v: unknown): v is UnifiedIssueId {
  return isPrefixed(v, ID_PREFIXES.unifiedIssue);
}
export function isVerificationId(v: unknown): v is VerificationId {
  return isPrefixed(v, ID_PREFIXES.verification);
}
export function isVerificationRunId(v: unknown): v is VerificationRunId {
  return isPrefixed(v, ID_PREFIXES.verificationRun);
}
export function isVerificationAttemptId(v: unknown): v is VerificationAttemptId {
  return isPrefixed(v, ID_PREFIXES.verificationAttempt);
}
export function isVerificationStepId(v: unknown): v is VerificationStepId {
  return isPrefixed(v, ID_PREFIXES.verificationStep);
}
export function isVerificationObservationId(v: unknown): v is VerificationObservationId {
  return isPrefixed(v, ID_PREFIXES.verificationObservation);
}
export function isFixProposalId(v: unknown): v is FixProposalId {
  return isPrefixed(v, ID_PREFIXES.fixProposal);
}
export function isCICDPlanId(v: unknown): v is CICDPlanId {
  return isPrefixed(v, ID_PREFIXES.cicdPlan);
}
export function isArtifactId(v: unknown): v is ArtifactId {
  return isPrefixed(v, ID_PREFIXES.artifact);
}
export function isHarnessEventId(v: unknown): v is HarnessEventId {
  return isPrefixed(v, ID_PREFIXES.harnessEvent);
}
export function isRunActivityId(v: unknown): v is RunActivityId {
  return isPrefixed(v, ID_PREFIXES.runActivity);
}
export function isOperationId(v: unknown): v is OperationId {
  return isPrefixed(v, ID_PREFIXES.operation);
}
export function isIssueId(v: unknown): v is IssueId {
  return isPrefixed(v, ID_PREFIXES.issue);
}
export function isIssueOccurrenceId(v: unknown): v is IssueOccurrenceId {
  return isPrefixed(v, ID_PREFIXES.issueOccurrence);
}
export function isIssueEventId(v: unknown): v is IssueEventId {
  return isPrefixed(v, ID_PREFIXES.issueEvent);
}
export function isRetestRunId(v: unknown): v is RetestRunId {
  return isPrefixed(v, ID_PREFIXES.retestRun);
}
export function isRetestAssessmentId(v: unknown): v is RetestAssessmentId {
  return isPrefixed(v, ID_PREFIXES.retestAssessment);
}
export function isRuntimeInstanceId(v: unknown): v is RuntimeInstanceId {
  return isPrefixed(v, ID_PREFIXES.runtimeInstance);
}
