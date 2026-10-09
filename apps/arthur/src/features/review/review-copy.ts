import type { ProposalChange, ProposalState, UnresolvedClaim } from "@arthur/contracts";

/** Plain-language reasons a note was held for a decision. Keys are the stable codes the native layer records. */
const REASONS: Record<string, string> = {
  review_required: "Arthur never changes an idea on its own. You decide.",
  ambiguous_target: "More than one of your ideas could be the one this note belongs to.",
  runs_disagree: "Arthur wasn't sure which idea this note belongs to.",
  weak_evidence: "Arthur wasn't sure this note is about the same thing as the idea.",
  fundamental_reframing: "This note seems to change what the idea is about, so Arthur did not write a new version.",
  reframing_signal: "This note seems to change what the idea is about, so Arthur did not write a new version.",
  subtask_of_target: "This looks like a step toward an idea, not a change to it.",
  supersession_not_explicit: "The note doesn't say it replaces the earlier choice.",
  not_a_prior_decision: "The idea isn't a decision, so there is nothing to replace.",
  referent_unresolved: "The note doesn't say what it refers to.",
  user_owned_revision: "You edited this idea yourself, so Arthur asks before changing it.",
  inbox_requires_confirmation: "Ideas in the Inbox are always confirmed by you.",
  incompatible_kind: "The note and the idea are different kinds of thing.",
  conflicting_claims: "Two notes from the same capture pointed at one idea.",
  stale_target: "The idea changed while Arthur was working on it, so nothing was written.",
  invalid_draft: "Arthur's suggested text did not pass its checks, so it was not kept.",
  draft_bad_reference: "Arthur's suggested text did not pass its checks, so it was not kept.",
  draft_unsupported_fact: "Arthur's suggested text added something your notes don't say, so it was not kept.",
  draft_omits_fact: "Arthur's suggested text dropped something your idea says, so it was not kept.",
  draft_scope_change: "Arthur's suggested text changed what the idea claims, so it was not kept.",
  verifier_veto: "Arthur's own check rejected the suggested text, so it was not kept.",
  verifier_unavailable: "Arthur couldn't check a suggestion this time, so none was kept.",
  synthesis_unavailable: "Arthur couldn't write a suggestion this time.",
  evolution_withdrawn: "A permission was turned off while Arthur was working, so nothing was kept.",
  classifier_failed: "Arthur couldn't reach the service that matches notes to ideas.",
};

/** The distinct, readable reasons for a note. `review_required` is the generic one and is dropped when a specific reason exists. */
export function reasonLines(reasons: readonly string[]): string[] {
  const lines = new Set<string>();
  const specific = reasons.filter((reason) => reason !== "review_required");
  for (const reason of specific.length > 0 ? specific : reasons) lines.add(REASONS[reason] ?? "This needs your decision.");
  return [...lines];
}

export const CHANGE_LABELS: Record<ProposalChange, string> = {
  additive: "Suggested addition",
  correction: "Suggested correction",
  replacement: "Suggested replacement",
};

export const STATE_LABELS: Record<ProposalState, string> = {
  open: "Waiting for you",
  deferred: "Later",
  approved: "Approved",
  rejected: "Dismissed",
  separated: "Kept as its own idea",
  superseded: "Resolved another way",
};

/** The model names come from the native record of how the suggestion was made; none is written here. */
export const verificationWarning = (model: string): string =>
  `Checked by the same AI model family that wrote it (${model}). That is a self-check, not an independent review, and it can miss the same mistakes. Read it before you approve.`;

export const modelLabel = (model: string): string => `Written by ${model}`;

/** A short excerpt of a note for a list row (code points, so Bulgarian and emoji are never cut in half). */
export function excerpt(text: string, max = 120): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

export function waitingTitle(entry: UnresolvedClaim): string {
  return entry.claim.title;
}
