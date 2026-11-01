//! Grounded revision synthesis and independent veto-only verification (M04.7B Phase 4B).
//!
//! ```text
//! IdentityResolver says REVISE (authorized target, relation)         <- identity decides WHAT is revised; nothing here can change that
//!   -> SynthesisRequest (server-owned): current text, the new claim and its exact words, the target's ACTIVE evidence quotes
//!   -> RevisionSynthesizer (async)  -> SynthesisDraft (untrusted: text + assertions that cite server-issued source ids only)
//!   -> validate::validate_draft     deterministic vetoes, BEFORE any verifier is asked
//!   -> RevisionVerifier (async, a DIFFERENT model family)  -> PASS | VETO | UNAVAILABLE
//!   -> only PASS yields a `RevisionDraft` for the existing atomic, compare-and-set commit (Phase 3)
//! ```
//! Neither stage can create a revision, pick or change the target, decide identity, or name a database id or a capture span: sources
//! are `base`, `s1..sN` (the target's active evidence, quoted from the stored captures by the SERVER) and `new` (the claim's exact
//! words). Evidence rows are written from those server-resolved spans by the Phase 2 storage, never from anything a model returned.
//!
//! Any failure (no authorization, provider error, malformed or vetoed draft, unavailable verifier) routes the claim to a pending claim
//! (`evolution::stage_or_fall_back`). A verifier can only BLOCK an already eligible proposal; it never promotes anything.
//!
//! Not activated: the stage is injected by tests only (`DistillationService::with_evolution` is `#[cfg(test)]`), no command or UI
//! reaches it, and the real independent verifier is a disabled boundary (`verifier::UnconfiguredVerifier`) because Arthur has no safely
//! configurable second model family for this purpose yet. Specification: `docs/architecture/m047b-phase4b-grounded-revision-synthesis.md`.

pub mod authorization;
pub mod disclosure;
pub mod openai;
pub mod openai_verifier;
pub mod prompt;
pub mod stage;
pub mod validate;
pub mod verdict;
pub mod verifier;

#[cfg(test)]
mod architecture_tests;
#[cfg(test)]
mod eval;
#[cfg(test)]
pub mod fake;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_4c;
#[cfg(test)]
mod tests_p5;

use crate::async_util::BoxFuture;

/// Which model produced or judged something. `family` is what independence is decided on: two differently named models of ONE family
/// (for example two GPT models) are NOT independent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelIdentity {
    pub provider: &'static str,
    pub family: &'static str,
    pub model: String,
}

/// What kind of check a verifier gives. `Independent`: a different model family from the synthesizer. `SameFamilyReview`: the same family
/// reviewing its own family's draft (for example GPT-6 Luna checking GPT-6 Luna). A same-family pass is a self-check, not independent
/// confirmation, and the stage never lets one apply a revision by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerificationMode {
    Independent,
    SameFamilyReview,
}

/// How the new claim relates to the target, as the resolver authorized it. The draft must classify its own change the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeClass {
    Additive,
    Correction,
    Replacement,
}

impl ChangeClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeClass::Additive => "additive",
            ChangeClass::Correction => "correction",
            ChangeClass::Replacement => "replacement",
        }
    }
    pub fn parse(raw: &str) -> Option<Self> {
        [Self::Additive, Self::Correction, Self::Replacement]
            .into_iter()
            .find(|c| c.as_str() == raw)
    }
}

/// The id of the target's current text.
pub const BASE_SOURCE: &str = "base";
/// The id of the new claim's exact words.
pub const NEW_SOURCE: &str = "new";

/// One quotation the server resolved from a stored capture. `key` (server-only, never sent to a model) names the stored evidence row
/// the quote came from, so a withdrawn assertion can be traced to exactly that row; `None` for the original span of an initial revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRef {
    pub id: String,
    pub quote: String,
    pub capture_id: String,
    pub start: i64,
    pub end: i64,
    pub key: Option<(String, i64)>,
}

/// Everything a synthesizer or verifier may see. Owned, bounded, built from validated server state only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthesisRequest {
    pub kind: String,
    pub title: String,
    pub base_body: String,
    pub change: ChangeClass,
    pub sources: Vec<SourceRef>,
    pub claim_title: String,
    pub claim_body: String,
    pub claim_quote: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assertion {
    pub text: String,
    /// `base`, `sN` or `new`: resolved against `SynthesisRequest::sources` before anything is believed.
    pub source: String,
}

/// A proposed revision. UNTRUSTED until `validate::validate_draft` and the verifier have both accepted it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SynthesisDraft {
    pub kind: String,
    pub revised_body: String,
    pub change: ChangeClass,
    pub retained: Vec<Assertion>,
    pub added: Vec<Assertion>,
    pub withdrawn: Vec<Assertion>,
    /// The model that answered, as the provider reported it.
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SynthesisFailure {
    /// Not configured, not authorized, or not reachable.
    Unavailable,
    Timeout,
    Network,
    Auth,
    Refused,
    Unreadable(&'static str),
    ModelMismatch,
    InputTooLarge,
    Cancelled,
}

pub trait RevisionSynthesizer: Send + Sync {
    fn identity(&self) -> ModelIdentity;
    /// Proposes a revision. It is told nothing it could use to pick another object and returns text and assertions only.
    fn synthesize<'a>(
        &'a self,
        request: &'a SynthesisRequest,
    ) -> BoxFuture<'a, Result<SynthesisDraft, SynthesisFailure>>;
}

/// Why a verifier refuses a proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VetoReason {
    UnfaithfulToPrevious,
    UnfaithfulToClaim,
    EvidenceNotCovered,
    UnsupportedAssertion,
    RemovedExistingFact,
    Contradiction,
    QualifierOrNegationChanged,
    ScopeChanged,
    CertaintyIncreased,
    UnsupportedDateQuantityOrEntity,
    WrongCorrectionBehaviour,
    AmbiguousReference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableReason {
    NotConfigured,
    NotAuthorized,
    Provider,
    /// The provider answered, but not with a well-formed, self-consistent verdict. Never read as a pass.
    InvalidResponse,
    Timeout,
    Cancelled,
}

/// The verifier's whole vocabulary. There is deliberately no way to say "revise this object" or to alter the draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Veto(Vec<VetoReason>),
    Unavailable(UnavailableReason),
}

/// What the verifier is shown: the same server-owned request plus the proposal, so it can judge faithfulness both ways.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyRequest {
    pub request: SynthesisRequest,
    pub draft: SynthesisDraft,
}

pub trait RevisionVerifier: Send + Sync {
    fn identity(&self) -> ModelIdentity;
    /// `false` when no check can currently be made (not configured): the stage then does not even ask the synthesizer, so nothing is
    /// sent anywhere for a draft that could never be verified.
    fn available(&self) -> bool {
        true
    }
    fn verify<'a>(&'a self, request: &'a VerifyRequest) -> BoxFuture<'a, Verdict>;
}
