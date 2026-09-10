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
export type SnapshotId = Brand<string, 'SnapshotId'>;
export type QARunId = Brand<string, 'QARunId'>;
export type AgentRunId = Brand<string, 'AgentRunId'>;
export type AgentStackId = Brand<string, 'AgentStackId'>;
export type FindingId = Brand<string, 'FindingId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type UnifiedIssueId = Brand<string, 'UnifiedIssueId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type FixProposalId = Brand<string, 'FixProposalId'>;
export type CICDPlanId = Brand<string, 'CICDPlanId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type HarnessEventId = Brand<string, 'HarnessEventId'>;

export const ID_PREFIXES = {
  project: 'proj',
  snapshot: 'snap',
  qaRun: 'run',
  agentRun: 'arun',
  agentStack: 'stack',
  finding: 'find',
  evidence: 'ev',
  unifiedIssue: 'issue',
  verification: 'verify',
  fixProposal: 'fix',
  cicdPlan: 'cicd',
  artifact: 'artifact',
  harnessEvent: 'evt',
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
export function createSnapshotId(nowMs?: number): SnapshotId {
  return make(ID_PREFIXES.snapshot, nowMs) as SnapshotId;
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

export function isProjectId(v: unknown): v is ProjectId {
  return isPrefixed(v, ID_PREFIXES.project);
}
export function isSnapshotId(v: unknown): v is SnapshotId {
  return isPrefixed(v, ID_PREFIXES.snapshot);
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
