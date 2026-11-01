//! Durable revision proposals and their review (M04.7B Phase 5, schema v9).
//!
//! A proposal is a draft revision that was synthesized, validated and checked but may NOT be applied without a person: every same-family
//! review ends here. It is linked 1:1 to the pending claim that keeps the captured knowledge, so rejecting, expiring or losing a draft can
//! never lose the claim.
//!
//! ```text
//! pipeline commit:   pending claim (open) + proposal (open)            one transaction, never a revision
//! review:            approve / edit+approve  -> compare-and-set revision + claim evidence + claim accepted + proposal approved
//!                    reject                  -> proposal rejected; the claim stays open and visible
//!                    keep separate           -> new object from the claim + claim separated + proposal separated
//!                    defer / reopen          -> claim and proposal deferred / open together
//! ```
//! Every review operation runs in ONE immediate transaction, so concurrent attempts are serialized by SQLite and repeating one is
//! idempotent. Applying a proposal re-reads the object's CURRENT revision: a proposal is only applied as written to the exact revision
//! it was generated for; if the object moved on, one-click approval is refused (`Stale`) and a person must re-review against the
//! current text. Nothing here calls a network or a model.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use uuid::Uuid;

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};
use super::evidence_store::{evidence_support_in, EvidenceRole};
use super::identity_store::{
    accept_pending_claim_hooked_in, defer_pending_claim_in, pending_in, reopen_pending_claim_in,
    separate_pending_claim_hooked_in, AcceptPendingInput, IdentityStoreError, PendingClaim,
};
use super::knowledge_store::{KINDS, MAX_BODY_CHARS, MAX_TITLE_CHARS};
use super::lineage_store::{ReviseConflict, RevisionContent};
use crate::lineage::diff::{diff_revisions, Content, RevisionDiff};

type Res<T> = Result<T, IdentityStoreError>;

pub const PROPOSAL_STATES: [&str; 6] = [
    "open",
    "deferred",
    "approved",
    "rejected",
    "separated",
    "superseded",
];

fn invalid<T>(reason: impl Into<String>) -> Res<T> {
    Err(IdentityStoreError::Invalid(reason.into()))
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Types.

/// One validated piece of evidence behind a proposal, as the server resolved it (never what a model claimed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    /// `existing`: stored support of the target's current text. `claim`: the new note's exact words.
    pub role: String,
    pub capture_id: String,
    pub start: i64,
    pub end: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewProposal {
    pub pending_claim_id: String,
    pub object_id: String,
    pub base_revision_id: String,
    /// `additive`, `correction` or `replacement`.
    pub change: String,
    pub kind: String,
    pub title: String,
    pub proposed_body: String,
    /// A stored evidence row of the target that this draft corrects or replaces, when exactly one is provable.
    pub retracts: Option<(String, i64)>,
    pub evidence: Vec<EvidenceRef>,
    pub synthesis_model: String,
    pub verifier_model: String,
    /// `independent` or `same_family_review`.
    pub verification_mode: String,
    pub policy_version: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RevisionProposal {
    pub id: String,
    pub pending_claim_id: String,
    pub object_id: String,
    pub base_revision_id: String,
    pub change: String,
    pub kind: String,
    pub title: String,
    pub proposed_body: String,
    pub retracts: Option<(String, i64)>,
    pub evidence: Vec<EvidenceRef>,
    pub synthesis_model: String,
    pub verifier_model: String,
    pub verification_mode: String,
    pub verification_status: String,
    pub policy_version: String,
    pub state: String,
    pub user_edited: bool,
    pub final_body: Option<String>,
    pub result_revision_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub reviewed_at: Option<String>,
}

const PROPOSAL_SELECT: &str = "SELECT id, pending_claim_id, object_id, base_revision_id, change, kind, title, proposed_body, retracts_revision_id, retracts_ordinal, evidence_json, \
    synthesis_model, verifier_model, verification_mode, verification_status, policy_version, state, user_edited, final_body, result_revision_id, created_at, updated_at, reviewed_at \
    FROM revision_proposals";

fn proposal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RevisionProposal> {
    let retracts = match (
        row.get::<_, Option<String>>(8)?,
        row.get::<_, Option<i64>>(9)?,
    ) {
        (Some(revision), Some(ordinal)) => Some((revision, ordinal)),
        _ => None,
    };
    let evidence: Vec<(String, String, i64, i64)> =
        serde_json::from_str::<Vec<serde_json::Value>>(&row.get::<_, String>(10)?)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| {
                Some((
                    item.get("role")?.as_str()?.to_string(),
                    item.get("captureId")?.as_str()?.to_string(),
                    item.get("start")?.as_i64()?,
                    item.get("end")?.as_i64()?,
                ))
            })
            .collect();
    Ok(RevisionProposal {
        id: row.get(0)?,
        pending_claim_id: row.get(1)?,
        object_id: row.get(2)?,
        base_revision_id: row.get(3)?,
        change: row.get(4)?,
        kind: row.get(5)?,
        title: row.get(6)?,
        proposed_body: row.get(7)?,
        retracts,
        evidence: evidence
            .into_iter()
            .map(|(role, capture_id, start, end)| EvidenceRef {
                role,
                capture_id,
                start,
                end,
            })
            .collect(),
        synthesis_model: row.get(11)?,
        verifier_model: row.get(12)?,
        verification_mode: row.get(13)?,
        verification_status: row.get(14)?,
        policy_version: row.get(15)?,
        state: row.get(16)?,
        user_edited: row.get::<_, i64>(17)? == 1,
        final_body: row.get(18)?,
        result_revision_id: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
        reviewed_at: row.get(22)?,
    })
}

pub fn proposal_in(connection: &Connection, id: &str) -> Res<Option<RevisionProposal>> {
    Ok(connection
        .query_row(
            &format!("{PROPOSAL_SELECT} WHERE id = ?1"),
            [id],
            proposal_from_row,
        )
        .optional()?)
}

pub fn proposal_for_claim_in(
    connection: &Connection,
    pending_claim_id: &str,
) -> Res<Option<RevisionProposal>> {
    Ok(connection
        .query_row(
            &format!("{PROPOSAL_SELECT} WHERE pending_claim_id = ?1"),
            [pending_claim_id],
            proposal_from_row,
        )
        .optional()?)
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Creating a proposal.

fn validate_new(input: &NewProposal) -> Res<()> {
    if !matches!(
        input.change.as_str(),
        "additive" | "correction" | "replacement"
    ) {
        return invalid("unknown change");
    }
    if !matches!(
        input.verification_mode.as_str(),
        "independent" | "same_family_review"
    ) {
        return invalid("unknown verification mode");
    }
    if !KINDS.contains(&input.kind.as_str()) {
        return invalid("unknown kind");
    }
    if input.title.trim().is_empty()
        || input.title.chars().count() > MAX_TITLE_CHARS
        || input.proposed_body.trim().is_empty()
        || input.proposed_body.chars().count() > MAX_BODY_CHARS
    {
        return invalid("title or body is empty or too long");
    }
    if input.evidence.is_empty()
        || input.evidence.len() > 13
        || input.evidence.iter().any(|e| {
            !matches!(e.role.as_str(), "existing" | "claim") || e.start < 0 || e.end <= e.start
        })
    {
        return invalid("a proposal names 1 to 13 valid evidence references");
    }
    for model in [&input.synthesis_model, &input.verifier_model] {
        if model.is_empty() || model.chars().count() > 128 {
            return invalid("a model id is empty or too long");
        }
    }
    Ok(())
}

/// Stores a proposal for an OPEN pending claim, in the caller's transaction. Idempotent: the claim already has its proposal -> that one
/// (`created == false`). The schema refuses a proposal whose base revision is not the object's current one.
pub fn insert_proposal_in(
    connection: &Connection,
    input: &NewProposal,
) -> Res<(RevisionProposal, bool)> {
    validate_new(input)?;
    if let Some(existing) = proposal_for_claim_in(connection, &input.pending_claim_id)? {
        return Ok((existing, false));
    }
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339()?;
    let evidence: Vec<serde_json::Value> = input.evidence.iter().map(|e| serde_json::json!({ "role": e.role, "captureId": e.capture_id, "start": e.start, "end": e.end })).collect();
    connection.execute(
        "INSERT INTO revision_proposals (id, pending_claim_id, object_id, base_revision_id, change, kind, title, proposed_body, retracts_revision_id, retracts_ordinal, evidence_json, \
         synthesis_model, verifier_model, verification_mode, verification_status, policy_version, state, user_edited, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'passed', ?15, 'open', 0, ?16, ?16)",
        params![
            id, input.pending_claim_id, input.object_id, input.base_revision_id, input.change, input.kind, input.title, input.proposed_body,
            input.retracts.as_ref().map(|r| r.0.as_str()), input.retracts.as_ref().map(|r| r.1), serde_json::to_string(&evidence).unwrap_or_default(),
            input.synthesis_model, input.verifier_model, input.verification_mode, input.policy_version, now
        ],
    )?;
    Ok((
        proposal_in(connection, &id)?.ok_or_else(|| {
            IdentityStoreError::Store(StoreError::Corrupt("a proposal vanished".into()))
        })?,
        true,
    ))
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading: what a review screen shows.

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentText {
    pub revision_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    /// `initial`, `user_edit`, `distillation`, `merge` or `system`.
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedText {
    pub kind: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationInfo {
    /// `independent` or `same_family_review`. A same-family review is the model checking its own family's draft: a self-check.
    pub mode: String,
    pub status: String,
    pub synthesis_model: String,
    pub verifier_model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimInfo {
    pub pending_id: String,
    pub capture_id: String,
    pub ordinal: i64,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub source_start: i64,
    pub source_end: i64,
    pub reasons: Vec<String>,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub id: String,
    /// `open`, `deferred`, `approved`, `rejected`, `separated` or `superseded`.
    pub state: String,
    /// `additive`, `correction` or `replacement`.
    pub change: String,
    pub object_id: String,
    pub project_id: String,
    pub project_archived: bool,
    pub base_revision_id: String,
    /// The object's text RIGHT NOW. `None` only if the object vanished.
    pub current: Option<CurrentText>,
    pub proposed: ProposedText,
    /// Word-level difference between the current text and the proposal.
    pub diff: Option<RevisionDiff>,
    pub verification: VerificationInfo,
    pub claim: ClaimInfo,
    pub evidence: Vec<EvidenceRef>,
    /// The object's current revision is no longer the one the draft was written for: one-click approval is refused.
    pub stale: bool,
    /// Why the proposal cannot be applied at all right now (`project_archived`, `claim_moved`, `object_missing`), if so.
    pub blocked: Option<String>,
    pub user_edited: bool,
    pub final_body: Option<String>,
    pub result_revision_id: Option<String>,
    pub created_at: String,
    pub reviewed_at: Option<String>,
}

struct ObjectNow {
    project_id: String,
    revision: CurrentText,
}

fn object_now_in(connection: &Connection, object_id: &str) -> Res<Option<ObjectNow>> {
    Ok(connection
        .query_row(
            "SELECT o.project_id, r.id, r.kind, r.title, r.body, r.origin FROM knowledge_objects o JOIN thought_revisions r ON r.id = o.current_revision_id WHERE o.id = ?1",
            [object_id],
            |row| Ok(ObjectNow { project_id: row.get(0)?, revision: CurrentText { revision_id: row.get(1)?, kind: row.get(2)?, title: row.get(3)?, body: row.get(4)?, origin: row.get(5)? } }),
        )
        .optional()?)
}

pub fn view_in(connection: &Connection, proposal: &RevisionProposal) -> Res<ProposalView> {
    let claim = pending_in(connection, &proposal.pending_claim_id)?.ok_or_else(|| {
        IdentityStoreError::Store(StoreError::Corrupt("a proposal lost its claim".into()))
    })?;
    let now = object_now_in(connection, &proposal.object_id)?;
    let stale = now
        .as_ref()
        .is_none_or(|n| n.revision.revision_id != proposal.base_revision_id);
    let blocked = match &now {
        None => Some("object_missing"),
        Some(n) if n.project_id != claim.project_id => Some("claim_moved"),
        _ if claim.project_archived => Some("project_archived"),
        _ => None,
    };
    let diff = now.as_ref().map(|n| {
        diff_revisions(
            &Content {
                id: &n.revision.revision_id,
                kind: &n.revision.kind,
                title: &n.revision.title,
                body: &n.revision.body,
            },
            &Content {
                id: "proposed",
                kind: &proposal.kind,
                title: &proposal.title,
                body: &proposal.proposed_body,
            },
        )
    });
    Ok(ProposalView {
        id: proposal.id.clone(),
        state: proposal.state.clone(),
        change: proposal.change.clone(),
        object_id: proposal.object_id.clone(),
        project_id: claim.project_id.clone(),
        project_archived: claim.project_archived,
        base_revision_id: proposal.base_revision_id.clone(),
        current: now.map(|n| n.revision),
        proposed: ProposedText {
            kind: proposal.kind.clone(),
            title: proposal.title.clone(),
            body: proposal.proposed_body.clone(),
        },
        diff,
        verification: VerificationInfo {
            mode: proposal.verification_mode.clone(),
            status: proposal.verification_status.clone(),
            synthesis_model: proposal.synthesis_model.clone(),
            verifier_model: proposal.verifier_model.clone(),
        },
        claim: claim_info(&claim),
        evidence: proposal.evidence.clone(),
        stale,
        blocked: blocked.map(str::to_string),
        user_edited: proposal.user_edited,
        final_body: proposal.final_body.clone(),
        result_revision_id: proposal.result_revision_id.clone(),
        created_at: proposal.created_at.clone(),
        reviewed_at: proposal.reviewed_at.clone(),
    })
}

fn claim_info(claim: &PendingClaim) -> ClaimInfo {
    ClaimInfo {
        pending_id: claim.id.clone(),
        capture_id: claim.capture_id.clone(),
        ordinal: claim.ordinal,
        kind: claim.kind.clone(),
        title: claim.title.clone(),
        body: claim.body.clone(),
        source_start: claim.source_start,
        source_end: claim.source_end,
        reasons: claim.reasons.clone(),
        state: claim.state.clone(),
    }
}

/// One unresolved claim for the review queue: the captured knowledge that is waiting for a decision, with or without a draft.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnresolvedClaimView {
    pub claim: ClaimInfo,
    pub project_id: String,
    pub project_archived: bool,
    pub due_at: Option<String>,
    pub created_at: String,
    pub candidates: Vec<CandidateInfo>,
    /// The claim's proposal, if it has one and it is still reviewable or was dismissed.
    pub proposal_id: Option<String>,
    pub proposal_state: Option<String>,
    pub reframing: bool,
}

/// How an approved revision came about, for the history view. The revision itself is stored with origin `system` (the schema only
/// allows evidence on such revisions); THIS record is what says a person approved it, and whether they changed the words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalInfo {
    pub revision_id: String,
    pub proposal_id: String,
    pub user_edited: bool,
    pub approved_at: String,
    pub verification_mode: String,
    pub synthesis_model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateInfo {
    pub object_id: String,
    pub title: String,
    pub current_revision_id: String,
}

fn unresolved_view_in(connection: &Connection, claim: &PendingClaim) -> Res<UnresolvedClaimView> {
    let mut candidates = Vec::new();
    for id in &claim.candidate_ids {
        if let Some(now) = object_now_in(connection, id)? {
            candidates.push(CandidateInfo {
                object_id: id.clone(),
                title: now.revision.title,
                current_revision_id: now.revision.revision_id,
            });
        }
    }
    let proposal = proposal_for_claim_in(connection, &claim.id)?;
    Ok(UnresolvedClaimView {
        claim: claim_info(claim),
        project_id: claim.project_id.clone(),
        project_archived: claim.project_archived,
        due_at: claim.due_at.clone(),
        created_at: claim.created_at.clone(),
        candidates,
        proposal_id: proposal.as_ref().map(|p| p.id.clone()),
        proposal_state: proposal.map(|p| p.state),
        reframing: claim.reframing,
    })
}

impl CaptureStore {
    #[cfg_attr(not(test), allow(dead_code))] // the pipeline stores proposals inside its own transaction (`insert_proposal_in`)
    pub fn insert_revision_proposal(&self, input: &NewProposal) -> Res<(RevisionProposal, bool)> {
        self.in_identity_transaction(|tx| insert_proposal_in(tx, input))
    }

    pub fn get_revision_proposal(&self, id: &str) -> Res<Option<ProposalView>> {
        self.in_identity_read(|c| proposal_in(c, id)?.map(|p| view_in(c, &p)).transpose())
    }

    /// Proposals in the given states (empty = all), optionally of one project (the claim's CURRENT project), oldest first.
    pub fn list_revision_proposals(
        &self,
        project_id: Option<&str>,
        states: &[&str],
    ) -> Res<Vec<ProposalView>> {
        if states.iter().any(|s| !PROPOSAL_STATES.contains(s)) {
            return invalid("unknown proposal state");
        }
        self.in_identity_read(|c| {
            let mut statement = c.prepare(&format!("{PROPOSAL_SELECT} ORDER BY seq"))?;
            let all = statement
                .query_map([], proposal_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            let mut out = Vec::new();
            for proposal in all
                .into_iter()
                .filter(|p| states.is_empty() || states.contains(&p.state.as_str()))
            {
                let view = view_in(c, &proposal)?;
                if project_id.is_none_or(|id| view.project_id == id) {
                    out.push(view);
                }
            }
            Ok(out)
        })
    }

    /// The revisions of this object that came from an approved proposal: how they were produced and whether the person edited the text.
    /// Revisions not listed here that carry `system` origin were made by the earlier automatic path.
    pub fn approvals_for_object(&self, object_id: &str) -> Res<Vec<ApprovalInfo>> {
        self.in_identity_read(|c| {
            let mut statement = c.prepare("SELECT result_revision_id, id, user_edited, reviewed_at, verification_mode, synthesis_model FROM revision_proposals WHERE object_id = ?1 AND state = 'approved' ORDER BY seq")?;
            let rows = statement
                .query_map([object_id], |row| {
                    Ok(ApprovalInfo { revision_id: row.get(0)?, proposal_id: row.get(1)?, user_edited: row.get::<_, i64>(2)? == 1, approved_at: row.get(3)?, verification_mode: row.get(4)?, synthesis_model: row.get(5)? })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Open and deferred claims (archived projects included, nothing filtered by age or quota), oldest first.
    pub fn list_unresolved_claims(
        &self,
        project_id: Option<&str>,
    ) -> Res<Vec<UnresolvedClaimView>> {
        let claims = self.list_pending_claims(project_id, &["open", "deferred"])?;
        self.in_identity_read(|c| {
            claims
                .iter()
                .map(|claim| unresolved_view_in(c, claim))
                .collect()
        })
    }

    /// Runs `work` against a consistent read of the database.
    fn in_identity_read<T>(&self, work: impl FnOnce(&Connection) -> Res<T>) -> Res<T> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        work(&connection)
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reviewing.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewAction {
    /// Apply the draft exactly as written, to the exact revision it was written for.
    Approve,
    /// Apply the person's own text. They must have seen the object's current text (`reviewed_revision_id`).
    EditAndApprove {
        body: String,
    },
    /// Dismiss the DRAFT. The captured claim stays open and visible.
    Reject,
    /// Keep the claim as its own new idea.
    KeepSeparate,
    Defer {
        due_at: Option<String>,
    },
    Reopen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRequest {
    pub proposal_id: String,
    pub action: ReviewAction,
    /// The revision of the object whose text the person was looking at. Approving requires it to still be current.
    pub reviewed_revision_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReviewResult {
    pub proposal: ProposalView,
    /// `false`: the same decision had already been made and nothing was written.
    pub applied: bool,
    /// Set when a revision was committed: the object, its new current revision and the one it replaced (for Graph notification AFTER commit).
    pub revision: Option<AppliedRevision>,
    /// Set when a separate object was created.
    pub created_object_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedRevision {
    pub object_id: String,
    pub revision_id: String,
    pub previous_revision_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewError {
    NotFound,
    /// The object's current revision is not the one the draft (or the person's review) was based on. Nothing was written.
    Stale {
        current_revision_id: String,
    },
    /// The proposal was already resolved in a different way (state named).
    AlreadyResolved(String),
    /// Cannot be applied now: `project_archived`, `claim_moved` or `object_missing`.
    Blocked(&'static str),
    Invalid(String),
    Conflict(String),
    Store(String),
}

impl ReviewError {
    pub fn code(&self) -> &'static str {
        match self {
            ReviewError::NotFound => "proposal_not_found",
            ReviewError::Stale { .. } => "stale",
            ReviewError::AlreadyResolved(_) => "already_resolved",
            ReviewError::Blocked(_) => "blocked",
            ReviewError::Invalid(_) => "invalid",
            ReviewError::Conflict(_) => "conflict",
            ReviewError::Store(_) => "storage_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            ReviewError::NotFound => "That suggestion no longer exists.".into(),
            ReviewError::Stale { .. } => "This idea changed after the suggestion was written. Read the current text and review it again.".into(),
            ReviewError::AlreadyResolved(state) => format!("This suggestion was already {state}."),
            ReviewError::Blocked("project_archived") => "Restore the project to review this suggestion.".into(),
            ReviewError::Blocked("claim_moved") => "The note and the idea are no longer in the same project.".into(),
            ReviewError::Blocked(_) => "The idea this suggestion was written for no longer exists.".into(),
            ReviewError::Invalid(reason) => format!("That change cannot be applied: {reason}."),
            ReviewError::Conflict(reason) => format!("Someone else resolved this first: {reason}."),
            ReviewError::Store(_) => "The change could not be saved.".into(),
        }
    }
}

impl From<IdentityStoreError> for ReviewError {
    fn from(error: IdentityStoreError) -> Self {
        match error {
            IdentityStoreError::NotFound(_) => ReviewError::NotFound,
            IdentityStoreError::Invalid(reason) => ReviewError::Invalid(reason),
            IdentityStoreError::Conflict(reason) => ReviewError::Conflict(reason),
            IdentityStoreError::Revise(ReviseConflict::Stale { actual, .. }) => {
                ReviewError::Stale {
                    current_revision_id: actual,
                }
            }
            IdentityStoreError::Revise(ReviseConflict::ProjectArchived) => {
                ReviewError::Blocked("project_archived")
            }
            IdentityStoreError::Revise(ReviseConflict::ProjectMismatch { .. }) => {
                ReviewError::Blocked("claim_moved")
            }
            IdentityStoreError::Revise(ReviseConflict::ObjectNotFound) => {
                ReviewError::Blocked("object_missing")
            }
            IdentityStoreError::Revise(ReviseConflict::Rejected(reason)) => {
                ReviewError::Invalid(reason)
            }
            IdentityStoreError::Revise(ReviseConflict::Store(error))
            | IdentityStoreError::Store(error) => ReviewError::Store(error.to_string()),
        }
    }
}

impl From<rusqlite::Error> for ReviewError {
    fn from(error: rusqlite::Error) -> Self {
        ReviewError::Store(error.to_string())
    }
}

fn role_of(change: &str) -> EvidenceRole {
    match change {
        "correction" => EvidenceRole::Corrects,
        "replacement" => EvidenceRole::Replaces,
        _ => EvidenceRole::Asserts,
    }
}

fn close_proposal(
    connection: &Connection,
    id: &str,
    to: &str,
    result: Option<(&str, &str, bool)>,
) -> Res<()> {
    let now = now_rfc3339()?;
    let changed = match result {
        Some((revision_id, body, edited)) => connection.execute(
            "UPDATE revision_proposals SET state = ?2, final_body = ?3, result_revision_id = ?4, user_edited = ?5, reviewed_at = ?6, updated_at = ?6 WHERE id = ?1 AND state IN ('open', 'deferred')",
            params![id, to, body, revision_id, edited as i64, now],
        )?,
        None => connection.execute("UPDATE revision_proposals SET state = ?2, reviewed_at = ?3, updated_at = ?3 WHERE id = ?1 AND state IN ('open', 'deferred')", params![id, to, now])?,
    };
    if changed != 1 {
        return Err(IdentityStoreError::Conflict(
            "the proposal changed while it was being resolved".into(),
        ));
    }
    Ok(())
}

fn set_proposal_open_or_deferred(connection: &Connection, id: &str, to: &str) -> Res<()> {
    connection.execute("UPDATE revision_proposals SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state IN ('open', 'deferred')", params![id, to, now_rfc3339()?])?;
    Ok(())
}

/// Applies one review decision inside the caller's immediate transaction. See the module docs for each action's effect.
pub fn review_in(
    connection: &Connection,
    request: &ReviewRequest,
) -> Result<ReviewResult, ReviewError> {
    let proposal = proposal_in(connection, &request.proposal_id)?.ok_or(ReviewError::NotFound)?;
    let done = |connection: &Connection,
                id: &str,
                applied: bool,
                revision: Option<AppliedRevision>,
                created: Option<String>|
     -> Result<ReviewResult, ReviewError> {
        let fresh = proposal_in(connection, id)?.ok_or(ReviewError::NotFound)?;
        Ok(ReviewResult {
            proposal: view_in(connection, &fresh)?,
            applied,
            revision,
            created_object_id: created,
        })
    };

    // Repeating a decision that was already made returns it without writing; a different one is refused.
    match (proposal.state.as_str(), &request.action) {
        ("approved", ReviewAction::Approve) if !proposal.user_edited => {
            return done(connection, &proposal.id, false, None, None)
        }
        ("approved", ReviewAction::EditAndApprove { body })
            if proposal.final_body.as_deref() == Some(body.trim()) =>
        {
            return done(connection, &proposal.id, false, None, None)
        }
        ("rejected", ReviewAction::Reject) => {
            return done(connection, &proposal.id, false, None, None)
        }
        ("separated", ReviewAction::KeepSeparate) => {
            let created = pending_in(connection, &proposal.pending_claim_id)?
                .and_then(|claim| claim.resolved_object_id);
            return done(connection, &proposal.id, false, None, created);
        }
        ("approved" | "rejected" | "separated" | "superseded", _) => {
            return Err(ReviewError::AlreadyResolved(proposal.state.clone()))
        }
        _ => {}
    }
    let claim = pending_in(connection, &proposal.pending_claim_id)?.ok_or(ReviewError::NotFound)?;
    if claim.is_terminal() {
        return Err(ReviewError::AlreadyResolved(claim.state));
    }

    match &request.action {
        ReviewAction::Reject => {
            close_proposal(connection, &proposal.id, "rejected", None)?;
            done(connection, &proposal.id, true, None, None)
        }
        ReviewAction::Defer { due_at } => {
            defer_pending_claim_in(connection, &claim.id, due_at.as_deref())?;
            set_proposal_open_or_deferred(connection, &proposal.id, "deferred")?;
            done(connection, &proposal.id, true, None, None)
        }
        ReviewAction::Reopen => {
            reopen_pending_claim_in(connection, &claim.id)?;
            set_proposal_open_or_deferred(connection, &proposal.id, "open")?;
            done(connection, &proposal.id, true, None, None)
        }
        ReviewAction::KeepSeparate => {
            let proposal_id = proposal.id.clone();
            let resolution =
                separate_pending_claim_hooked_in(connection, &claim.id, "user", &mut |_| {
                    close_proposal(connection, &proposal_id, "separated", None)
                })?;
            done(
                connection,
                &proposal.id,
                resolution.applied,
                None,
                Some(resolution.object_id),
            )
        }
        ReviewAction::Approve | ReviewAction::EditAndApprove { .. } => {
            let now = object_now_in(connection, &proposal.object_id)?
                .ok_or(ReviewError::Blocked("object_missing"))?;
            if claim.project_archived {
                return Err(ReviewError::Blocked("project_archived"));
            }
            if now.project_id != claim.project_id {
                return Err(ReviewError::Blocked("claim_moved"));
            }
            let current = now.revision.revision_id.clone();
            // What the person looked at must still be what is there: never apply over text they did not see.
            if request
                .reviewed_revision_id
                .as_deref()
                .is_some_and(|reviewed| reviewed != current)
            {
                return Err(ReviewError::Stale {
                    current_revision_id: current,
                });
            }
            let (body, edited, retracts) = match &request.action {
                ReviewAction::Approve => {
                    if current != proposal.base_revision_id {
                        return Err(ReviewError::Stale {
                            current_revision_id: current,
                        });
                    }
                    (
                        proposal.proposed_body.clone(),
                        false,
                        proposal.retracts.clone(),
                    )
                }
                ReviewAction::EditAndApprove { body } => {
                    let body = body.trim().to_string();
                    if body.is_empty() || body.chars().count() > MAX_BODY_CHARS {
                        return Err(ReviewError::Invalid("the text is empty or too long".into()));
                    }
                    // an edit must be made against the text it will replace: the person has to state which revision they read
                    if request.reviewed_revision_id.is_none() {
                        return Err(ReviewError::Stale {
                            current_revision_id: current,
                        });
                    }
                    let edited = body != proposal.proposed_body;
                    let retracts = match &proposal.retracts {
                        // withdrawing earlier evidence is only kept when that evidence is still active on the text being replaced
                        Some(r)
                            if current == proposal.base_revision_id
                                || evidence_support_in(connection, &current)?
                                    .active
                                    .iter()
                                    .any(|a| a.revision_id == r.0 && a.ordinal == Some(r.1)) =>
                        {
                            Some(r.clone())
                        }
                        _ => None,
                    };
                    (body, edited, retracts)
                }
                _ => unreachable!(),
            };
            if body == now.revision.body {
                return Err(ReviewError::Invalid(
                    "the text is the same as the current text".into(),
                ));
            }
            let proposal_id = proposal.id.clone();
            let kept_body = body.clone();
            let resolution = accept_pending_claim_hooked_in(
                connection,
                &AcceptPendingInput {
                    pending_id: claim.id.clone(),
                    target_object_id: proposal.object_id.clone(),
                    expected_base_revision_id: current.clone(),
                    content: RevisionContent {
                        kind: now.revision.kind.clone(),
                        title: now.revision.title.clone(),
                        body,
                    },
                    role: role_of(&proposal.change),
                    retracts,
                    interpretation_label: None,
                },
                &mut |revision| {
                    close_proposal(
                        connection,
                        &proposal_id,
                        "approved",
                        Some((&revision.id, &kept_body, edited)),
                    )
                },
            )?;
            let revision = resolution.revision.map(|r| AppliedRevision {
                object_id: proposal.object_id.clone(),
                revision_id: r.id,
                previous_revision_id: current,
            });
            done(connection, &proposal.id, resolution.applied, revision, None)
        }
    }
}

impl CaptureStore {
    /// One review decision, atomically. SQLite serializes concurrent callers; the loser sees the winner's decision (an idempotent repeat,
    /// or `AlreadyResolved` / `Stale`) and nothing of its own is written.
    pub fn review_revision_proposal(
        &self,
        request: &ReviewRequest,
    ) -> Result<ReviewResult, ReviewError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ReviewError::Store("the store is unavailable".into()))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = review_in(&transaction, request)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Resolves a claim that has NO usable draft (or whose draft was dismissed): keep it as its own idea, defer it, or reopen it.
    /// `merge into an existing idea` is deliberately absent: without a draft there is no reviewed text to apply, so the person edits the
    /// idea themselves and keeps the claim separate or leaves it open.
    pub fn resolve_unresolved_claim(
        &self,
        pending_id: &str,
        action: ClaimAction,
    ) -> Result<ClaimResolution, ReviewError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ReviewError::Store("the store is unavailable".into()))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let claim = pending_in(&transaction, pending_id)?.ok_or(ReviewError::NotFound)?;
        let outcome = match action {
            ClaimAction::KeepSeparate => {
                let resolution = separate_pending_claim_hooked_in(
                    &transaction,
                    pending_id,
                    "user",
                    &mut |_| Ok(()),
                )?;
                ClaimResolution {
                    claim_state: resolution.claim.state,
                    created_object_id: Some(resolution.object_id),
                    applied: resolution.applied,
                }
            }
            ClaimAction::Defer { due_at } => {
                let updated = defer_pending_claim_in(&transaction, pending_id, due_at.as_deref())?;
                if let Some(p) = proposal_for_claim_in(&transaction, pending_id)? {
                    set_proposal_open_or_deferred(&transaction, &p.id, "deferred")?;
                }
                ClaimResolution {
                    claim_state: updated.state,
                    created_object_id: None,
                    applied: claim.state != "deferred",
                }
            }
            ClaimAction::Reopen => {
                let updated = reopen_pending_claim_in(&transaction, pending_id)?;
                if let Some(p) = proposal_for_claim_in(&transaction, pending_id)? {
                    set_proposal_open_or_deferred(&transaction, &p.id, "open")?;
                }
                ClaimResolution {
                    claim_state: updated.state,
                    created_object_id: None,
                    applied: claim.state != "open",
                }
            }
        };
        transaction.commit()?;
        Ok(outcome)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimAction {
    KeepSeparate,
    Defer { due_at: Option<String> },
    Reopen,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimResolution {
    pub claim_state: String,
    pub created_object_id: Option<String>,
    pub applied: bool,
}
