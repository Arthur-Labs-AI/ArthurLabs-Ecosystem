import type { KnowledgeObjectKind } from "./cognitive";
import { isRevisionDiff, type RevisionDiff } from "./lineage";

/*
 * Automatic Thought Evolution (M04.7B Phase 5): review-first.
 *
 * Arthur may SUGGEST a new version of an idea when a new capture adds to, corrects or replaces it. A suggestion is never applied by
 * itself: it is stored as a proposal and changes the idea only when the person approves it. These contracts mirror the native layer's
 * JSON. The UI never writes revisions, never reads a credential, and never decides whether something is safe to apply.
 */

/** The three separate permissions. None implies another, and an API key is never a permission. */
export type EvolutionConsentKind = "typesafe" | "synthesis" | "verification";

export const EVOLUTION_BLOCKERS = ["typesafe_consent", "typesafe_credential", "llm_credential", "synthesis_authorization", "verification_authorization"] as const;
export type EvolutionBlocker = (typeof EVOLUTION_BLOCKERS)[number];

export interface EvolutionProviderStatus {
  /** The provider's name as it is shown to the person. The UI never hard-codes one. */
  provider: string;
  /** The person agreed to the CURRENT disclosure. */
  consented: boolean;
  hasCredential: boolean;
  /** Granting must name this version, so a consent is always for the text that was shown. */
  disclosureVersion: string;
  /** The facts to show before asking. Plain sentences. */
  disclosure: string[];
}

export interface EvolutionStatus {
  /** The saved switch. Off until the person turns it on. */
  enabled: boolean;
  /** The only mode: a suggestion is never applied without the person's approval. */
  mode: "review_first";
  /** Every consent and credential it needs exists right now. */
  ready: boolean;
  /** Switched on AND ready: new suggestions can be produced. */
  active: boolean;
  blockers: EvolutionBlocker[];
  typesafe: EvolutionProviderStatus;
  synthesis: EvolutionProviderStatus;
  verification: EvolutionProviderStatus;
  /** The check is the same model family as the suggestion, so it is a self-check, not an independent review. */
  sameFamilyVerification: boolean;
}

export type ProposalState = "open" | "deferred" | "approved" | "rejected" | "separated" | "superseded";
export type ProposalChange = "additive" | "correction" | "replacement";
export type VerificationMode = "independent" | "same_family_review";
export type ProposalBlocked = "project_archived" | "claim_moved" | "object_missing";

export interface ProposalVerification {
  mode: VerificationMode;
  status: "passed";
  synthesisModel: string;
  verifierModel: string;
}

export interface ProposalCurrentText {
  revisionId: string;
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
  /** `initial`, `user_edit`, `distillation`, `merge` or `system`. */
  origin: string;
}

export interface ProposalClaim {
  pendingId: string;
  captureId: string;
  ordinal: number;
  kind: KnowledgeObjectKind;
  title: string;
  body: string;
  sourceStart: number;
  sourceEnd: number;
  /** Why this was held for a person (stable codes such as `review_required`, `ambiguous_target`, `stale_target`). */
  reasons: string[];
  state: "open" | "deferred" | "accepted" | "separated";
}

export interface ProposalEvidence {
  /** `existing`: what already supported the idea. `claim`: the new note's exact words. */
  role: "existing" | "claim";
  captureId: string;
  start: number;
  end: number;
}

export interface RevisionProposal {
  id: string;
  state: ProposalState;
  change: ProposalChange;
  objectId: string;
  projectId: string;
  projectArchived: boolean;
  /** The revision the suggestion was written for. */
  baseRevisionId: string;
  /** The idea's text right now. */
  current: ProposalCurrentText | null;
  proposed: { kind: KnowledgeObjectKind; title: string; body: string };
  /** Words that differ between the current text and the suggestion. */
  diff: RevisionDiff | null;
  verification: ProposalVerification;
  claim: ProposalClaim;
  evidence: ProposalEvidence[];
  /** The idea changed after the suggestion was written: it cannot be approved as it is. */
  stale: boolean;
  blocked: ProposalBlocked | null;
  /** The person changed the words before approving; `finalBody` is what they approved. */
  userEdited: boolean;
  finalBody: string | null;
  resultRevisionId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface UnresolvedClaim {
  claim: ProposalClaim;
  projectId: string;
  projectArchived: boolean;
  dueAt: string | null;
  createdAt: string;
  candidates: { objectId: string; title: string; currentRevisionId: string }[];
  /** The claim's suggestion, if it has one. `null`: Arthur has no suggested text and none is invented. */
  proposalId: string | null;
  proposalState: ProposalState | null;
  /** The note looks like it changes what the idea IS: no text is suggested for that. */
  reframing: boolean;
}

export type ReviewAction = "approve" | "edit_approve" | "reject" | "keep_separate" | "defer" | "reopen";

export interface ReviewProposalInput {
  proposalId: string;
  action: ReviewAction;
  /** The person's own text, for `edit_approve`. */
  editedBody?: string;
  /** The revision whose text the person was reading. Approving requires it to still be the current one. */
  reviewedRevisionId?: string;
  dueAt?: string;
}

export interface ReviewOutcome {
  proposal: RevisionProposal;
  /** `false`: the same decision had already been made and nothing was written. */
  applied: boolean;
  revisionId: string | null;
  createdObjectId: string | null;
}

export type ClaimResolveAction = "keep_separate" | "defer" | "reopen";

export interface ResolveClaimInput {
  pendingId: string;
  action: ClaimResolveAction;
  dueAt?: string;
}

export interface ClaimOutcome {
  claimState: string;
  createdObjectId: string | null;
  applied: boolean;
}

/** How an approved revision came about. The revision itself is stored as an automatic one; THIS says a person approved it. */
export interface ApprovalInfo {
  revisionId: string;
  proposalId: string;
  userEdited: boolean;
  approvedAt: string;
  verificationMode: VerificationMode;
  synthesisModel: string;
}

export const EVOLUTION_ERROR_CODES = [
  "proposal_not_found",
  "stale",
  "already_resolved",
  "blocked",
  "invalid",
  "conflict",
  "storage_failed",
  "not_ready",
  "disclosure_outdated",
  "invalid_credential",
  "credential_not_saved",
  "credential_not_removed",
  "settings_not_saved",
  "consent_not_saved",
  "object_not_found",
  "project_archived",
] as const;
export type EvolutionErrorCode = (typeof EVOLUTION_ERROR_CODES)[number];

export interface EvolutionErrorPayload {
  code: EvolutionErrorCode;
  message: string;
  /** For `stale`: the revision that is current now. */
  currentRevisionId?: string | null;
}

export function isEvolutionErrorPayload(value: unknown): value is EvolutionErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.code === "string" && (EVOLUTION_ERROR_CODES as readonly string[]).includes(c.code) && typeof c.message === "string";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const PROPOSAL_STATES: readonly string[] = ["open", "deferred", "approved", "rejected", "separated", "superseded"];
const KINDS: readonly string[] = ["idea", "task", "decision", "question", "note"];

function isProviderStatus(value: unknown): value is EvolutionProviderStatus {
  return isRecord(value) && isString(value.provider) && isBoolean(value.consented) && isBoolean(value.hasCredential) && isString(value.disclosureVersion) && Array.isArray(value.disclosure) && value.disclosure.every(isString);
}

export function isEvolutionStatus(value: unknown): value is EvolutionStatus {
  if (!isRecord(value)) return false;
  return (
    isBoolean(value.enabled) &&
    value.mode === "review_first" &&
    isBoolean(value.ready) &&
    isBoolean(value.active) &&
    Array.isArray(value.blockers) &&
    value.blockers.every((b) => (EVOLUTION_BLOCKERS as readonly unknown[]).includes(b)) &&
    isProviderStatus(value.typesafe) &&
    isProviderStatus(value.synthesis) &&
    isProviderStatus(value.verification) &&
    isBoolean(value.sameFamilyVerification)
  );
}

function isClaim(value: unknown): value is ProposalClaim {
  return (
    isRecord(value) &&
    isString(value.pendingId) &&
    isString(value.captureId) &&
    isNumber(value.ordinal) &&
    KINDS.includes(value.kind as string) &&
    isString(value.title) &&
    isString(value.body) &&
    isNumber(value.sourceStart) &&
    isNumber(value.sourceEnd) &&
    Array.isArray(value.reasons) &&
    value.reasons.every(isString) &&
    ["open", "deferred", "accepted", "separated"].includes(value.state as string)
  );
}

function isCurrentText(value: unknown): value is ProposalCurrentText {
  return isRecord(value) && isString(value.revisionId) && KINDS.includes(value.kind as string) && isString(value.title) && isString(value.body) && isString(value.origin);
}

export function isRevisionProposal(value: unknown): value is RevisionProposal {
  if (!isRecord(value)) return false;
  const verification = value.verification;
  const proposed = value.proposed;
  return (
    isString(value.id) &&
    PROPOSAL_STATES.includes(value.state as string) &&
    ["additive", "correction", "replacement"].includes(value.change as string) &&
    isString(value.objectId) &&
    isString(value.projectId) &&
    isBoolean(value.projectArchived) &&
    isString(value.baseRevisionId) &&
    (value.current === null || isCurrentText(value.current)) &&
    isRecord(proposed) &&
    KINDS.includes(proposed.kind as string) &&
    isString(proposed.title) &&
    isString(proposed.body) &&
    (value.diff === null || isRevisionDiff(value.diff)) &&
    isRecord(verification) &&
    ["independent", "same_family_review"].includes(verification.mode as string) &&
    verification.status === "passed" &&
    isString(verification.synthesisModel) &&
    isString(verification.verifierModel) &&
    isClaim(value.claim) &&
    Array.isArray(value.evidence) &&
    value.evidence.every((e) => isRecord(e) && (e.role === "existing" || e.role === "claim") && isString(e.captureId) && isNumber(e.start) && isNumber(e.end)) &&
    isBoolean(value.stale) &&
    (value.blocked === null || ["project_archived", "claim_moved", "object_missing"].includes(value.blocked as string)) &&
    isBoolean(value.userEdited) &&
    isStringOrNull(value.finalBody) &&
    isStringOrNull(value.resultRevisionId) &&
    isString(value.createdAt) &&
    isStringOrNull(value.reviewedAt)
  );
}

export function isUnresolvedClaim(value: unknown): value is UnresolvedClaim {
  if (!isRecord(value)) return false;
  return (
    isClaim(value.claim) &&
    isString(value.projectId) &&
    isBoolean(value.projectArchived) &&
    isStringOrNull(value.dueAt) &&
    isString(value.createdAt) &&
    Array.isArray(value.candidates) &&
    value.candidates.every((c) => isRecord(c) && isString(c.objectId) && isString(c.title) && isString(c.currentRevisionId)) &&
    isStringOrNull(value.proposalId) &&
    (value.proposalState === null || PROPOSAL_STATES.includes(value.proposalState as string)) &&
    isBoolean(value.reframing)
  );
}

export function isReviewOutcome(value: unknown): value is ReviewOutcome {
  return isRecord(value) && isRevisionProposal(value.proposal) && isBoolean(value.applied) && isStringOrNull(value.revisionId) && isStringOrNull(value.createdObjectId);
}

export function isClaimOutcome(value: unknown): value is ClaimOutcome {
  return isRecord(value) && isString(value.claimState) && isStringOrNull(value.createdObjectId) && isBoolean(value.applied);
}

export function isApprovalInfo(value: unknown): value is ApprovalInfo {
  return isRecord(value) && isString(value.revisionId) && isString(value.proposalId) && isBoolean(value.userEdited) && isString(value.approvedAt) && ["independent", "same_family_review"].includes(value.verificationMode as string) && isString(value.synthesisModel);
}

/** The most text a person may approve for one idea (mirrors the native limit). */
export const MAX_PROPOSAL_BODY_CHARS = 2000;

/** Why a review request is malformed, or `null`. The native layer re-checks everything; this only saves a round trip. */
export function describeReviewInputProblem(input: ReviewProposalInput): string | null {
  if (!input.proposalId) return "That suggestion is missing.";
  if (input.action === "edit_approve") {
    const text = (input.editedBody ?? "").trim();
    if (text.length === 0) return "Write the text you want to keep.";
    if ([...text].length > MAX_PROPOSAL_BODY_CHARS) return `Keep it under ${MAX_PROPOSAL_BODY_CHARS} characters.`;
    if (!input.reviewedRevisionId) return "Open the current text before editing.";
  }
  if (input.action === "approve" && !input.reviewedRevisionId) return "Open the current text before approving.";
  return null;
}
