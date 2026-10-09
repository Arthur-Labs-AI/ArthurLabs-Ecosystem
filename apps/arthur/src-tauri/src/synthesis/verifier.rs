//! The independent veto-only verifier boundary.
//!
//! WHAT IS AVAILABLE: Arthur has exactly two model providers wired for text, OpenAI (everything else) and TypeSafe JEV (identity
//! classification only, under its own consent). The synthesizer is OpenAI `gpt-6-luna`, so an OpenAI verifier would NOT be
//! independent (different model names, one family), and silently reusing the synthesizer is refused. A JEV-backed verifier would be a
//! different family, but it would need new, unbenchmarked questions and its own verification authorization and disclosure, so it is not
//! invented here. The real adapter is therefore `UnconfiguredVerifier`: always `Unavailable`, so an automatic revision can never pass
//! through it. `SynthesisStage::new` additionally refuses any verifier whose family equals the synthesizer's.

use super::{ModelIdentity, RevisionSynthesizer, RevisionVerifier, UnavailableReason, Verdict, VerifyRequest};
use crate::async_util::BoxFuture;

/// The disabled real boundary: reports itself unconfigured on every call and sends nothing anywhere.
pub struct UnconfiguredVerifier;

impl RevisionVerifier for UnconfiguredVerifier {
    fn identity(&self) -> ModelIdentity {
        ModelIdentity { provider: "none", family: "none", model: "unconfigured".into() }
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
}

/// Independence is decided on the model FAMILY, never on the name.
pub fn ensure_independent(synthesizer: &dyn RevisionSynthesizer, verifier: &dyn RevisionVerifier) -> Result<(), StageError> {
    let (a, b) = (synthesizer.identity(), verifier.identity());
    if a.family == b.family {
        return Err(StageError::NotIndependent);
    }
    Ok(())
}
