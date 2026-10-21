//! Automatic Thought Evolution (M04.7B Phase 5): its settings and consents, and the review of the suggestions it stores.
//!
//! Review-first: nothing here lets a suggestion change an idea except `review_revision_proposal` with an explicit approve, which goes
//! through the compare-and-set writer. No command accepts text from a model, an id for a revision to write, a project, or a credential
//! to read back. Graph integration is notified only from a committed review.

use serde::{Deserialize, Serialize, Serializer};
use tauri::{AppHandle, State};

use crate::commands::integration;
use crate::evolution_runtime::{ConsentKind, EvolutionRuntime, EvolutionStatus, RuntimeError};
use crate::graph::integration::ChangedKnowledge;
use crate::runtime::RuntimeHandle;
use crate::storage::lineage_store::{ReviseConflict, Revision};
use crate::storage::proposal_store::{ApprovalInfo, ClaimAction, ProposalView, ReviewAction, ReviewError, ReviewRequest, UnresolvedClaimView};

// --- settings, consent, credential ------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_evolution_status(runtime: State<'_, EvolutionRuntime>) -> EvolutionStatus {
    runtime.status()
}

/// ON needs every consent and credential (`not_ready` otherwise). OFF always works.
#[tauri::command]
pub fn set_evolution_enabled(runtime: State<'_, EvolutionRuntime>, enabled: bool) -> Result<EvolutionStatus, RuntimeError> {
    runtime.set_enabled(enabled)
}

/// One explicit, revocable choice. Granting must name the disclosure version the person was shown (`disclosure_outdated` otherwise).
#[tauri::command]
pub fn set_evolution_consent(runtime: State<'_, EvolutionRuntime>, kind: ConsentKind, granted: bool, disclosure_version: Option<String>) -> Result<EvolutionStatus, RuntimeError> {
    runtime.set_consent(kind, granted, disclosure_version.as_deref())
}

/// Write-only: the key is moved into the native credential store and never returned.
#[tauri::command]
pub fn set_typesafe_credential(runtime: State<'_, EvolutionRuntime>, secret: String) -> Result<EvolutionStatus, RuntimeError> {
    runtime.set_typesafe_credential(&secret)
}

#[tauri::command]
pub fn delete_typesafe_credential(runtime: State<'_, EvolutionRuntime>) -> Result<EvolutionStatus, RuntimeError> {
    runtime.delete_typesafe_credential()
}

// --- review --------------------------------------------------------------------------------------------------------------------

/// `{ code, message, currentRevisionId? }`, matching the client's `EvolutionErrorPayload`.
#[derive(Debug)]
pub struct ReviewFailure(ReviewError);

impl Serialize for ReviewFailure {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("ReviewFailure", 3)?;
        state.serialize_field("code", self.0.code())?;
        state.serialize_field("message", &self.0.message())?;
        let current = match &self.0 {
            ReviewError::Stale { current_revision_id } => Some(current_revision_id.as_str()),
            _ => None,
        };
        state.serialize_field("currentRevisionId", &current)?;
        state.end()
    }
}

impl From<ReviewError> for ReviewFailure {
    fn from(error: ReviewError) -> Self {
        ReviewFailure(error)
    }
}

impl From<crate::storage::identity_store::IdentityStoreError> for ReviewFailure {
    fn from(error: crate::storage::identity_store::IdentityStoreError) -> Self {
        ReviewFailure(error.into())
    }
}

type Reviewed<T> = Result<T, ReviewFailure>;

/// Proposals, oldest first. `states` omitted: all of them (history included).
#[tauri::command]
pub fn list_revision_proposals(store: State<'_, RuntimeHandle>, project_id: Option<String>, states: Option<Vec<String>>) -> Reviewed<Vec<ProposalView>> {
    let states = states.unwrap_or_default();
    let refs: Vec<&str> = states.iter().map(String::as_str).collect();
    Ok(store.list_revision_proposals(project_id.as_deref(), &refs)?)
}

#[tauri::command]
pub fn get_revision_proposal(store: State<'_, RuntimeHandle>, proposal_id: String) -> Reviewed<ProposalView> {
    store.get_revision_proposal(&proposal_id)?.ok_or(ReviewFailure(ReviewError::NotFound))
}

/// Claims waiting for a decision, with or without a suggested text. Nothing is hidden by age or quota.
#[tauri::command]
pub fn list_unresolved_claims(store: State<'_, RuntimeHandle>, project_id: Option<String>) -> Reviewed<Vec<UnresolvedClaimView>> {
    Ok(store.list_unresolved_claims(project_id.as_deref())?)
}

/// Mirrors the client's `ReviewProposalInput`. Ids of revisions to write, text from a model, and projects are never accepted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewInput {
    pub proposal_id: String,
    /// `approve`, `edit_approve`, `reject`, `keep_separate`, `defer` or `reopen`.
    pub action: String,
    /// The text the person approves, for `edit_approve`.
    pub edited_body: Option<String>,
    /// The revision of the idea whose text the person was reading. Approving requires it to still be current.
    pub reviewed_revision_id: Option<String>,
    pub due_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOutcome {
    pub proposal: ProposalView,
    /// `false`: the same decision had already been made; nothing was written.
    pub applied: bool,
    pub revision_id: Option<String>,
    pub created_object_id: Option<String>,
}

fn action_of(input: &ReviewInput) -> Result<ReviewAction, ReviewError> {
    Ok(match input.action.as_str() {
        "approve" => ReviewAction::Approve,
        "edit_approve" => ReviewAction::EditAndApprove { body: input.edited_body.clone().ok_or_else(|| ReviewError::Invalid("the edited text is missing".into()))? },
        "reject" => ReviewAction::Reject,
        "keep_separate" => ReviewAction::KeepSeparate,
        "defer" => ReviewAction::Defer { due_at: input.due_at.clone() },
        "reopen" => ReviewAction::Reopen,
        _ => return Err(ReviewError::Invalid("unknown review action".into())),
    })
}

/// One decision, atomically. Graph Integration hears about a change only AFTER the transaction committed.
#[tauri::command]
pub fn review_revision_proposal(app: AppHandle, store: State<'_, RuntimeHandle>, input: ReviewInput) -> Reviewed<ReviewOutcome> {
    let request = ReviewRequest { proposal_id: input.proposal_id.clone(), action: action_of(&input)?, reviewed_revision_id: input.reviewed_revision_id.clone() };
    let result = store.review_revision_proposal(&request)?;
    if result.applied {
        if let Some(applied) = &result.revision {
            integration::notify(&app, ChangedKnowledge::revised(&applied.object_id, &applied.previous_revision_id, &applied.revision_id));
        }
        if let Some(object_id) = &result.created_object_id {
            if let Ok(Some(revision_id)) = store.current_revision_id_of(object_id) {
                integration::notify(&app, ChangedKnowledge::created(object_id, &revision_id));
            }
        }
    }
    Ok(ReviewOutcome { proposal: result.proposal, applied: result.applied, revision_id: result.revision.map(|r| r.revision_id), created_object_id: result.created_object_id })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveClaimInput {
    pub pending_id: String,
    /// `keep_separate`, `defer` or `reopen`.
    pub action: String,
    pub due_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub claim_state: String,
    pub created_object_id: Option<String>,
    pub applied: bool,
}

/// Resolves a claim explicitly. No text is invented and nothing is merged: the person keeps the claim as its own idea, defers it, or
/// reopens it.
#[tauri::command]
pub fn resolve_unresolved_claim(app: AppHandle, store: State<'_, RuntimeHandle>, input: ResolveClaimInput) -> Reviewed<ClaimOutcome> {
    let action = match input.action.as_str() {
        "keep_separate" => ClaimAction::KeepSeparate,
        "defer" => ClaimAction::Defer { due_at: input.due_at.clone() },
        "reopen" => ClaimAction::Reopen,
        _ => return Err(ReviewError::Invalid("unknown action".into()).into()),
    };
    let resolution = store.resolve_unresolved_claim(&input.pending_id, action)?;
    if resolution.applied {
        if let Some(object_id) = &resolution.created_object_id {
            if let Ok(Some(revision_id)) = store.current_revision_id_of(object_id) {
                integration::notify(&app, ChangedKnowledge::created(object_id, &revision_id));
            }
        }
    }
    Ok(ClaimOutcome { claim_state: resolution.claim_state, created_object_id: resolution.created_object_id, applied: resolution.applied })
}

// --- history ----------------------------------------------------------------------------------------------------------------------

/// Which revisions of an object a person approved from a suggestion, and whether they changed the words.
#[tauri::command]
pub fn list_object_approvals(store: State<'_, RuntimeHandle>, object_id: String) -> Reviewed<Vec<ApprovalInfo>> {
    Ok(store.approvals_for_object(&object_id)?)
}

#[derive(Debug, Serialize)]
pub struct RestoreFailure {
    code: &'static str,
    message: String,
}

/// Undo: a NEW revision that goes back to an earlier text. History is never rewritten; a revision that moved on since the person looked
/// is refused (`stale`).
#[tauri::command]
pub fn restore_revision(app: AppHandle, store: State<'_, RuntimeHandle>, object_id: String, target_revision_id: String, expected_current_revision_id: String) -> Result<Revision, RestoreFailure> {
    let revision = store.restore_revision(&object_id, &target_revision_id, &expected_current_revision_id).map_err(|error| match error {
        ReviseConflict::Stale { .. } => RestoreFailure { code: "stale", message: "This idea changed since you opened its history. Open it again.".into() },
        ReviseConflict::ProjectArchived => RestoreFailure { code: "project_archived", message: "Restore the project to change this idea.".into() },
        ReviseConflict::ObjectNotFound => RestoreFailure { code: "object_not_found", message: "That idea no longer exists.".into() },
        ReviseConflict::Rejected(reason) => RestoreFailure { code: "invalid", message: format!("Nothing to undo: {reason}.") },
        _ => RestoreFailure { code: "storage_failed", message: "The change could not be saved.".into() },
    })?;
    integration::notify(&app, ChangedKnowledge::revised(&object_id, &expected_current_revision_id, &revision.id));
    Ok(revision)
}
