//! The veto-only verifier boundary and the family-independence rule.
//!
//! WHAT IS AVAILABLE: the shipped verifier is `OpenAiRevisionVerifier` (GPT-6 Luna). The synthesizer is also GPT-6 Luna, so that pairing is
//! `VerificationMode::SameFamilyReview`, NOT independent, and the stage holds even a passing draft for a person's approval. An independent
//! verifier (another model family) can replace it later without changing the pipeline: `SynthesisStage::new` accepts only a verifier whose
//! family differs and then runs as `Independent`. The two modes are never mixed up: each constructor refuses the other's pairing.
//! `UnconfiguredVerifier` is the disabled boundary: always `Unavailable`, sends nothing.

use super::{
    ModelIdentity, RevisionSynthesizer, RevisionVerifier, UnavailableReason, Verdict, VerifyRequest,
};
use crate::async_util::BoxFuture;

/// The disabled real boundary: reports itself unconfigured on every call and sends nothing anywhere.
pub struct UnconfiguredVerifier;

impl RevisionVerifier for UnconfiguredVerifier {
    fn identity(&self) -> ModelIdentity {
        ModelIdentity {
            provider: "none",
            family: "none",
            model: "unconfigured".into(),
        }
    }

    fn available(&self) -> bool {
        false
    }

    fn verify<'a>(&'a self, _: &'a VerifyRequest) -> BoxFuture<'a, Verdict> {
        Box::pin(async { Verdict::Unavailable(UnavailableReason::NotConfigured) })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageError {
    /// The verifier belongs to the synthesizer's model family: it is not an independent check.
    NotIndependent,
    /// A same-family review was requested for a verifier of a different family (the mode would misdescribe the pairing).
    NotSameFamily,
}

/// Independence is decided on the model FAMILY, never on the name.
pub fn ensure_independent(
    synthesizer: &dyn RevisionSynthesizer,
    verifier: &dyn RevisionVerifier,
) -> Result<(), StageError> {
    let (a, b) = (synthesizer.identity(), verifier.identity());
    if a.family == b.family {
        return Err(StageError::NotIndependent);
    }
    Ok(())
}

/// Same-family review is only constructible when the families really are the same, so it can never be used to label an independent pairing
/// (or the reverse) wrongly.
pub fn ensure_same_family(
    synthesizer: &dyn RevisionSynthesizer,
    verifier: &dyn RevisionVerifier,
) -> Result<(), StageError> {
    if synthesizer.identity().family != verifier.identity().family {
        return Err(StageError::NotSameFamily);
    }
    Ok(())
}
