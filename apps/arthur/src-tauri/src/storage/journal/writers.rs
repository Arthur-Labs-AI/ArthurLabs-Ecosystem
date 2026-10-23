//! Dormant typed adapters over the same native domain implementations as v9.
//! No adapter locks a store, begins a transaction, finalizes, or publishes success.
//! A failed step remains fatal even when a composition closure catches its error.
use super::codec::{EntityKind, ReviewAction as JournalAction, ReviewMethod};
use super::reducer::ReviewContext;
use super::snapshot::{self, SnapshotPolicy};
use super::storage::{self, JournalError, JournalKernel, JournalTx};
use crate::distillation::evolution;
use crate::storage::capture_store::{self, Capture, CreateCaptureInput, StoreError};
use crate::storage::evidence_store as evidence;
use crate::storage::identity_store as identity;
use crate::storage::lineage_store::ReviseConflict;
use crate::storage::project_store::ProjectError;
use crate::storage::proposal_store as proposals;
use crate::storage::{
    integration_store as graph, knowledge_store as knowledge, lineage_store as lineage,
    project_store as projects, relation_store as relations,
};
use std::sync::Arc;

fn method_of(name: &str) -> Result<ReviewMethod> {
    match name {
        "user" => Ok(ReviewMethod::User),
        "expiry" => Ok(ReviewMethod::Expiry),
        _ => Err(WriterError::Identity(IdentityFailure::Invalid)),
    }
}

pub(super) type Result<T> = std::result::Result<T, WriterError>;

/// Retain the original typed errors for eventual owner-level public mapping.
/// Debug/Display expose categories only, never SQL details or private row text.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum IdentityFailure {
    Invalid,
    NotFound,
    Conflict,
    Stale,
    Blocked,
    Store,
}

#[derive(Clone)]
pub(super) enum WriterError {
    Store(Arc<StoreError>),
    Project(ProjectError),
    Conflict(Arc<ReviseConflict>),
    Identity(IdentityFailure),
    Review(Arc<crate::storage::proposal_store::ReviewError>),
    Snapshot(snapshot::SnapshotError),
    Journal(JournalError),
}
impl From<StoreError> for WriterError {
    fn from(e: StoreError) -> Self {
        Self::Store(Arc::new(e))
    }
}
impl From<ProjectError> for WriterError {
    fn from(e: ProjectError) -> Self {
        Self::Project(e)
    }
}
impl From<identity::IdentityStoreError> for WriterError {
    fn from(e: identity::IdentityStoreError) -> Self {
        use identity::IdentityStoreError::*;
        Self::Identity(match e {
            Invalid(_) => IdentityFailure::Invalid,
            NotFound(_) => IdentityFailure::NotFound,
            Conflict(_) => IdentityFailure::Conflict,
            Revise(lineage::ReviseConflict::Stale { .. }) => IdentityFailure::Stale,
            Revise(_) => IdentityFailure::Blocked,
            Store(_) => IdentityFailure::Store,
        })
    }
}
impl From<crate::storage::proposal_store::ReviewError> for WriterError {
    fn from(e: crate::storage::proposal_store::ReviewError) -> Self {
        Self::Review(Arc::new(e))
    }
}
impl From<snapshot::SnapshotError> for WriterError {
    fn from(e: snapshot::SnapshotError) -> Self {
        Self::Snapshot(e)
    }
}
impl From<ReviseConflict> for WriterError {
    fn from(e: ReviseConflict) -> Self {
        Self::Conflict(Arc::new(e))
    }
}
impl std::fmt::Debug for WriterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => f.write_str(match e.as_ref() {
                StoreError::Invalid(_) => "Invalid",
                StoreError::NotFound(_) => "NotFound",
                StoreError::MissingRevision(_) => "MissingRevision",
                StoreError::Corrupt(_) => "Corrupt",
                StoreError::Database(_) => "Database",
                StoreError::Poisoned => "Unavailable",
            }),
            Self::Project(e) => f.write_str(e.code()),
            Self::Conflict(e) => f.write_str(match e.as_ref() {
                ReviseConflict::ObjectNotFound => "ObjectNotFound",
                ReviseConflict::ProjectMismatch { .. } => "ProjectMismatch",
                ReviseConflict::ProjectArchived => "ProjectArchived",
                ReviseConflict::Stale { .. } => "Stale",
                ReviseConflict::Rejected(_) => "Rejected",
                ReviseConflict::Store(_) => "Storage",
            }),
            Self::Identity(e) => f.write_str(match e {
                IdentityFailure::Invalid => "Invalid",
                IdentityFailure::NotFound => "NotFound",
                IdentityFailure::Conflict => "Conflict",
                IdentityFailure::Stale => "Stale",
                IdentityFailure::Blocked => "Blocked",
                IdentityFailure::Store => "Storage",
            }),
            Self::Review(e) => f.write_str(e.as_ref().code()),
        Self::Snapshot(e) => f.write_str(match e {
            snapshot::SnapshotError::WrongSchema => "WrongSchema",
            snapshot::SnapshotError::Unavailable => "Unavailable",
            snapshot::SnapshotError::Sql => "Storage",
            snapshot::SnapshotError::Exists => "Exists",
            snapshot::SnapshotError::Limit => "Limit",
            snapshot::SnapshotError::Timeout => "Timeout",
            snapshot::SnapshotError::Corrupt => "Corrupt",
            snapshot::SnapshotError::Incomplete => "Incomplete",
            snapshot::SnapshotError::State => "State",
        }),
            Self::Journal(e) => std::fmt::Debug::fmt(e, f),
        }
    }
}
impl std::fmt::Display for WriterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "writer {self:?}")
    }
}
impl std::error::Error for WriterError {}

pub(super) struct Writers<'a, 'tx> {
    tx: &'a mut JournalTx<'tx>,
    failure: Option<WriterError>,
}
impl JournalKernel<'_> {
    pub(super) fn write<T>(
        &self,
        work: impl FnOnce(&mut Writers<'_, '_>) -> Result<T>,
    ) -> Result<T> {
        let mut failure = None;
        let result = self.run(|tx| execute(tx, work, &mut failure));
        finish(result, failure)
    }
    #[cfg(test)]
    pub(super) fn write_fault<T>(
        &self,
        fault: super::storage::Fault,
        work: impl FnOnce(&mut Writers<'_, '_>) -> Result<T>,
    ) -> Result<T> {
        let mut failure = None;
        let result = self.run_fault(fault, |tx| execute(tx, work, &mut failure));
        finish(result, failure)
    }
}
fn execute<T>(
    tx: &mut JournalTx<'_>,
    work: impl FnOnce(&mut Writers<'_, '_>) -> Result<T>,
    failure: &mut Option<WriterError>,
) -> storage::Result<T> {
    let mut writers = Writers { tx, failure: None };
    let result = work(&mut writers);
    match (writers.failure, result) {
        (Some(e), _) | (None, Err(e)) => {
            *failure = Some(e);
            Err(JournalError::Domain)
        }
        (None, Ok(value)) => Ok(value),
    }
}
fn finish<T>(result: storage::Result<T>, failure: Option<WriterError>) -> Result<T> {
    match result {
        Err(JournalError::Domain) => {
            Err(failure.unwrap_or(WriterError::Journal(JournalError::Domain)))
        }
        Err(e) => Err(WriterError::Journal(e)),
        Ok(value) => Ok(value),
    }
}
impl Writers<'_, '_> {
    #[cfg(test)]
    pub(super) fn observed_effect_count(&self) -> i64 {
        self.tx
            .sql()
            .query_row("SELECT effect_count FROM sync_write_context", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
    fn step<T, E: Into<WriterError>>(
        &mut self,
        work: impl FnOnce(&rusqlite::Connection) -> std::result::Result<T, E>,
    ) -> Result<T> {
        if let Some(e) = &self.failure {
            return Err(e.clone());
        }
        match self.tx.with_domain(work) {
            Ok(value) => Ok(value),
            Err(e) => {
                let e = e.into();
                self.failure = Some(e.clone());
                Err(e)
            }
        }
    }
    pub(super) fn create_capture(&mut self, input: CreateCaptureInput) -> Result<Capture> {
        self.step(|c| capture_store::insert_capture_in(c, capture_store::prepare_capture(input)?))
    }
    pub(super) fn create_project(&mut self, name: &str) -> Result<projects::Project> {
        self.step(|c| projects::create_project_in(c, name))
    }
    pub(super) fn rename_project(&mut self, id: &str, name: &str) -> Result<projects::Project> {
        self.step(|c| projects::rename_project_in(c, id, name))
    }
    pub(super) fn archive_project(&mut self, id: &str) -> Result<projects::Project> {
        self.step(|c| projects::archive_project_in(c, id))
    }
    pub(super) fn restore_project(&mut self, id: &str) -> Result<projects::Project> {
        self.step(|c| projects::restore_project_in(c, id))
    }
    pub(super) fn move_capture(&mut self, id: &str, project: &str) -> Result<Capture> {
        self.step(|c| projects::move_capture_in(c, id, project))
    }
    pub(super) fn move_knowledge_object(
        &mut self,
        id: &str,
        project: &str,
    ) -> Result<knowledge::KnowledgeObject> {
        self.step(|c| projects::move_knowledge_object_in(c, id, project))
    }
    fn register_review(&mut self, entity: EntityKind, key: Vec<String>, context: ReviewContext) -> Result<()> {
        self.tx.register_review(entity, key, context).map_err(WriterError::Journal)
    }
    pub(super) fn set_active_project(&mut self, id: &str) -> Result<String> {
        self.step(|c| projects::set_active_project_in(c, id))
    }
    pub(super) fn record_distillation(
        &mut self,
        id: &str,
        objects: Vec<knowledge::NewKnowledgeObject>,
    ) -> Result<Vec<knowledge::KnowledgeObject>> {
        self.step(|c| knowledge::record_distillation_in(c, id, objects).map(|(rows, _)| rows))
    }
    pub(super) fn update_object(
        &mut self,
        id: &str,
        changes: lineage::Changes,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::update_object_in(c, id, changes))
    }
    pub(super) fn create_revision_from(
        &mut self,
        id: &str,
        parent: &str,
        changes: lineage::Changes,
        current: bool,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::create_revision_from_in(c, id, parent, changes, current))
    }
    pub(super) fn merge_revisions(
        &mut self,
        id: &str,
        parents: &[String],
        content: lineage::RevisionContent,
        current: bool,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::merge_revisions_in(c, id, parents, content, current))
    }
    pub(super) fn revise_from_capture(
        &mut self,
        id: &str,
        parent: Option<&str>,
        span: lineage::SourceSpan,
        changes: lineage::Changes,
        current: bool,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::revise_from_capture_in(c, id, parent, span, changes, current))
    }
    pub(super) fn revise_if_current(
        &mut self,
        expected: &lineage::ExpectedRevision<'_>,
        content: lineage::RevisionContent,
        origin: lineage::CasOrigin,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::revise_if_current_in(c, expected, content, origin))
    }
    pub(super) fn restore_revision(
        &mut self,
        id: &str,
        target: &str,
        expected: &str,
    ) -> Result<lineage::Revision> {
        self.step(|c| lineage::restore_revision_in(c, id, target, expected))
    }
    pub(super) fn create_relation(
        &mut self,
        edge: relations::NewRelation,
        origin: &str,
    ) -> Result<relations::Relation> {
        self.step(|c| relations::create_relation_in(c, edge, origin))
    }
    pub(super) fn record_relations(
        &mut self,
        edges: Vec<relations::NewRelation>,
        origin: &str,
    ) -> Result<Vec<relations::Relation>> {
        self.step(|c| relations::record_relations_in(c, edges, origin))
    }
    pub(super) fn record_identity_decision(&mut self, input: identity::IdentityDecisionInput) -> Result<(identity::IdentityDecision, bool)> {
        self.step(|c| identity::record_identity_decision_in(c, &input))
    }
    pub(super) fn stage_uncertain_claim(&mut self, input: identity::PendingClaimInput) -> Result<(identity::PendingClaim, bool)> {
        self.step(|c| identity::stage_uncertain_claim_in(c, &input))
    }
    pub(super) fn insert_proposal(&mut self, input: proposals::NewProposal) -> Result<(proposals::RevisionProposal, bool)> {
        self.step(|c| proposals::insert_proposal_in(c, &input))
    }
    fn register_claim_transition(&mut self, claim: &identity::PendingClaim, before: Option<&str>, action: JournalAction, proposal: Option<&str>, method: ReviewMethod) -> Result<()> {
        let Some(before) = before else {
            return Err(WriterError::Journal(JournalError::ReviewContext));
        };
        if before == claim.state.as_str() {
            return Ok(());
        }
        self.register_review(
            EntityKind::PendingClaims,
            vec![claim.id.clone()],
            ReviewContext {
                action,
                proposal_id: proposal.map(str::to_owned),
                claim_id: Some(claim.id.clone()),
                object_id: claim.resolved_object_id.clone(),
                reviewed_revision_id: claim.resolved_revision_id.clone(),
                final_body: None,
                user_edited: None,
                result_revision_id: claim.resolved_revision_id.clone(),
                method: Some(method),
            },
        )
    }
    fn register_proposal_transition(&mut self, before: &proposals::RevisionProposal, after: &proposals::RevisionProposal, action: JournalAction, reviewed: Option<String>, method: ReviewMethod) -> Result<()> {
        if before.state == after.state {
            return Ok(());
        }
        self.register_review(
            EntityKind::RevisionProposals,
            vec![after.id.clone()],
            ReviewContext {
                action,
                proposal_id: Some(after.id.clone()),
                claim_id: Some(after.pending_claim_id.clone()),
                object_id: Some(after.object_id.clone()),
                reviewed_revision_id: reviewed.or_else(|| Some(after.base_revision_id.clone())),
                final_body: after.final_body.clone(),
                user_edited: Some(after.user_edited),
                result_revision_id: after.result_revision_id.clone(),
                method: Some(method),
            },
        )
    }
    pub(super) fn defer_claim(&mut self, id: &str, due_at: Option<&str>) -> Result<identity::PendingClaim> {
        let before_proposal = self.step(|c| proposals::proposal_for_claim_in(c, id))?.map(|p| (p.id, p.state));
        let before = self.step(|c| identity::pending_in(c, id))?.map(|p| p.state);
        let claim = self.step(|c| identity::defer_pending_claim_in(c, id, due_at))?;
        self.register_claim_transition(&claim, before.as_deref(), JournalAction::Defer, None, ReviewMethod::User)?;
        self.track_superseded(&claim.id, before_proposal, ReviewMethod::DerivedClaimResolution)?;
        Ok(claim)
    }
    fn track_superseded(&mut self, claim_id: &str, before: Option<(String, String)>, method: ReviewMethod) -> Result<()> {
        let current = self.step(|c| proposals::proposal_for_claim_in(c, claim_id))?;
        match (before, current) {
            (Some((id, old)), Some(p)) if p.id == id && p.state != old => {
                if self.tx.has_registered(EntityKind::RevisionProposals, vec![id.clone()]) {
                    return Ok(());
                }
                if p.state == "superseded" && (old == "open" || old == "deferred") {
                    return self.register_review(
                        EntityKind::RevisionProposals,
                        vec![id],
                        ReviewContext {
                            action: JournalAction::Supersede,
                            proposal_id: Some(p.id),
                            claim_id: Some(claim_id.to_string()),
                            object_id: None,
                            reviewed_revision_id: None,
                            final_body: None,
                            user_edited: None,
                            result_revision_id: None,
                            method: Some(method),
                        },
                    );
                }
                Err(WriterError::Journal(JournalError::ReviewContext))
            }
            _ => Ok(()),
        }
    }
    pub(super) fn accept_pending_claim(&mut self, input: identity::AcceptPendingInput) -> Result<identity::PendingResolution> {
        let before_proposal = self.step(|c| proposals::proposal_for_claim_in(c, &input.pending_id))?.map(|p| (p.id, p.state));
        let out = self.step(|c| identity::accept_pending_claim_hooked_in(c, &input, &mut |_| Ok(())))?;
        if out.applied {
            let revision = out.revision.as_ref().ok_or(WriterError::Journal(JournalError::ReviewContext))?;
            self.register_review(
                EntityKind::PendingClaims,
                vec![out.claim.id.clone()],
                ReviewContext {
                    action: JournalAction::Approve,
                    proposal_id: None,
                    claim_id: Some(out.claim.id.clone()),
                    object_id: Some(out.object_id.clone()),
                    reviewed_revision_id: Some(input.expected_base_revision_id.clone()),
                    final_body: None,
                    user_edited: None,
                    result_revision_id: Some(revision.id.clone()),
                    method: Some(ReviewMethod::User),
                },
            )?;
        }
        self.track_superseded(&out.claim.id, before_proposal, ReviewMethod::DerivedClaimResolution)?;
        Ok(out)
    }
    pub(super) fn separate_pending_claim(&mut self, id: &str, method: &str) -> Result<identity::PendingResolution> {
        let review_method = method_of(method)?;
        let before_proposal = self.step(|c| proposals::proposal_for_claim_in(c, id))?.map(|p| (p.id, p.state));
        let out = self.step(|c| identity::separate_pending_claim_hooked_in(c, id, method, &mut |_| Ok(())))?;
        if out.applied {
            self.register_review(
                EntityKind::PendingClaims,
                vec![out.claim.id.clone()],
                ReviewContext {
                    action: JournalAction::KeepSeparate,
                    proposal_id: None,
                    claim_id: Some(out.claim.id.clone()),
                    object_id: Some(out.object_id.clone()),
                    reviewed_revision_id: None,
                    final_body: None,
                    user_edited: None,
                    result_revision_id: None,
                    method: Some(review_method),
                },
            )?;
        }
        self.track_superseded(&out.claim.id, before_proposal, ReviewMethod::DerivedClaimResolution)?;
        Ok(out)
    }
    pub(super) fn reopen_claim(&mut self, id: &str) -> Result<identity::PendingClaim> {
        let before_proposal = self.step(|c| proposals::proposal_for_claim_in(c, id))?.map(|p| (p.id, p.state));
        let before = self.step(|c| identity::pending_in(c, id))?.map(|p| p.state);
        let claim = self.step(|c| identity::reopen_pending_claim_in(c, id))?;
        self.register_claim_transition(&claim, before.as_deref(), JournalAction::Reopen, None, ReviewMethod::User)?;
        self.track_superseded(&claim.id, before_proposal, ReviewMethod::DerivedClaimResolution)?;
        Ok(claim)
    }
    pub(super) fn review_proposal(&mut self, request: proposals::ReviewRequest) -> Result<proposals::ReviewResult> {
        let reviewed = request.reviewed_revision_id.clone();
        let before = self.step(|c| proposals::proposal_in(c, &request.proposal_id))?;
        let claim_before: Option<String> = match &before {
            Some(p) => self.step(|c| identity::pending_in(c, &p.pending_claim_id))?.map(|c| c.state),
            None => None,
        };
        let out = self.step(|c| proposals::review_in(c, &request))?;
        let after = self.step(|c| proposals::proposal_in(c, &request.proposal_id))?.ok_or(WriterError::Journal(JournalError::ReviewContext))?;
        let claim_after = self.step(|c| identity::pending_in(c, &after.pending_claim_id))?.ok_or(WriterError::Journal(JournalError::ReviewContext))?;
        let action = match request.action {
            proposals::ReviewAction::Approve => JournalAction::Approve,
            proposals::ReviewAction::EditAndApprove { .. } => JournalAction::EditAndApprove,
            proposals::ReviewAction::Reject => JournalAction::Reject,
            proposals::ReviewAction::KeepSeparate => JournalAction::KeepSeparate,
            proposals::ReviewAction::Defer { .. } => JournalAction::Defer,
            proposals::ReviewAction::Reopen => JournalAction::Reopen,
        };
        let before_ref = before.as_ref().unwrap_or(&after);
        self.register_proposal_transition(before_ref, &after, action, reviewed, ReviewMethod::User)?;
        self.register_claim_transition(&claim_after, claim_before.as_deref(), action, Some(after.id.as_str()), ReviewMethod::User)?;
        self.track_superseded(&after.pending_claim_id, before.as_ref().map(|p| (p.id.clone(), p.state.clone())), ReviewMethod::DerivedClaimResolution)?;
        Ok(out)
    }
    pub(super) fn resolve_claim(&mut self, pending_id: &str, action: proposals::ClaimAction) -> Result<proposals::ClaimResolution> {
        let before_claim: Option<String> = self.step(|c| identity::pending_in(c, pending_id))?.map(|c| c.state);
        let live_proposal: Option<String> = self.step(|c| {
            Ok::<_, identity::IdentityStoreError>(proposals::proposal_for_claim_in(c, pending_id)?.filter(|p| p.state == "open" || p.state == "deferred").map(|p| p.id))
        })?;
        match action {
            proposals::ClaimAction::KeepSeparate => {
                let out = self.separate_pending_claim(pending_id, "user")?;
                let applied = Some(out.claim.state.as_str()) != before_claim.as_deref();
                Ok(proposals::ClaimResolution { claim_state: out.claim.state.clone(), created_object_id: Some(out.object_id), applied })
            }
            proposals::ClaimAction::Defer { due_at } => {
                if let Some(pid) = live_proposal {
                    self.review_proposal(proposals::ReviewRequest { proposal_id: pid, action: proposals::ReviewAction::Defer { due_at: due_at.clone() }, reviewed_revision_id: None })?;
                } else {
                    self.defer_claim(pending_id, due_at.as_deref())?;
                }
                let claim = self.step(|c| identity::pending_in(c, pending_id))?.ok_or(WriterError::Journal(JournalError::ReviewContext))?;
                let applied = Some(claim.state.as_str()) != before_claim.as_deref();
                Ok(proposals::ClaimResolution { claim_state: claim.state, created_object_id: None, applied })
            }
            proposals::ClaimAction::Reopen => {
                if let Some(pid) = live_proposal {
                    self.review_proposal(proposals::ReviewRequest { proposal_id: pid, action: proposals::ReviewAction::Reopen, reviewed_revision_id: None })?;
                } else {
                    self.reopen_claim(pending_id)?;
                }
                let claim = self.step(|c| identity::pending_in(c, pending_id))?.ok_or(WriterError::Journal(JournalError::ReviewContext))?;
                let applied = Some(claim.state.as_str()) != before_claim.as_deref();
                Ok(proposals::ClaimResolution { claim_state: claim.state, created_object_id: None, applied })
            }
        }
    }
    pub(super) fn attach_revision_evidence(&mut self, revision_id: &str, items: Vec<evidence::NewEvidence>) -> Result<Vec<evidence::EvidenceItem>> {
        self.step(|c| evidence::attach_revision_evidence_in(c, revision_id, &items))
    }
    pub(super) fn evolve_capture(
        &mut self,
        capture_id: &str,
        claims: Vec<knowledge::NewKnowledgeObject>,
        planned: Vec<evolution::Planned>,
        limits: &evolution::EvolutionLimits,
        allowed: &dyn Fn() -> bool,
        review_first: bool,
    ) -> Result<evolution::Committed> {
        self.step(|c| evolution::apply(c, capture_id, &claims, planned, limits, allowed, review_first))
    }
    pub(super) fn snapshot_allocate(&mut self, snapshot_id: &str, now: &str) -> Result<()> {
        self.step(|c| snapshot::allocate(c, snapshot_id, now))
    }
    #[cfg(test)]
    pub(super) fn snapshot_capture_with(&mut self, snapshot_id: &str, now: &str, policy: snapshot::SnapshotPolicy) -> Result<snapshot::SnapshotSummary> {
        self.step(|c| snapshot::capture(c, snapshot_id, policy, now))
    }
    pub(super) fn snapshot_capture(&mut self, snapshot_id: &str, now: &str) -> Result<snapshot::SnapshotSummary> {
        self.step(|c| snapshot::capture(c, snapshot_id, SnapshotPolicy::candidate(), now))
    }
    pub(super) fn snapshot_pack(&mut self, snapshot_id: &str) -> Result<()> {
        self.step(|c| snapshot::pack(c, snapshot_id))
    }
    pub(super) fn snapshot_abort(&mut self, snapshot_id: &str) -> Result<()> {
        self.step(|c| snapshot::abort(c, snapshot_id))
    }
    pub(super) fn snapshot_verify(&mut self, snapshot_id: &str) -> Result<()> {
        self.step(|c| snapshot::verify_manifest(c, snapshot_id))
    }
    pub(super) fn apply_integration(
        &mut self,
        write: graph::IntegrationWrite,
    ) -> Result<graph::IntegrationWritten> {
        self.step(|c| graph::apply_integration_in(c, write))
    }
}
