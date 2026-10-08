//! Typed inputs and outputs of the identity core. Plain data: no behaviour that touches anything outside memory.

/// The knowledge kinds. Mirrors `storage::knowledge_store::KINDS` (a test keeps them equal); duplicated so this module imports no storage.
pub const KINDS: [&str; 5] = ["idea", "task", "decision", "question", "note"];

/// Candidates a single decision may weigh. More is a caller bug and fails closed.
pub const MAX_CANDIDATES: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectState {
    pub id: String,
    pub archived: bool,
    /// The Inbox mixes unrelated work, so "same project" is weak evidence there (policy decides what that means).
    pub is_inbox: bool,
}

/// Object lifecycle. Objects themselves cannot be archived today (only projects), but the contract is explicit so a future retire/fold
/// operation cannot silently make a retired object a merge target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectLifecycle {
    Active,
    Archived,
}

/// A verbatim span of a raw capture, in Unicode code points, half-open. The core never reads captures; it only checks the span is coherent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceSpan {
    pub capture_id: String,
    pub start: i64,
    pub end: i64,
}

/// ONE claim already validated by distillation (`distillation::resolve`): its verbatim evidence quote resolved to `evidence`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    /// Position in the capture's source-ordered claim list.
    pub ordinal: usize,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub evidence: EvidenceSpan,
    /// The exact words at `evidence`.
    pub evidence_text: String,
    pub project: ProjectState,
}

/// The candidate's current revision as the caller read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionView {
    pub id: String,
    /// `initial | user_edit | distillation | merge | system`
    pub origin: String,
    pub kind: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub object_id: String,
    pub project: ProjectState,
    pub lifecycle: ObjectLifecycle,
    /// Must equal `revision.id`; a mismatch means the caller read an inconsistent snapshot.
    pub current_revision_id: String,
    pub revision: RevisionView,
}

/// What a REVISE is allowed to be applied to: exactly the state the decision was made for. Feeds the compare-and-set writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetSnapshot {
    pub object_id: String,
    pub project_id: String,
    pub base_revision_id: String,
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Provider-independent signals (untrusted).

/// How a claim relates to the target, as a provider reports it. Semantics: `docs/architecture/m047b-phase1-identity-core.md` and
/// `tools/jev-bench/p1a1/IDENTITY_SEMANTICS.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    /// Adds detail to the same proposition; the earlier text stays true.
    AdditiveRefinement,
    /// Replaces a wrong value of the same proposition.
    Correction,
    /// Swaps the option chosen for an explicit prior decision.
    DecisionReplacement,
    /// Changes what the thing IS, is for, or who it is for. Never automatic.
    Reframing,
    /// A step toward an existing task. Never automatic.
    Subtask,
    /// A different feature or idea that shares the project.
    DistinctSameProject,
    Unrelated,
}

/// One provider reading about ONE candidate. Every field is untrusted until `resolver` validates it.
#[derive(Debug, Clone, PartialEq)]
pub struct CandidateSignal {
    pub candidate_id: String,
    /// 0..=1: the claim asserts the same proposition/decision as the candidate.
    pub same_proposition: f64,
    /// 0..=1: the claim changes what the candidate fundamentally is.
    pub reframing: f64,
    /// Required whenever `same_proposition` is plausible.
    pub relation: Option<Relation>,
    /// The claim names its referent (no bare "it"/"that"). Required whenever plausible.
    pub referent_resolved: Option<bool>,
    /// The claim says in words that it replaces the earlier choice. Required whenever plausible.
    pub explicit_supersession: Option<bool>,
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Decisions.

/// Why a safe default was used instead of a classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UncheckedReason {
    Disabled,
    InvalidClaim,
    InvalidCandidates,
    NoEligibleCandidates,
    ClassifierFailed,
    MalformedSignals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewReason {
    /// No candidate is a plausible referent.
    Distinct,
    /// Identity could not be checked; the claim is kept as its own object. Never a merge.
    Unchecked(UncheckedReason),
}

/// Deterministic reasons recorded in the audit. Some exclude a candidate, some downgrade a REVISE to UNCERTAIN, some fail closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Veto {
    // candidate eligibility
    ProjectMismatch,
    ProjectArchived,
    TargetArchived,
    InconsistentSnapshot,
    // signal validity (fail closed)
    ClassifierFailed(crate::identity::classifier::ClassifierFailure),
    UnknownModel,
    TooFewRuns,
    UnknownCandidateId,
    DuplicateSignal,
    IncompleteSignals,
    OutOfRangeScore,
    // identity
    AmbiguousTarget,
    WeakEvidence,
    RunsDisagree,
    RelationContradictsScore,
    // permission
    FundamentalReframing,
    ReframingSignal,
    SubtaskOfTarget,
    ReferentUnresolved,
    IncompatibleKind,
    UserOwnedRevision,
    SupersessionNotExplicit,
    NotAPriorDecision,
    InboxRequiresConfirmation,
    ConflictingClaims,
    // set by the pipeline when the world changed between the decision and the commit
    /// The target moved on (a newer revision, another project, archived) after the decision was made.
    StaleTarget,
    /// The proposed revision text was refused before or at commit.
    InvalidDraft,
    /// Automatic Thought Evolution was switched off, or the provider consent was revoked, before the result could be used.
    EvolutionWithdrawn,
}

/// WHO the claim is, independent of what may be done about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Identity {
    /// No plausible referent.
    Distinct,
    /// One uniquely resolved target.
    Same { target_id: String, relation: Relation },
    /// More than one plausible target, weak or inconsistent evidence.
    Ambiguous,
    /// Could not be determined (failure, invalid input, subtask).
    Unknown,
}

/// What the system may DO about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Permission {
    /// Every gate passed: the current revision may be changed without asking.
    Automatic,
    /// The user must confirm (the vetoes say why).
    Confirmation(Vec<Veto>),
    /// Nothing may be merged (identity says distinct or unknown).
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    New { reason: NewReason },
    Revise { target: TargetSnapshot, relation: Relation },
    Uncertain { candidates: Vec<String>, reason: Vec<Veto> },
}

/// Replayable record of one decision. Holds ids, scores and model/policy versions; never capture or object text.
#[derive(Debug, Clone, PartialEq)]
pub struct Audit {
    pub policy_version: String,
    pub model_id: Option<String>,
    pub claim_ordinal: usize,
    /// Candidates that were shown to the classifier.
    pub candidates_sent: Vec<String>,
    /// Candidates withheld before the classifier saw them, with the reason.
    pub excluded: Vec<(String, Veto)>,
    /// `(candidate id, min same_proposition across runs, max reframing across runs)`.
    pub scores: Vec<(String, f64, f64)>,
    pub runs: usize,
    pub vetoes: Vec<Veto>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub outcome: Outcome,
    pub identity: Identity,
    pub permission: Permission,
    pub audit: Audit,
}

impl Resolution {
    pub fn is_revise(&self) -> bool {
        matches!(self.outcome, Outcome::Revise { .. })
    }
}
