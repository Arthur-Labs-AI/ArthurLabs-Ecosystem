//! The identity-aware distillation commit (M04.7B Phase 3): Automatic Thought Evolution wired into Capture -> Distillation.
//!
//! ```text
//! Capture (already durable)
//!   -> distiller proposes claims -> resolve_candidates (verbatim spans, whole-set validation)     [unchanged]
//!   -> snapshot of the capture's project (short read, lock released)
//!   -> candidate shortlist per claim (same project only) -> IdentityResolver (pure) -> drafts for REVISE
//!        (everything above runs with NO SQLite lock held: a slow classifier can never block the store)
//!   -> ONE immediate transaction:  distillation run
//!        + per claim: NEW object | system revision (compare-and-set) + evidence | pending claim | quota/unchecked fallback
//!        + one identity decision per claim
//!   -> commit -> (caller) ChangedKnowledge events
//! ```
//! Nothing is committed in pieces: a failure that is not an expected conflict rolls the WHOLE capture back, and the capture itself is
//! never touched (it was durable before distillation began), so the existing retry and failure bookkeeping apply unchanged.
//!
//! # Activation
//! The pipeline exists only if a classifier AND a revision drafter were injected, and only runs while its own persisted setting
//! (`EvolutionSettings`, default OFF, independent of Automatic Connections) is ON. `DistillationService::with_evolution` is compiled
//! for tests only, and no command exposes the setting, so production keeps the existing path. Phase 4/5 turn it on only when a real
//! classifier, real revision synthesis, consent and the review UI all exist.
//!
//! # Conflicts at commit
//! A REVISE is applied with `revise_if_current_in` against the exact revision it was decided on, inside a SAVEPOINT. If the target
//! changed (a user edit, another capture, a move, an archive) or the draft is refused, only that claim is undone and it becomes an
//! UNCERTAIN pending claim (`stale_target` / `invalid_draft`); the other claims still commit. The stale decision is never re-used and
//! never converted to a revision.

#![allow(dead_code)] // Phase 3: only tests construct the pipeline; Phase 4/5 activate it (see the module docs)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::async_util::BoxFuture;
use crate::identity::{
    eligible_candidates, resolve_capture, ClassifierFailure, ClassifierOutput, ClassifyRequest, Audit, Candidate, Claim, EvidenceSpan, IdentityClassifier, NewReason, ObjectLifecycle, Outcome, ProjectState, Relation, Resolution, ResolverPolicy, RevisionView, TargetSnapshot,
    UncheckedReason, Veto, KINDS, MAX_CANDIDATES,
};
use crate::recall::query::{interpret, MAX_QUERY_CHARS};
use crate::storage::capture_store::{CaptureStore, StoreError};
use crate::storage::evidence_store::{attach_revision_evidence_in, EvidenceRole, EvidenceSupport, NewEvidence};
use crate::storage::identity_store::{
    record_identity_decision_in, stage_uncertain_claim_in, unresolved_pending_count_in, DecisionAudit, DecisionOutcome, IdentityDecisionInput, IdentityStoreError, PendingClaim, PendingClaimInput, PoolObject,
};
use crate::storage::knowledge_store::{begin_distillation_in, insert_object_in, validate_claim, Begin, KnowledgeObject, NewKnowledgeObject, MAX_BODY_CHARS, MAX_TITLE_CHARS};
use crate::storage::lineage_store::{revise_if_current_in, CasOrigin, ExpectedRevision, ReviseConflict, RevisionContent};
use crate::storage::migrations::INBOX_PROJECT_ID;

use super::{DistillError, DistillationOutcome, RevisedObject};

/// Automatic Thought Evolution is OFF until a person turns it on, and nothing in the app can do that yet.
pub const DEFAULT_ENABLED: bool = false;

// ---------------------------------------------------------------------------------------------------------------------------------
// The setting: its own file, never Automatic Connections'.

#[derive(Serialize, Deserialize)]
struct SettingsFile {
    enabled: bool,
}

pub struct EvolutionSettings {
    enabled: AtomicBool,
    path: Option<PathBuf>,
}

impl EvolutionSettings {
    /// A missing or damaged file means the default (OFF).
    pub fn new(path: PathBuf) -> Self {
        let enabled = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<SettingsFile>(&bytes).ok()).map(|file| file.enabled).unwrap_or(DEFAULT_ENABLED);
        Self { enabled: AtomicBool::new(enabled), path: Some(path) }
    }

    pub fn in_memory(enabled: bool) -> Self {
        Self { enabled: AtomicBool::new(enabled), path: None }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Persists first, then switches: if the file cannot be written nothing changes.
    pub fn set(&self, enabled: bool) -> std::io::Result<()> {
        if let Some(path) = &self.path {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temporary = path.with_extension("tmp");
            std::fs::write(&temporary, serde_json::to_vec(&SettingsFile { enabled }).unwrap_or_default())?;
            std::fs::rename(&temporary, path)?;
        }
        self.enabled.store(enabled, Ordering::SeqCst);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The injected pieces.

/// What the drafter is asked for: new text for the target that reflects the claim. Phase 4 implements this with real synthesis; Phase 3
/// only has test doubles.
pub struct DraftRequest<'a> {
    pub claim: &'a Claim,
    pub target: &'a Candidate,
    pub relation: Relation,
    /// What currently supports the target, so a correction can name exactly which evidence it withdraws.
    pub support: &'a EvidenceSupport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionDraft {
    pub content: RevisionContent,
    pub role: EvidenceRole,
    /// `(revision id, ordinal)` of an ACTIVE stored evidence row of the target that this draft corrects or replaces.
    pub retracts: Option<(String, i64)>,
    pub interpretation_label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftFailure {
    Unavailable,
    Refused,
}

pub trait RevisionDrafter {
    fn draft(&self, request: &DraftRequest<'_>) -> Result<RevisionDraft, DraftFailure>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvolutionLimits {
    /// Unresolved pending claims one project may hold. Beyond it a claim is kept as a separate object, never dropped.
    pub max_unresolved_pending: usize,
    /// A new pending claim is reported "due for resolution" after this many days. Reporting only.
    pub pending_due_days: i64,
}

impl Default for EvolutionLimits {
    fn default() -> Self {
        Self { max_unresolved_pending: 50, pending_due_days: 14 }
    }
}

/// An identity classifier that needs the network. The adapter fetches EVERY claim's classification first (no database lock held, no
/// runtime nesting), and the pure, synchronous resolver then reads those finished results through `Prefetched`. It receives only the
/// already-filtered candidate sets, so nothing outside the capture's project can ever be sent.
pub trait AsyncIdentityClassifier: Send + Sync {
    /// One result per item, in order. Must be bounded (requests, time, bytes) and must fail closed.
    fn classify_capture<'a>(&'a self, items: &'a [(Claim, Vec<IdCandidate>)]) -> BoxFuture<'a, Vec<Result<ClassifierOutput, ClassifierFailure>>>;
}

use crate::identity::Candidate as IdCandidate;

pub enum ClassifierBackend {
    /// Answers immediately (the Phase 3 test doubles).
    Sync(Arc<dyn IdentityClassifier + Send + Sync>),
    /// Needs the network: prefetched before the pure resolver runs.
    Async(Arc<dyn AsyncIdentityClassifier>),
}

/// Finished classifications, replayed to the synchronous resolver by claim ordinal. A request for a different candidate set than the one
/// that was fetched for is refused (`Unavailable`): a stale or mismatched result is never reused.
pub struct Prefetched {
    results: HashMap<usize, (Vec<String>, Result<ClassifierOutput, ClassifierFailure>)>,
}

impl Prefetched {
    pub fn new(items: &[(Claim, Vec<IdCandidate>)], results: Vec<Result<ClassifierOutput, ClassifierFailure>>) -> Self {
        let mut map = HashMap::new();
        for (index, ((claim, candidates), result)) in items.iter().zip(results).enumerate() {
            let mut ids: Vec<String> = candidates.iter().map(|c| c.object_id.clone()).collect();
            ids.sort();
            map.insert(claim.ordinal, (ids, result));
            let _ = index;
        }
        Self { results: map }
    }

    pub fn all_failed(items: &[(Claim, Vec<IdCandidate>)], failure: ClassifierFailure) -> Self {
        Self::new(items, items.iter().map(|_| Err(failure)).collect())
    }
}

impl IdentityClassifier for Prefetched {
    fn classify(&self, request: &ClassifyRequest<'_>) -> Result<ClassifierOutput, ClassifierFailure> {
        let Some((ids, result)) = self.results.get(&request.claim.ordinal) else { return Err(ClassifierFailure::Unavailable) };
        let mut asked: Vec<String> = request.candidates.iter().map(|c| c.object_id.clone()).collect();
        asked.sort();
        if &asked != ids {
            return Err(ClassifierFailure::Unavailable);
        }
        result.clone()
    }
}

pub struct EvolutionPipeline {
    pub settings: Arc<EvolutionSettings>,
    pub classifier: ClassifierBackend,
    /// Anything else that must still hold (for example provider consent), read before the request, after it, and again inside the
    /// commit transaction before any revision is written. `None`: nothing more is required.
    pub still_allowed: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub drafter: Arc<dyn RevisionDrafter + Send + Sync>,
    pub policy: ResolverPolicy,
    pub limits: EvolutionLimits,
}

impl EvolutionPipeline {
    pub fn enabled(&self) -> bool {
        self.settings.enabled()
    }

    /// Switched on AND every additional requirement (consent) still holds right now.
    pub fn allowed(&self) -> bool {
        self.enabled() && self.still_allowed.as_ref().is_none_or(|check| check())
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Names stored in the audit.

pub fn veto_name(veto: Veto) -> &'static str {
    match veto {
        Veto::ProjectMismatch => "project_mismatch",
        Veto::ProjectArchived => "project_archived",
        Veto::TargetArchived => "target_archived",
        Veto::InconsistentSnapshot => "inconsistent_snapshot",
        Veto::ClassifierFailed(_) => "classifier_failed",
        Veto::UnknownModel => "unknown_model",
        Veto::TooFewRuns => "too_few_runs",
        Veto::UnknownCandidateId => "unknown_candidate_id",
        Veto::DuplicateSignal => "duplicate_signal",
        Veto::IncompleteSignals => "incomplete_signals",
        Veto::OutOfRangeScore => "out_of_range_score",
        Veto::AmbiguousTarget => "ambiguous_target",
        Veto::WeakEvidence => "weak_evidence",
        Veto::RunsDisagree => "runs_disagree",
        Veto::RelationContradictsScore => "relation_contradicts_score",
        Veto::FundamentalReframing => "fundamental_reframing",
        Veto::ReframingSignal => "reframing_signal",
        Veto::SubtaskOfTarget => "subtask_of_target",
        Veto::ReferentUnresolved => "referent_unresolved",
        Veto::IncompatibleKind => "incompatible_kind",
        Veto::UserOwnedRevision => "user_owned_revision",
        Veto::SupersessionNotExplicit => "supersession_not_explicit",
        Veto::NotAPriorDecision => "not_a_prior_decision",
        Veto::InboxRequiresConfirmation => "inbox_requires_confirmation",
        Veto::ConflictingClaims => "conflicting_claims",
        Veto::StaleTarget => "stale_target",
        Veto::InvalidDraft => "invalid_draft",
        Veto::EvolutionWithdrawn => "evolution_withdrawn",
    }
}

fn unchecked_name(reason: UncheckedReason) -> &'static str {
    match reason {
        UncheckedReason::Disabled => "disabled",
        UncheckedReason::InvalidClaim => "invalid_claim",
        UncheckedReason::InvalidCandidates => "invalid_candidates",
        UncheckedReason::NoEligibleCandidates => "no_eligible_candidates",
        UncheckedReason::ClassifierFailed => "classifier_failed",
        UncheckedReason::MalformedSignals => "malformed_signals",
    }
}

/// What every decision of one claim records, taken from the resolver's audit (ids, scores, versions; never text).
#[derive(Clone)]
struct Parts {
    policy_version: String,
    model_id: Option<String>,
    vetoes: Vec<String>,
    audit: DecisionAudit,
}

impl Parts {
    fn from(audit: &Audit) -> Self {
        let mut vetoes: Vec<String> = Vec::new();
        for veto in &audit.vetoes {
            let name = veto_name(*veto).to_string();
            if !vetoes.contains(&name) {
                vetoes.push(name);
            }
        }
        Self {
            policy_version: audit.policy_version.clone(),
            model_id: audit.model_id.clone(),
            vetoes,
            audit: DecisionAudit {
                candidates_sent: audit.candidates_sent.clone(),
                excluded: audit.excluded.iter().map(|(id, veto)| (id.clone(), veto_name(*veto).to_string())).collect(),
                scores: audit.scores.clone(),
                runs: audit.runs as u32,
            },
        }
    }

    fn with_veto(mut self, name: &str) -> Self {
        if !self.vetoes.iter().any(|v| v == name) {
            self.vetoes.push(name.to_string());
        }
        self
    }

    fn decision(&self, capture_id: &str, ordinal: i64, outcome: DecisionOutcome) -> IdentityDecisionInput {
        IdentityDecisionInput {
            capture_id: capture_id.to_string(),
            ordinal,
            outcome,
            unchecked_reason: None,
            target_object_id: None,
            base_revision_id: None,
            result_revision_id: None,
            created_object_id: None,
            policy_version: self.policy_version.clone(),
            model_id: self.model_id.clone(),
            vetoes: self.vetoes.clone(),
            audit: self.audit.clone(),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Planning (no lock held).

enum Plan {
    /// `None`: a classifier ran and found no referent (verified NEW). `Some(reason)`: identity was NOT established.
    New(Option<&'static str>),
    Revise { target: TargetSnapshot, draft: RevisionDraft },
    Uncertain(Vec<String>),
}

struct Planned {
    plan: Plan,
    parts: Parts,
}

/// The pool objects that share the most words with the claim, at most `MAX_CANDIDATES`. Nothing outside the pool (one project) exists
/// here, and a claim whose words match nothing has no candidates, which is the safe default (NEW).
fn shortlist<'a>(claim: &NewKnowledgeObject, pool: &'a [PoolObject]) -> Vec<&'a PoolObject> {
    let text: String = format!("{}. {}", claim.title, claim.body).chars().take(MAX_QUERY_CHARS).collect();
    let Ok(query) = interpret(&text) else { return Vec::new() };
    let mut scored: Vec<(usize, usize, &PoolObject)> = pool
        .iter()
        .enumerate()
        .filter_map(|(position, object)| {
            let words = crate::recall::query::tokens(&format!("{} {}", object.title, object.body));
            let shared = query.terms.iter().filter(|term| words.iter().any(|word| term.matches_token(word))).count();
            (shared > 0).then_some((shared, position, object))
        })
        .collect();
    // most shared words first; on a tie the newer object (pool order is newest first)
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().take(MAX_CANDIDATES).map(|(_, _, object)| object).collect()
}

fn candidate_of(object: &PoolObject, project: &ProjectState) -> Candidate {
    Candidate {
        object_id: object.object_id.clone(),
        project: project.clone(),
        lifecycle: ObjectLifecycle::Active,
        current_revision_id: object.revision_id.clone(),
        revision: RevisionView { id: object.revision_id.clone(), origin: object.revision_origin.clone(), kind: object.kind.clone(), title: object.title.clone(), body: object.body.clone() },
    }
}

/// Why a draft cannot be committed, checked before the transaction. `None` means acceptable.
fn draft_problem(base: &PoolObject, draft: &RevisionDraft, support: &EvidenceSupport) -> Option<&'static str> {
    let content = &draft.content;
    if !KINDS.contains(&content.kind.as_str())
        || content.title.trim().is_empty()
        || content.body.trim().is_empty()
        || content.title.chars().count() > MAX_TITLE_CHARS
        || content.body.chars().count() > MAX_BODY_CHARS
    {
        return Some("the draft is empty, too long or has an unknown kind");
    }
    if (content.kind.as_str(), content.title.as_str(), content.body.as_str()) == (base.kind.as_str(), base.title.as_str(), base.body.as_str()) {
        return Some("the draft changes nothing");
    }
    match (&draft.retracts, draft.role) {
        (Some(_), EvidenceRole::Asserts) => Some("`asserts` cannot withdraw evidence"),
        (Some((revision, ordinal)), _) if !support.active.iter().any(|item| item.revision_id == *revision && item.ordinal == Some(*ordinal)) => Some("the draft withdraws evidence that is not currently active"),
        _ => None,
    }
}

/// Everything the classifier needs, read in one short, lock-scoped snapshot.
fn prepare(store: &CaptureStore, capture_id: &str, content: &str, claims: &[NewKnowledgeObject]) -> Result<Vec<(Claim, Vec<Candidate>)>, DistillError> {
    let (project_id, archived, pool) = store
        .identity_snapshot(capture_id)
        .map_err(to_distill)?
        .ok_or_else(|| DistillError::Storage("the capture disappeared".into()))?;
    let project = ProjectState { id: project_id.clone(), archived, is_inbox: project_id == INBOX_PROJECT_ID };
    let chars: Vec<char> = content.chars().collect();

    Ok(claims
        .iter()
        .enumerate()
        .map(|(ordinal, claim)| {
            let evidence_text: String = chars[claim.source_start as usize..claim.source_end as usize].iter().collect();
            let model_claim = Claim {
                ordinal,
                kind: claim.kind.clone(),
                title: claim.title.clone(),
                body: claim.body.clone(),
                evidence: EvidenceSpan { capture_id: capture_id.to_string(), start: claim.source_start, end: claim.source_end },
                evidence_text,
                project: project.clone(),
            };
            let candidates: Vec<Candidate> = shortlist(claim, &pool).into_iter().map(|object| candidate_of(object, &project)).collect();
            // exactly what the resolver would show a classifier: same project, unarchived, consistent. Only this set is ever sent anywhere.
            let eligible = eligible_candidates(&model_claim, &candidates);
            (model_claim, eligible)
        })
        .collect())
}

fn plan_from(store: &CaptureStore, pipeline: &EvolutionPipeline, items: &[(Claim, Vec<Candidate>)], classifier: &dyn IdentityClassifier) -> Vec<Planned> {
    let mut policy = pipeline.policy.clone();
    policy.enabled = true; // the pipeline only runs while its own setting is ON
    let resolutions = resolve_capture(items, &policy, classifier);
    resolutions.into_iter().zip(items.iter()).map(|(resolution, (claim, candidates))| plan_one(store, pipeline, resolution, claim, candidates)).collect()
}

fn plan_one(store: &CaptureStore, pipeline: &EvolutionPipeline, resolution: Resolution, claim: &Claim, candidates: &[Candidate]) -> Planned {
    let parts = Parts::from(&resolution.audit);
    match resolution.outcome {
        Outcome::New { reason: NewReason::Distinct } => Planned { plan: Plan::New(None), parts },
        Outcome::New { reason: NewReason::Unchecked(reason) } => Planned { plan: Plan::New(Some(unchecked_name(reason))), parts },
        Outcome::Uncertain { candidates, .. } => Planned { plan: Plan::Uncertain(candidates), parts },
        Outcome::Revise { target, relation } => {
            let downgrade = |parts: Parts| Planned { plan: Plan::Uncertain(vec![target.object_id.clone()]), parts: parts.with_veto("invalid_draft") };
            let Some(candidate) = candidates.iter().find(|c| c.object_id == target.object_id) else { return downgrade(parts) };
            let Ok(support) = store.evidence_support(&candidate.revision.id) else { return downgrade(parts) };
            let Ok(draft) = pipeline.drafter.draft(&DraftRequest { claim, target: candidate, relation, support: &support }) else { return downgrade(parts) };
            let base = PoolObject {
                object_id: candidate.object_id.clone(),
                kind: candidate.revision.kind.clone(),
                title: candidate.revision.title.clone(),
                body: candidate.revision.body.clone(),
                revision_id: candidate.revision.id.clone(),
                revision_origin: candidate.revision.origin.clone(),
            };
            if draft_problem(&base, &draft, &support).is_some() {
                return downgrade(parts);
            }
            Planned { plan: Plan::Revise { target, draft }, parts }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The commit.

type R<T> = Result<T, IdentityStoreError>;

enum Committed {
    /// Another attempt finished this capture first; nothing was written.
    Existing(Vec<KnowledgeObject>),
    Fresh { objects: Vec<KnowledgeObject>, revised: Vec<RevisedObject>, pending: Vec<PendingClaim> },
}

fn to_distill(error: IdentityStoreError) -> DistillError {
    match error {
        IdentityStoreError::Invalid(reason) => DistillError::InvalidOutput(reason),
        IdentityStoreError::Store(StoreError::Invalid(reason)) => DistillError::InvalidOutput(reason),
        IdentityStoreError::Store(other) => DistillError::Storage(other.to_string()),
        IdentityStoreError::NotFound(reason) | IdentityStoreError::Conflict(reason) => DistillError::Storage(reason),
        IdentityStoreError::Revise(conflict) => DistillError::Storage(format!("revision conflict: {conflict:?}")),
    }
}

/// An expected conflict is downgraded to a pending claim; anything else (a failing write) aborts the whole capture.
fn downgrade_reason(error: &IdentityStoreError) -> Option<&'static str> {
    match error {
        IdentityStoreError::Revise(ReviseConflict::Rejected(_)) | IdentityStoreError::Invalid(_) | IdentityStoreError::Conflict(_) => Some("invalid_draft"),
        IdentityStoreError::Revise(ReviseConflict::Stale { .. } | ReviseConflict::ProjectMismatch { .. } | ReviseConflict::ProjectArchived | ReviseConflict::ObjectNotFound) => Some("stale_target"),
        _ => None,
    }
}

struct Ctx<'a> {
    capture_id: &'a str,
    project_id: &'a str,
    limits: &'a EvolutionLimits,
    due_at: String,
}

fn create_object(tx: &Connection, ctx: &Ctx<'_>, ordinal: i64, claim: &NewKnowledgeObject, parts: &Parts, unchecked: Option<&str>) -> R<KnowledgeObject> {
    let object = insert_object_in(tx, ctx.capture_id, ctx.project_id, claim.clone())?;
    let mut decision = parts.decision(ctx.capture_id, ordinal, if unchecked.is_some() { DecisionOutcome::Unchecked } else { DecisionOutcome::New });
    decision.created_object_id = Some(object.id.clone());
    decision.unchecked_reason = unchecked.map(str::to_string);
    record_identity_decision_in(tx, &decision)?;
    Ok(object)
}

/// UNCERTAIN: a durable pending claim. If its candidates are no longer valid, or the project's review queue is full, the claim is NOT
/// dropped: it becomes a separate object recorded as UNCHECKED (with the reason), never as a verified NEW.
fn stage_or_fall_back(tx: &Connection, ctx: &Ctx<'_>, ordinal: i64, claim: &NewKnowledgeObject, parts: &Parts, candidates: &[String], stale: bool) -> R<Staged> {
    let still_local: Vec<String> = candidates
        .iter()
        .filter(|id| tx.query_row("SELECT project_id FROM knowledge_objects WHERE id = ?1", [id.as_str()], |row| row.get::<_, String>(0)).is_ok_and(|project| project == ctx.project_id))
        .cloned()
        .collect();
    let parts = if stale { parts.clone().with_veto("stale_target") } else { parts.clone() };
    if still_local.is_empty() {
        return Ok(Staged::Object(create_object(tx, ctx, ordinal, claim, &parts, Some("invalid_candidates"))?));
    }
    if unresolved_pending_count_in(tx, ctx.project_id)? >= ctx.limits.max_unresolved_pending {
        return Ok(Staged::Object(create_object(tx, ctx, ordinal, claim, &parts, Some("review_quota"))?));
    }
    let input = PendingClaimInput {
        decision: parts.decision(ctx.capture_id, ordinal, DecisionOutcome::Uncertain),
        kind: claim.kind.clone(),
        title: claim.title.clone(),
        body: claim.body.clone(),
        source_start: claim.source_start,
        source_end: claim.source_end,
        candidate_ids: still_local,
        due_at: Some(ctx.due_at.clone()),
    };
    Ok(Staged::Pending(stage_uncertain_claim_in(tx, &input)?.0))
}

enum Staged {
    Object(KnowledgeObject),
    Pending(PendingClaim),
}

/// Applies one REVISE inside a SAVEPOINT: the compare-and-set revision, the claim's real capture span as evidence, and the decision.
/// `Ok(Err(reason))`: an expected conflict; only this claim's writes were undone. Any other error propagates and aborts the capture.
fn try_revise(tx: &Connection, ctx: &Ctx<'_>, ordinal: i64, claim: &NewKnowledgeObject, target: &TargetSnapshot, draft: &RevisionDraft, parts: &Parts) -> R<Result<RevisedObject, &'static str>> {
    tx.execute_batch("SAVEPOINT claim")?;
    let attempt = (|| -> R<RevisedObject> {
        // The claim's capture may have moved since the decision; a target in another project is never revised from it.
        if target.project_id != ctx.project_id {
            return Err(IdentityStoreError::Revise(ReviseConflict::ProjectMismatch { actual: ctx.project_id.to_string() }));
        }
        let revision = revise_if_current_in(
            tx,
            &ExpectedRevision { object_id: &target.object_id, project_id: &target.project_id, base_revision_id: &target.base_revision_id },
            draft.content.clone(),
            CasOrigin::System,
        )?;
        attach_revision_evidence_in(
            tx,
            &revision.id,
            &[NewEvidence {
                capture_id: ctx.capture_id.to_string(),
                source_start: claim.source_start,
                source_end: claim.source_end,
                role: draft.role,
                retracts: draft.retracts.clone(),
                interpretation_label: draft.interpretation_label.clone(),
            }],
        )?;
        let mut decision = parts.decision(ctx.capture_id, ordinal, DecisionOutcome::Revise);
        decision.target_object_id = Some(target.object_id.clone());
        decision.base_revision_id = Some(target.base_revision_id.clone());
        decision.result_revision_id = Some(revision.id.clone());
        record_identity_decision_in(tx, &decision)?;
        Ok(RevisedObject { object_id: target.object_id.clone(), previous_revision_id: target.base_revision_id.clone(), revision_id: revision.id })
    })();
    match attempt {
        Ok(revised) => {
            tx.execute_batch("RELEASE claim")?;
            Ok(Ok(revised))
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO claim; RELEASE claim")?;
            downgrade_reason(&error).map_or(Err(error), |reason| Ok(Err(reason)))
        }
    }
}

fn apply(tx: &Connection, capture_id: &str, claims: &[NewKnowledgeObject], planned: Vec<Planned>, limits: &EvolutionLimits, allowed: &dyn Fn() -> bool) -> R<Committed> {
    let start = match begin_distillation_in(tx, capture_id)? {
        Begin::Existing(existing) => return Ok(Committed::Existing(existing)),
        Begin::Fresh(start) => start,
    };
    for (index, claim) in claims.iter().enumerate() {
        validate_claim(&start.content, claim).map_err(|reason| IdentityStoreError::Invalid(format!("object {index}: {reason}")))?;
    }
    let due = OffsetDateTime::now_utc() + time::Duration::days(limits.pending_due_days);
    let due_at = due.format(&Rfc3339).map_err(|e| IdentityStoreError::Store(StoreError::Corrupt(format!("cannot format a time: {e}"))))?;
    let ctx = Ctx { capture_id, project_id: &start.project_id, limits, due_at };

    let (mut objects, mut revised, mut pending) = (Vec::new(), Vec::new(), Vec::new());
    for (index, (claim, planned)) in claims.iter().zip(planned).enumerate() {
        let ordinal = index as i64;
        let Planned { plan, parts } = planned;
        let disposed = match plan {
            Plan::New(unchecked) => Disposed::Object(create_object(tx, &ctx, ordinal, claim, &parts, unchecked)?),
            Plan::Uncertain(candidates) => stage_or_fall_back(tx, &ctx, ordinal, claim, &parts, &candidates, false)?.into(),
            // the latest enabled/consent state is read again here, under the commit: a withdrawn permission means no revision is written
            Plan::Revise { target, .. } if !allowed() => stage_or_fall_back(tx, &ctx, ordinal, claim, &parts.clone().with_veto("evolution_withdrawn"), &[target.object_id.clone()], false)?.into(),
            Plan::Revise { target, draft } => match try_revise(tx, &ctx, ordinal, claim, &target, &draft, &parts)? {
                Ok(done) => Disposed::Revised(done),
                Err(reason) => stage_or_fall_back(tx, &ctx, ordinal, claim, &parts.clone().with_veto(reason), &[target.object_id.clone()], reason == "stale_target")?.into(),
            },
        };
        match disposed {
            Disposed::Object(object) => objects.push(object),
            Disposed::Revised(done) => revised.push(done),
            Disposed::Pending(claim) => pending.push(claim),
        }
    }
    Ok(Committed::Fresh { objects, revised, pending })
}

enum Disposed {
    Object(KnowledgeObject),
    Revised(RevisedObject),
    Pending(PendingClaim),
}

impl From<Staged> for Disposed {
    fn from(staged: Staged) -> Self {
        match staged {
            Staged::Object(object) => Disposed::Object(object),
            Staged::Pending(claim) => Disposed::Pending(claim),
        }
    }
}

/// The identity-aware replacement for `record_distillation`. Called only while the pipeline is enabled.
///
/// Concurrency: the snapshot read, the (possibly networked) classification and the drafts all happen with NO database lock held; the
/// only lock is the one short IMMEDIATE transaction at the end. A network classifier is awaited here, in the caller's task, and its
/// finished results are handed to the synchronous resolver, so no runtime is ever nested and nothing blocks while a request is in flight.
pub async fn commit_with_identity(store: &CaptureStore, pipeline: &EvolutionPipeline, capture_id: &str, content: &str, mut claims: Vec<NewKnowledgeObject>) -> Result<DistillationOutcome, DistillError> {
    if claims.is_empty() {
        // Nothing to decide: the recorded empty run is exactly what the plain path writes.
        return Ok(DistillationOutcome::plain(store.record_distillation(capture_id, claims)?));
    }
    // Source order, so a claim's ordinal is its position in reading order (the same order `record_distillation` stores).
    claims.sort_by_key(|claim| (claim.source_start, claim.source_end));
    let items = prepare(store, capture_id, content, &claims)?;

    let planned = match &pipeline.classifier {
        ClassifierBackend::Sync(classifier) => plan_from(store, pipeline, &items, classifier.as_ref()),
        ClassifierBackend::Async(classifier) => {
            // Nothing is sent unless the feature is on and every extra requirement (consent) holds right now.
            let results = if pipeline.allowed() { classifier.classify_capture(&items).await } else { items.iter().map(|_| Err(ClassifierFailure::Unavailable)).collect() };
            // ...and again after the wait: a result that arrives after the person switched off or revoked consent is discarded.
            let prefetched = if pipeline.allowed() { Prefetched::new(&items, results) } else { Prefetched::all_failed(&items, ClassifierFailure::Unavailable) };
            plan_from(store, pipeline, &items, &prefetched)
        }
    };
    let allowed = || pipeline.allowed();
    let committed = store.in_identity_transaction(|tx| apply(tx, capture_id, &claims, planned, &pipeline.limits, &allowed)).map_err(to_distill)?;
    Ok(match committed {
        Committed::Existing(objects) => DistillationOutcome { objects, revised: Vec::new(), pending: Vec::new(), fresh: false },
        Committed::Fresh { objects, revised, pending } => DistillationOutcome { objects, revised, pending, fresh: true },
    })
}
