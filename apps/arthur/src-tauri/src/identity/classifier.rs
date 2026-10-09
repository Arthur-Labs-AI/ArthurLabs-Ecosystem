//! The provider boundary of the identity core: a trait with no implementation here. Phase 2 may adapt a live classifier (JEV or other)
//! behind it; tests use `fake`. Synchronous on purpose: the pure core never awaits. An async adapter runs the call first and hands the
//! finished `ClassifierOutput` (or failure) to the core.

use super::types::{CandidateSignal, Candidate, Claim};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClassifierFailure {
    Timeout,
    Network,
    Refused,
    Unavailable,
    Unreadable,
}

/// What the classifier is shown. Only claim text and the already-filtered candidates (same project, unarchived) are included.
pub struct ClassifyRequest<'a> {
    pub claim: &'a Claim,
    pub candidates: &'a [Candidate],
}

/// `runs` are repeated samples of ONE model (for example with shuffled candidate order); the core requires unanimity across them.
/// Repetition reduces sampling noise only. It is NOT independent verification: the samples share the model's biases.
#[derive(Debug, Clone, PartialEq)]
pub struct ClassifierOutput {
    pub model_id: String,
    pub runs: Vec<Vec<CandidateSignal>>,
}

pub trait IdentityClassifier {
    fn classify(&self, request: &ClassifyRequest<'_>) -> Result<ClassifierOutput, ClassifierFailure>;
}
