//! The synthesis stage as the pipeline runs it: authorizations, then synthesis, deterministic validation, independent verification,
//! with the enabled/consent state re-read around every wait. It returns either a validated draft or the name of the veto that sends
//! the claim to a person. It has no database access and no way to create a revision.

use std::sync::Arc;

use super::authorization::ProviderAuthorization;
use super::validate::{validate_draft, ValidatedDraft};
use super::verifier::{ensure_independent, ensure_same_family, StageError};
use super::{RevisionSynthesizer, RevisionVerifier, SynthesisRequest, VerificationMode, Verdict, VerifyRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageLimits {
    /// Synthesis requests one capture may make, across its claims.
    pub max_drafts_per_capture: usize,
    pub max_verifications_per_capture: usize,
}

impl Default for StageLimits {
    fn default() -> Self {
        Self { max_drafts_per_capture: 4, max_verifications_per_capture: 4 }
    }
}

/// What one capture has spent so far.
#[derive(Debug, Default)]
pub struct StageBudget {
    drafts: usize,
    verifications: usize,
}

pub struct SynthesisStage {
    synthesizer: Arc<dyn RevisionSynthesizer>,
    verifier: Arc<dyn RevisionVerifier>,
    synthesis_authorization: Arc<ProviderAuthorization>,
    verification_authorization: Arc<ProviderAuthorization>,
    expected_model_prefix: String,
    limits: StageLimits,
    mode: VerificationMode,
}

impl SynthesisStage {
    /// Independent mode: refuses a verifier of the synthesizer's own model family, since an independent check is the whole point.
    pub fn new(
        synthesizer: Arc<dyn RevisionSynthesizer>,
        verifier: Arc<dyn RevisionVerifier>,
        synthesis_authorization: Arc<ProviderAuthorization>,
        verification_authorization: Arc<ProviderAuthorization>,
        limits: StageLimits,
    ) -> Result<Self, StageError> {
        ensure_independent(synthesizer.as_ref(), verifier.as_ref())?;
        Ok(Self::build(synthesizer, verifier, synthesis_authorization, verification_authorization, limits, VerificationMode::Independent))
    }

    /// A verifier of the SAME family as the synthesizer (GPT-6 Luna reviewing GPT-6 Luna). This is a self-check, not independent
    /// verification: a pass never applies a revision by itself, it holds the claim for a person's approval (`review_required`).
    pub fn new_same_family_review(
        synthesizer: Arc<dyn RevisionSynthesizer>,
        verifier: Arc<dyn RevisionVerifier>,
        synthesis_authorization: Arc<ProviderAuthorization>,
        verification_authorization: Arc<ProviderAuthorization>,
        limits: StageLimits,
    ) -> Result<Self, StageError> {
        ensure_same_family(synthesizer.as_ref(), verifier.as_ref())?;
        Ok(Self::build(synthesizer, verifier, synthesis_authorization, verification_authorization, limits, VerificationMode::SameFamilyReview))
    }

    fn build(
        synthesizer: Arc<dyn RevisionSynthesizer>,
        verifier: Arc<dyn RevisionVerifier>,
        synthesis_authorization: Arc<ProviderAuthorization>,
        verification_authorization: Arc<ProviderAuthorization>,
        limits: StageLimits,
        mode: VerificationMode,
    ) -> Self {
        let expected_model_prefix = synthesizer.identity().model;
        Self { synthesizer, verifier, synthesis_authorization, verification_authorization, expected_model_prefix, limits, mode }
    }

    pub fn mode(&self) -> VerificationMode {
        self.mode
    }

    /// Both provider authorizations hold right now.
    pub fn authorized(&self) -> bool {
        self.synthesis_authorization.granted() && self.verification_authorization.granted()
    }

    /// `Err(name)`: do not revise; keep the claim for a person, recording this allow-listed veto name.
    pub async fn run(&self, request: &SynthesisRequest, allowed: &(dyn Fn() -> bool + Sync), budget: &mut StageBudget) -> Result<ValidatedDraft, &'static str> {
        if !allowed() {
            return Err("evolution_withdrawn");
        }
        // both permissions up front: nothing is sent to the synthesizer if the verifier could not be asked afterwards
        if !self.synthesis_authorization.granted() || budget.drafts >= self.limits.max_drafts_per_capture {
            return Err("synthesis_unavailable");
        }
        if !self.verifier.available() || !self.verification_authorization.granted() || budget.verifications >= self.limits.max_verifications_per_capture {
            return Err("verifier_unavailable");
        }
        budget.drafts += 1;
        let draft = self.synthesizer.synthesize(request).await.map_err(|_| "synthesis_unavailable")?;
        // read again after the wait: a permission withdrawn while the model worked discards the draft
        if !allowed() || !self.authorized() {
            return Err("evolution_withdrawn");
        }
        let validated = validate_draft(request, &draft, &self.expected_model_prefix).map_err(|veto| veto.storage_name())?;
        if !self.verification_authorization.granted() {
            return Err("verifier_unavailable");
        }
        budget.verifications += 1;
        let verdict = self.verifier.verify(&VerifyRequest { request: request.clone(), draft }).await;
        if !allowed() || !self.authorized() {
            return Err("evolution_withdrawn");
        }
        match verdict {
            // a same-family pass is a self-check: the draft is worth showing to a person, never worth applying on its own
            Verdict::Pass if self.mode == VerificationMode::SameFamilyReview => Err("review_required"),
            Verdict::Pass => Ok(validated),
            Verdict::Veto(_) => Err("verifier_veto"),
            Verdict::Unavailable(_) => Err("verifier_unavailable"),
        }
    }
}
