//! Durable identity decisions and pending claims (M04.7B Phase 2, schema v8). STORAGE ONLY.
//!
//! Nothing here classifies anything, calls a network, or is called by distillation, a command or the UI yet. It gives the future
//! identity pipeline (Phase 3) primitives that cannot be used inconsistently:
//!
//! * `record_identity_decision`: one immutable decision per (capture, claim ordinal). Repeating the identical decision returns the
//!   stored one; a different one is a conflict. `unchecked` is stored as its own outcome and can never pass for a verified `new`.
//! * `stage_uncertain_claim`: the UNCERTAIN decision and its pending claim, together, idempotently.
//! * `accept_pending_claim` / `separate_pending_claim`: the authoritative operation (a compare-and-set revision plus its evidence, or a
//!   new object) and the terminal state change happen in ONE transaction. A terminal state is never written without its proof.
//! * `defer_pending_claim` / `reopen_pending_claim` / `due_pending_claims`: nothing expires into deletion; "due" is only reported.
//! * `in_identity_transaction`: a transaction-scoped interface so a caller can compose decision + revision + evidence + pending state in
//!   one commit instead of several independent ones. Every `*_in` function takes the open transaction and never commits.
//!
//! The audit JSON is built here from typed fields (ids, scores, counts, allow-listed veto names), never accepted as free text, so it
//! cannot carry capture text, object text, provider payloads or credentials. The schema repeats the JSON shape and size limits.

#![allow(dead_code)] // Phase 2 is storage only: nothing outside the tests calls these yet (Phase 3 wires the pipeline)

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capture_store::{now_rfc3339, CaptureStore, StoreError};
use super::evidence_store::{attach_revision_evidence_in, EvidenceRole, NewEvidence};
use super::knowledge_store::{validate_span, KINDS, MAX_BODY_CHARS, MAX_TITLE_CHARS};
use super::lineage_store::{create_initial_revision, revise_if_current_in, CasOrigin, ExpectedRevision, ReviseConflict, Revision, RevisionContent};
use super::relation_store::is_object_id;

pub const MAX_PENDING_CANDIDATES: usize = 4;
const MAX_AUDIT_ENTRIES: usize = 16;

/// Names the audit may record. A mirror of `identity::types::Veto` as snake_case; kept as data so storage imports nothing from it.
pub const VETO_NAMES: [&str; 27] = [
    "project_mismatch", "project_archived", "target_archived", "inconsistent_snapshot", "classifier_failed", "unknown_model", "too_few_runs",
    "unknown_candidate_id", "duplicate_signal", "incomplete_signals", "out_of_range_score", "ambiguous_target", "weak_evidence", "runs_disagree",
    "relation_contradicts_score", "fundamental_reframing", "reframing_signal", "subtask_of_target", "referent_unresolved", "incompatible_kind",
    "user_owned_revision", "supersession_not_explicit", "not_a_prior_decision", "inbox_requires_confirmation", "conflicting_claims", "stale_target", "invalid_draft",
];
const REFRAMING_VETOES: [&str; 2] = ["fundamental_reframing", "reframing_signal"];
pub const UNCHECKED_REASONS: [&str; 7] = ["disabled", "invalid_claim", "invalid_candidates", "no_eligible_candidates", "classifier_failed", "malformed_signals", "review_quota"];

#[derive(Debug)]
pub enum IdentityStoreError {
    /// The caller supplied something invalid or inconsistent. Nothing was written.
    Invalid(String),
    NotFound(String),
    /// The request conflicts with what is already stored (a different decision exists, the claim is already resolved otherwise, the
    /// project or revision moved on). Nothing was written.
    Conflict(String),
    Revise(ReviseConflict),
    Store(StoreError),
}

impl From<rusqlite::Error> for IdentityStoreError {
    fn from(error: rusqlite::Error) -> Self {
        IdentityStoreError::Store(error.into())
    }
}
impl From<StoreError> for IdentityStoreError {
    fn from(error: StoreError) -> Self {
        IdentityStoreError::Store(error)
    }
}
impl From<ReviseConflict> for IdentityStoreError {
    fn from(error: ReviseConflict) -> Self {
        IdentityStoreError::Revise(error)
    }
}

type Res<T> = Result<T, IdentityStoreError>;

fn invalid<T>(reason: impl Into<String>) -> Res<T> {
    Err(IdentityStoreError::Invalid(reason.into()))
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decisions.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionOutcome {
    /// A classifier ran, validated, and found no plausible referent.
    New,
    Revise,
    Uncertain,
    /// Identity was NOT established (disabled, invalid input, failure, quota). Never a verified NEW.
    Unchecked,
}

impl DecisionOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionOutcome::New => "new",
            DecisionOutcome::Revise => "revise",
            DecisionOutcome::Uncertain => "uncertain",
            DecisionOutcome::Unchecked => "unchecked",
        }
    }
    fn parse(raw: &str) -> Option<Self> {
        [Self::New, Self::Revise, Self::Uncertain, Self::Unchecked].into_iter().find(|o| o.as_str() == raw)
    }
}

/// The only audit data that is stored. Mirrors `identity::types::Audit`; there is deliberately no field for text.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DecisionAudit {
    pub candidates_sent: Vec<String>,
    /// `(object id, veto name)`
    pub excluded: Vec<(String, String)>,
    /// `(object id, minimum same-proposition score across runs, maximum reframing score across runs)`
    pub scores: Vec<(String, f64, f64)>,
    pub runs: u32,
}

impl DecisionAudit {
    fn validate(&self) -> Res<()> {
        let ids_ok = |id: &str| is_object_id(id);
        if self.candidates_sent.len() > MAX_AUDIT_ENTRIES || self.excluded.len() > MAX_AUDIT_ENTRIES || self.scores.len() > MAX_AUDIT_ENTRIES || self.runs > 16 {
            return invalid("audit is too large");
        }
        if !self.candidates_sent.iter().all(|id| ids_ok(id)) || !self.excluded.iter().all(|(id, veto)| ids_ok(id) && VETO_NAMES.contains(&veto.as_str())) {
            return invalid("audit holds only object ids and known veto names");
        }
        let unit = |x: f64| x.is_finite() && (0.0..=1.0).contains(&x);
        if !self.scores.iter().all(|(id, same, reframing)| ids_ok(id) && unit(*same) && unit(*reframing)) {
            return invalid("audit scores must be finite numbers between 0 and 1 for object ids");
        }
        Ok(())
    }

    fn to_json(&self) -> Value {
        json!({
            "candidatesSent": self.candidates_sent,
            "excluded": self.excluded.iter().map(|(id, veto)| json!({ "id": id, "veto": veto })).collect::<Vec<_>>(),
            "scores": self.scores.iter().map(|(id, same, reframing)| json!({ "id": id, "sameMin": same, "reframingMax": reframing })).collect::<Vec<_>>(),
            "runs": self.runs,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct IdentityDecisionInput {
    pub capture_id: String,
    pub ordinal: i64,
    pub outcome: DecisionOutcome,
    pub unchecked_reason: Option<String>,
    pub target_object_id: Option<String>,
    pub base_revision_id: Option<String>,
    pub result_revision_id: Option<String>,
    pub created_object_id: Option<String>,
    pub policy_version: String,
    pub model_id: Option<String>,
    pub vetoes: Vec<String>,
    pub audit: DecisionAudit,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IdentityDecision {
    pub input: IdentityDecisionInput,
    /// `gate` for a classified decision, `fallback` for `unchecked`.
    pub decided_by: String,
    pub decided_at: String,
}

fn validate_decision(input: &IdentityDecisionInput) -> Res<()> {
    if input.capture_id.is_empty() || input.ordinal < 0 {
        return invalid("a decision names a capture and a claim ordinal");
    }
    if input.policy_version.is_empty() || input.policy_version.chars().count() > 64 {
        return invalid("policy version must be 1 to 64 characters");
    }
    if input.model_id.as_deref().is_some_and(|m| m.is_empty() || m.chars().count() > 128) {
        return invalid("model id must be 1 to 128 characters");
    }
    if input.vetoes.len() > MAX_AUDIT_ENTRIES || !input.vetoes.iter().all(|v| VETO_NAMES.contains(&v.as_str())) {
        return invalid("vetoes must be known veto names");
    }
    if input.unchecked_reason.as_deref().is_some_and(|r| !UNCHECKED_REASONS.contains(&r)) {
        return invalid("unknown unchecked reason");
    }
    for id in [&input.target_object_id, &input.created_object_id].into_iter().flatten() {
        if !is_object_id(id) {
            return invalid("malformed object id");
        }
    }
    // The same shape the schema CHECK enforces, with precise messages. UNCHECKED never carries model verification as its basis.
    let (has_model, has_reason, target, created) = (input.model_id.is_some(), input.unchecked_reason.is_some(), input.target_object_id.is_some(), input.created_object_id.is_some());
    let (base, result) = (input.base_revision_id.is_some(), input.result_revision_id.is_some());
    let ok = match input.outcome {
        DecisionOutcome::New => has_model && !has_reason && created && !target && !base && !result,
        DecisionOutcome::Revise => has_model && !has_reason && !created && target && base && result,
        DecisionOutcome::Uncertain => has_model && !has_reason && !created && !target && !base && !result,
        DecisionOutcome::Unchecked => has_reason && created && !target && !base && !result,
    };
    if !ok {
        return invalid(format!("a `{}` decision has the wrong set of fields (new/revise/uncertain need a model id; unchecked needs a reason and never counts as verified)", input.outcome.as_str()));
    }
    input.audit.validate()
}

const DECISION_COLUMNS: &str = "capture_id, ordinal, outcome, unchecked_reason, target_object_id, base_revision_id, result_revision_id, created_object_id, policy_version, model_id, decided_by, vetoes_json, audit_json, decided_at";

fn decision_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(IdentityDecision, String)> {
    let outcome: String = row.get(2)?;
    let vetoes_json: String = row.get(11)?;
    let audit_json: String = row.get(12)?;
    let vetoes: Vec<String> = serde_json::from_str(&vetoes_json).unwrap_or_default();
    let audit = audit_from_json(&audit_json);
    Ok((
        IdentityDecision {
            input: IdentityDecisionInput {
                capture_id: row.get(0)?,
                ordinal: row.get(1)?,
                outcome: DecisionOutcome::parse(&outcome).unwrap_or(DecisionOutcome::Unchecked),
                unchecked_reason: row.get(3)?,
                target_object_id: row.get(4)?,
                base_revision_id: row.get(5)?,
                result_revision_id: row.get(6)?,
                created_object_id: row.get(7)?,
                policy_version: row.get(8)?,
                model_id: row.get(9)?,
                vetoes,
                audit,
            },
            decided_by: row.get(10)?,
            decided_at: row.get(13)?,
        },
        outcome,
    ))
}

fn audit_from_json(raw: &str) -> DecisionAudit {
    let value: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let strings = |key: &str| -> Vec<String> { value[key].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default() };
    DecisionAudit {
        candidates_sent: strings("candidatesSent"),
        excluded: value["excluded"].as_array().map(|a| a.iter().filter_map(|v| Some((v["id"].as_str()?.to_string(), v["veto"].as_str()?.to_string()))).collect()).unwrap_or_default(),
        scores: value["scores"].as_array().map(|a| a.iter().filter_map(|v| Some((v["id"].as_str()?.to_string(), v["sameMin"].as_f64()?, v["reframingMax"].as_f64()?))).collect()).unwrap_or_default(),
        runs: value["runs"].as_u64().unwrap_or(0) as u32,
    }
}

pub(super) fn decisions_for_in(connection: &Connection, capture_id: &str) -> Res<Vec<IdentityDecision>> {
    let mut statement = connection.prepare(&format!("SELECT {DECISION_COLUMNS} FROM identity_decisions WHERE capture_id = ?1 ORDER BY ordinal"))?;
    let rows = statement.query_map([capture_id], decision_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().map(|(decision, _)| decision).collect())
}

/// Records one decision. `created == false` means the identical decision was already stored and nothing was written.
pub fn record_identity_decision_in(connection: &Connection, input: &IdentityDecisionInput) -> Res<(IdentityDecision, bool)> {
    validate_decision(input)?;
    if input.outcome == DecisionOutcome::Uncertain {
        return invalid("an uncertain decision is recorded together with its pending claim (stage_uncertain_claim)");
    }
    insert_decision_in(connection, input)
}

fn insert_decision_in(connection: &Connection, input: &IdentityDecisionInput) -> Res<(IdentityDecision, bool)> {
    if let Some(existing) = decisions_for_in(connection, &input.capture_id)?.into_iter().find(|d| d.input.ordinal == input.ordinal) {
        return if existing.input == *input {
            Ok((existing, false))
        } else {
            Err(IdentityStoreError::Conflict("a different identity decision is already recorded for this claim".into()))
        };
    }
    let ran: bool = connection.query_row("SELECT 1 FROM distillation_runs WHERE capture_id = ?1", [&input.capture_id], |_| Ok(true)).optional()?.unwrap_or(false);
    if !ran {
        return invalid("the capture has no distillation run");
    }
    let decided_by = if input.outcome == DecisionOutcome::Unchecked { "fallback" } else { "gate" };
    let decided_at = now_rfc3339()?;
    connection.execute(
        &format!("INSERT INTO identity_decisions ({DECISION_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
        params![
            input.capture_id, input.ordinal, input.outcome.as_str(), input.unchecked_reason, input.target_object_id, input.base_revision_id, input.result_revision_id,
            input.created_object_id, input.policy_version, input.model_id, decided_by, serde_json::to_string(&input.vetoes).unwrap_or_else(|_| "[]".into()),
            input.audit.to_json().to_string(), decided_at
        ],
    )?;
    Ok((IdentityDecision { input: input.clone(), decided_by: decided_by.into(), decided_at }, true))
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Pending claims.

pub const PENDING_STATES: [&str; 4] = ["open", "deferred", "accepted", "separated"];

#[derive(Debug, Clone, PartialEq)]
pub struct PendingClaimInput {
    /// Must be an `uncertain` decision; stored together with the claim.
    pub decision: IdentityDecisionInput,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub source_start: i64,
    pub source_end: i64,
    /// 1 to 4 existing objects of the capture's project.
    pub candidate_ids: Vec<String>,
    /// When the claim becomes "due for resolution" (RFC 3339). Reporting only: reaching it changes nothing by itself.
    pub due_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingClaim {
    pub id: String,
    pub capture_id: String,
    pub ordinal: i64,
    /// The capture's CURRENT project: a moved capture takes its claim with it.
    pub project_id: String,
    pub project_archived: bool,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub source_start: i64,
    pub source_end: i64,
    pub candidate_ids: Vec<String>,
    pub reasons: Vec<String>,
    pub reframing: bool,
    pub state: String,
    pub due_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deferred_at: Option<String>,
    pub resolved_at: Option<String>,
    pub resolved_method: Option<String>,
    pub resolved_object_id: Option<String>,
    pub resolved_revision_id: Option<String>,
}

impl PendingClaim {
    pub fn is_terminal(&self) -> bool {
        matches!(self.state.as_str(), "accepted" | "separated")
    }
}

const PENDING_SELECT: &str = "SELECT p.id, p.capture_id, p.ordinal, c.project_id, pr.archived_at IS NOT NULL, p.kind, p.title, p.body, p.source_start, p.source_end, \
    p.candidate_ids_json, p.reasons_json, p.reframing, p.state, p.due_at, p.created_at, p.updated_at, p.deferred_at, p.resolved_at, p.resolved_method, \
    p.resolved_object_id, p.resolved_revision_id FROM pending_claims p JOIN captures c ON c.id = p.capture_id JOIN projects pr ON pr.id = c.project_id";

fn pending_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingClaim> {
    let list = |raw: String| serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default();
    Ok(PendingClaim {
        id: row.get(0)?,
        capture_id: row.get(1)?,
        ordinal: row.get(2)?,
        project_id: row.get(3)?,
        project_archived: row.get(4)?,
        kind: row.get(5)?,
        title: row.get(6)?,
        body: row.get(7)?,
        source_start: row.get(8)?,
        source_end: row.get(9)?,
        candidate_ids: list(row.get(10)?),
        reasons: list(row.get(11)?),
        reframing: row.get::<_, i64>(12)? == 1,
        state: row.get(13)?,
        due_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        deferred_at: row.get(17)?,
        resolved_at: row.get(18)?,
        resolved_method: row.get(19)?,
        resolved_object_id: row.get(20)?,
        resolved_revision_id: row.get(21)?,
    })
}

pub(super) fn pending_in(connection: &Connection, id: &str) -> Res<Option<PendingClaim>> {
    Ok(connection.query_row(&format!("{PENDING_SELECT} WHERE p.id = ?1"), [id], pending_from_row).optional()?)
}

fn pending_for_claim_in(connection: &Connection, capture_id: &str, ordinal: i64) -> Res<Option<PendingClaim>> {
    Ok(connection.query_row(&format!("{PENDING_SELECT} WHERE p.capture_id = ?1 AND p.ordinal = ?2"), params![capture_id, ordinal], pending_from_row).optional()?)
}

fn parse_time(raw: &str) -> Res<OffsetDateTime> {
    OffsetDateTime::parse(raw, &Rfc3339).map_err(|_| IdentityStoreError::Invalid("a time must be RFC 3339".into()))
}

fn validate_pending(connection: &Connection, input: &PendingClaimInput) -> Res<()> {
    validate_decision(&input.decision)?;
    if input.decision.outcome != DecisionOutcome::Uncertain {
        return invalid("a pending claim belongs to an uncertain decision");
    }
    if !KINDS.contains(&input.kind.as_str()) {
        return invalid("unknown kind");
    }
    if input.title.trim().is_empty() || input.title.chars().count() > MAX_TITLE_CHARS || input.body.trim().is_empty() || input.body.chars().count() > MAX_BODY_CHARS {
        return invalid("title or body is empty or too long");
    }
    let unique: std::collections::BTreeSet<&String> = input.candidate_ids.iter().collect();
    if input.candidate_ids.is_empty() || input.candidate_ids.len() > MAX_PENDING_CANDIDATES || unique.len() != input.candidate_ids.len() || !input.candidate_ids.iter().all(|id| is_object_id(id)) {
        return invalid("a pending claim names 1 to 4 distinct candidate objects");
    }
    if let Some(due) = &input.due_at {
        parse_time(due)?;
    }
    let content: Option<String> = connection.query_row("SELECT content FROM captures WHERE id = ?1", [&input.decision.capture_id], |row| row.get(0)).optional()?;
    let content = content.ok_or_else(|| IdentityStoreError::Invalid("the capture does not exist".into()))?;
    validate_span(&content, input.source_start, input.source_end).or_else(|reason| invalid(reason))
}

/// Stores the UNCERTAIN decision and its pending claim together. Idempotent: the identical claim returns the stored one
/// (`created == false`); a different claim for the same (capture, ordinal) is a conflict. A full review queue never discards a claim:
/// this function has no quota, so the caller decides what to do (Phase 3: keep it as a separate object) and nothing is dropped here.
pub fn stage_uncertain_claim_in(connection: &Connection, input: &PendingClaimInput) -> Res<(PendingClaim, bool)> {
    validate_pending(connection, input)?;
    if let Some(existing) = pending_for_claim_in(connection, &input.decision.capture_id, input.decision.ordinal)? {
        let same = existing.kind == input.kind && existing.title == input.title && existing.body == input.body && existing.source_start == input.source_start
            && existing.source_end == input.source_end && existing.candidate_ids == input.candidate_ids;
        return if same { Ok((existing, false)) } else { Err(IdentityStoreError::Conflict("a different claim is already pending for this capture and ordinal".into())) };
    }
    insert_decision_in(connection, &input.decision)?;
    let reframing = input.decision.vetoes.iter().any(|v| REFRAMING_VETOES.contains(&v.as_str()));
    let now = now_rfc3339()?;
    let id = Uuid::new_v4().to_string();
    connection.execute(
        "INSERT INTO pending_claims (id, capture_id, ordinal, kind, title, body, source_start, source_end, candidate_ids_json, reasons_json, reframing, state, due_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'open', ?12, ?13, ?13)",
        params![
            id, input.decision.capture_id, input.decision.ordinal, input.kind, input.title, input.body, input.source_start, input.source_end,
            serde_json::to_string(&input.candidate_ids).unwrap_or_default(), serde_json::to_string(&input.decision.vetoes).unwrap_or_default(), reframing as i64, input.due_at, now
        ],
    )?;
    Ok((pending_in(connection, &id)?.ok_or_else(|| IdentityStoreError::Store(StoreError::Corrupt("a pending claim vanished".into())))?, true))
}

#[derive(Debug, Clone)]
pub struct AcceptPendingInput {
    pub pending_id: String,
    /// One of the claim's candidates.
    pub target_object_id: String,
    /// The revision the decision to update was based on; the update happens only if it is STILL current.
    pub expected_base_revision_id: String,
    pub content: RevisionContent,
    pub role: EvidenceRole,
    /// The earlier evidence this one corrects or replaces, where that can be shown. `None` is conservative, not "nothing".
    pub retracts: Option<(String, i64)>,
    pub interpretation_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingResolution {
    pub claim: PendingClaim,
    /// `false` when the claim was already resolved the same way and nothing was written.
    pub applied: bool,
    pub revision: Option<Revision>,
    pub object_id: String,
}

fn require_pending(connection: &Connection, id: &str) -> Res<PendingClaim> {
    pending_in(connection, id)?.ok_or_else(|| IdentityStoreError::NotFound("pending claim does not exist".into()))
}

/// The user accepted "update that idea": a compare-and-set automatic revision of the target, the claim's span attached as evidence, and
/// the claim marked accepted, all in the caller's transaction (begin it IMMEDIATE). The schema refuses `accepted` without that revision.
pub fn accept_pending_claim_in(connection: &Connection, input: &AcceptPendingInput) -> Res<PendingResolution> {
    let claim = require_pending(connection, &input.pending_id)?;
    match claim.state.as_str() {
        "accepted" if claim.resolved_object_id.as_deref() == Some(input.target_object_id.as_str()) => {
            let revision = claim.resolved_revision_id.as_deref().map(|id| revision_of(connection, id)).transpose()?;
            return Ok(PendingResolution { object_id: input.target_object_id.clone(), claim, applied: false, revision });
        }
        "accepted" | "separated" => return Err(IdentityStoreError::Conflict("the claim was already resolved differently".into())),
        _ => {}
    }
    if !claim.candidate_ids.contains(&input.target_object_id) {
        return invalid("the target is not one of the claim's candidates");
    }
    let target_project: String = connection
        .query_row("SELECT project_id FROM knowledge_objects WHERE id = ?1", [&input.target_object_id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| IdentityStoreError::NotFound("the target object does not exist".into()))?;
    if target_project != claim.project_id {
        return Err(IdentityStoreError::Conflict("the capture and the target are no longer in the same project".into()));
    }
    let revision = revise_if_current_in(
        connection,
        &ExpectedRevision { object_id: &input.target_object_id, project_id: &claim.project_id, base_revision_id: &input.expected_base_revision_id },
        input.content.clone(),
        CasOrigin::System,
    )?;
    attach_revision_evidence_in(
        connection,
        &revision.id,
        &[NewEvidence { capture_id: claim.capture_id.clone(), source_start: claim.source_start, source_end: claim.source_end, role: input.role, retracts: input.retracts.clone(), interpretation_label: input.interpretation_label.clone() }],
    )?;
    let now = now_rfc3339()?;
    let changed = connection.execute(
        "UPDATE pending_claims SET state = 'accepted', resolved_at = ?2, resolved_method = 'user', resolved_object_id = ?3, resolved_revision_id = ?4, updated_at = ?2 WHERE id = ?1 AND state IN ('open', 'deferred')",
        params![claim.id, now, input.target_object_id, revision.id],
    )?;
    if changed != 1 {
        return Err(IdentityStoreError::Conflict("the claim changed while it was being resolved".into()));
    }
    Ok(PendingResolution { claim: require_pending(connection, &input.pending_id)?, applied: true, revision: Some(revision), object_id: input.target_object_id.clone() })
}

fn revision_of(connection: &Connection, id: &str) -> Res<Revision> {
    super::lineage_store::revision_for(connection, id).map_err(Into::into)
}

/// "Keep as a separate idea" (or, later, expiry): creates a new KnowledgeObject from the claim, in the capture's CURRENT project, with
/// the claim's span as its source and an initial revision, and marks the claim separated, in the caller's transaction.
pub fn separate_pending_claim_in(connection: &Connection, pending_id: &str, method: &str) -> Res<PendingResolution> {
    if !matches!(method, "user" | "expiry") {
        return invalid("unknown resolution method");
    }
    let claim = require_pending(connection, pending_id)?;
    match claim.state.as_str() {
        "separated" => {
            let object_id = claim.resolved_object_id.clone().unwrap_or_default();
            return Ok(PendingResolution { claim, applied: false, revision: None, object_id });
        }
        "accepted" => return Err(IdentityStoreError::Conflict("the claim was already accepted into an existing object".into())),
        _ => {}
    }
    if claim.project_archived {
        return Err(IdentityStoreError::Conflict("the project is archived: restore it to resolve this claim".into()));
    }
    let object_id = Uuid::new_v4().to_string();
    let now = now_rfc3339()?;
    connection.execute(
        "INSERT INTO knowledge_objects (id, kind, title, body, created_at, project_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![object_id, claim.kind, claim.title, claim.body, now, claim.project_id],
    )?;
    connection.execute("INSERT INTO object_sources (object_id, capture_id, source_start, source_end) VALUES (?1, ?2, ?3, ?4)", params![object_id, claim.capture_id, claim.source_start, claim.source_end])?;
    create_initial_revision(connection, &object_id, (&claim.kind, &claim.title, &claim.body), &now, Some((&claim.capture_id, claim.source_start, claim.source_end)))?;
    let changed = connection.execute(
        "UPDATE pending_claims SET state = 'separated', resolved_at = ?2, resolved_method = ?3, resolved_object_id = ?4, updated_at = ?2 WHERE id = ?1 AND state IN ('open', 'deferred')",
        params![claim.id, now, method, object_id],
    )?;
    if changed != 1 {
        return Err(IdentityStoreError::Conflict("the claim changed while it was being resolved".into()));
    }
    Ok(PendingResolution { claim: require_pending(connection, pending_id)?, applied: true, revision: None, object_id })
}

fn set_open_or_deferred(connection: &Connection, id: &str, to: &str, due_at: Option<&str>) -> Res<PendingClaim> {
    let claim = require_pending(connection, id)?;
    if claim.is_terminal() {
        return Err(IdentityStoreError::Conflict("the claim is already resolved".into()));
    }
    if let Some(due) = due_at {
        parse_time(due)?;
    }
    let now = now_rfc3339()?;
    let deferred_at = if to == "deferred" && claim.state != "deferred" { Some(now.clone()) } else { claim.deferred_at.clone() };
    connection.execute(
        "UPDATE pending_claims SET state = ?2, due_at = coalesce(?3, due_at), deferred_at = ?4, updated_at = ?5 WHERE id = ?1",
        params![id, to, due_at, deferred_at, now],
    )?;
    require_pending(connection, id)
}

pub fn defer_pending_claim_in(connection: &Connection, id: &str, due_at: Option<&str>) -> Res<PendingClaim> {
    set_open_or_deferred(connection, id, "deferred", due_at)
}

pub fn reopen_pending_claim_in(connection: &Connection, id: &str) -> Res<PendingClaim> {
    set_open_or_deferred(connection, id, "open", None)
}

impl CaptureStore {
    /// Runs `work` in ONE write transaction (IMMEDIATE) and commits only if it returns `Ok`; any error rolls everything back. This is the
    /// composition point for the future pipeline: distillation run + decisions + revisions + evidence + pending state in one commit.
    pub fn in_identity_transaction<T>(&self, work: impl FnOnce(&Connection) -> Res<T>) -> Res<T> {
        let mut connection = self.connection.lock().map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = work(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }

    pub fn record_identity_decision(&self, input: &IdentityDecisionInput) -> Res<(IdentityDecision, bool)> {
        self.in_identity_transaction(|tx| record_identity_decision_in(tx, input))
    }

    pub fn identity_decisions_for(&self, capture_id: &str) -> Res<Vec<IdentityDecision>> {
        let connection = self.connection.lock().map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        decisions_for_in(&connection, capture_id)
    }

    pub fn stage_uncertain_claim(&self, input: &PendingClaimInput) -> Res<(PendingClaim, bool)> {
        self.in_identity_transaction(|tx| stage_uncertain_claim_in(tx, input))
    }

    pub fn get_pending_claim(&self, id: &str) -> Res<Option<PendingClaim>> {
        let connection = self.connection.lock().map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        pending_in(&connection, id)
    }

    /// Claims in the given states (empty = every state), optionally of one project (the capture's current one, archived included).
    /// Oldest first. Nothing is ever filtered out because of age or quota: a deferred or expired-due claim is still listed.
    pub fn list_pending_claims(&self, project_id: Option<&str>, states: &[&str]) -> Res<Vec<PendingClaim>> {
        if states.iter().any(|s| !PENDING_STATES.contains(s)) {
            return invalid("unknown pending state");
        }
        let connection = self.connection.lock().map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        let mut statement = connection.prepare(&format!("{PENDING_SELECT} WHERE (?1 IS NULL OR c.project_id = ?1) ORDER BY p.seq"))?;
        let rows = statement.query_map([project_id], pending_from_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().filter(|claim| states.is_empty() || states.contains(&claim.state.as_str())).collect())
    }

    /// Open or deferred claims whose `due_at` has passed `now`, in an OPEN project, oldest first. This only REPORTS: it resolves and
    /// hides nothing. A claim in an archived project is not returned (it cannot be resolved) but stays listed by `list_pending_claims`.
    pub fn due_pending_claims(&self, now: &str, limit: usize) -> Res<Vec<PendingClaim>> {
        let now = parse_time(now)?;
        let all = self.list_pending_claims(None, &["open", "deferred"])?;
        Ok(all
            .into_iter()
            .filter(|claim| !claim.project_archived && claim.due_at.as_deref().and_then(|due| OffsetDateTime::parse(due, &Rfc3339).ok()).is_some_and(|due| due <= now))
            .take(limit)
            .collect())
    }

    pub fn defer_pending_claim(&self, id: &str, due_at: Option<&str>) -> Res<PendingClaim> {
        self.in_identity_transaction(|tx| defer_pending_claim_in(tx, id, due_at))
    }

    pub fn reopen_pending_claim(&self, id: &str) -> Res<PendingClaim> {
        self.in_identity_transaction(|tx| reopen_pending_claim_in(tx, id))
    }

    pub fn accept_pending_claim(&self, input: &AcceptPendingInput) -> Res<PendingResolution> {
        self.in_identity_transaction(|tx| accept_pending_claim_in(tx, input))
    }

    pub fn separate_pending_claim(&self, pending_id: &str, method: &str) -> Res<PendingResolution> {
        self.in_identity_transaction(|tx| separate_pending_claim_in(tx, pending_id, method))
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reads for the identity-aware distillation path (M04.7B Phase 3). Short, lock-scoped reads taken BEFORE any classifier call, so no
// SQLite lock is ever held while a provider works.

/// One object of a project as its CURRENT revision stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolObject {
    pub object_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub revision_id: String,
    pub revision_origin: String,
}

/// The capture's CURRENT project and whether it is archived.
pub fn capture_project_in(connection: &Connection, capture_id: &str) -> Res<Option<(String, bool)>> {
    Ok(connection
        .query_row("SELECT c.project_id, p.archived_at IS NOT NULL FROM captures c JOIN projects p ON p.id = c.project_id WHERE c.id = ?1", [capture_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?)
}

/// Every object of a project with its current revision, newest first. Nothing from another project is ever returned.
pub fn project_pool_in(connection: &Connection, project_id: &str) -> Res<Vec<PoolObject>> {
    let mut statement = connection.prepare(
        "SELECT o.id, o.kind, o.title, o.body, r.id, r.origin FROM knowledge_objects o JOIN thought_revisions r ON r.id = o.current_revision_id AND r.object_id = o.id WHERE o.project_id = ?1 ORDER BY o.seq DESC",
    )?;
    let rows = statement
        .query_map([project_id], |row| Ok(PoolObject { object_id: row.get(0)?, kind: row.get(1)?, title: row.get(2)?, body: row.get(3)?, revision_id: row.get(4)?, revision_origin: row.get(5)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Open or deferred claims whose capture is CURRENTLY in the project.
pub fn unresolved_pending_count_in(connection: &Connection, project_id: &str) -> Res<usize> {
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM pending_claims p JOIN captures c ON c.id = p.capture_id WHERE c.project_id = ?1 AND p.state IN ('open', 'deferred')",
        [project_id],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

impl CaptureStore {
    /// `(project id, archived, pool)` for a capture, in one short read.
    pub fn identity_snapshot(&self, capture_id: &str) -> Res<Option<(String, bool, Vec<PoolObject>)>> {
        let connection = self.connection.lock().map_err(|_| IdentityStoreError::Store(StoreError::Poisoned))?;
        let Some((project_id, archived)) = capture_project_in(&connection, capture_id)? else { return Ok(None) };
        let pool = project_pool_in(&connection, &project_id)?;
        Ok(Some((project_id, archived, pool)))
    }
}
