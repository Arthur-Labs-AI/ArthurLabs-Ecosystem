//! The JEV identity provider: consent and credential gates, three shuffled-order runs per claim, per-capture budget, typed failures.
//!
//! It implements `AsyncIdentityClassifier`, the narrow async boundary in `distillation::evolution`. That pipeline fetches every
//! claim's result here FIRST (no database lock held), then hands the finished results to the unchanged synchronous resolver through
//! `Prefetched`. So no runtime is nested, nothing blocks while a request is in flight, and the deterministic gates never see HTTP.
//!
//! Gates, checked before any request and again between runs: Automatic Thought Evolution ON, TypeSafe consent for the current
//! disclosure, a TypeSafe credential. An API key alone is never consent. The pipeline additionally re-checks `still_allowed` after the
//! wait and once more inside the commit transaction.

use std::sync::Arc;

use super::client::{Budget, Diagnostics, JevClient};
use super::consent::JevConsent;
use super::protocol::{build_run, parse_run, Mapping};
use super::{JevError, JEV_MODEL};
use crate::async_util::BoxFuture;
use crate::distillation::evolution::{AsyncIdentityClassifier, EvolutionSettings};
use crate::identity::{Candidate, ClassifierFailure, ClassifierOutput, Claim, ResolverPolicy};
use crate::providers::credentials::{ApiKey, CredentialSource};
use crate::providers::registry::ProviderId;
use crate::providers::secrets::SecretStore;

/// The TypeSafe credential slot, read from the shared secret store on every request and never cached. It is `ProviderId::TypeSafe`
/// only: another provider's key is never used, and nothing outside native code can read it back.
pub struct TypeSafeCredential {
    store: Arc<dyn SecretStore>,
}

impl TypeSafeCredential {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }
}

impl CredentialSource for TypeSafeCredential {
    fn api_key(&self) -> Option<ApiKey> {
        self.store.get(ProviderId::TypeSafe)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JevLimits {
    /// Independent readings per claim. All must agree (the resolver requires unanimity); not independent verification.
    pub runs: usize,
    /// Requests one capture may spend, retries included.
    pub max_requests_per_capture: u64,
}

impl Default for JevLimits {
    fn default() -> Self {
        Self { runs: 3, max_requests_per_capture: 24 }
    }
}

pub struct JevIdentityProvider {
    client: JevClient,
    credential: Arc<dyn CredentialSource>,
    consent: Arc<JevConsent>,
    settings: Arc<EvolutionSettings>,
    mapping: Mapping,
    limits: JevLimits,
}

impl std::fmt::Debug for JevIdentityProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JevIdentityProvider(<redacted>)")
    }
}

/// The resolver policy that accepts exactly the pinned model. Thresholds are the unvalidated placeholders of `ResolverPolicy::default`;
/// they are NOT production-calibrated (see the module docs of `jev`).
pub fn resolver_policy() -> ResolverPolicy {
    ResolverPolicy { accepted_models: vec![JEV_MODEL.to_string()], ..ResolverPolicy::default() }
}

impl JevIdentityProvider {
    pub fn new(client: JevClient, credential: Arc<dyn CredentialSource>, consent: Arc<JevConsent>, settings: Arc<EvolutionSettings>) -> Self {
        Self { client, credential, consent, settings, mapping: Mapping::default(), limits: JevLimits::default() }
    }

    pub fn with_limits(mut self, limits: JevLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn diagnostics(&self) -> Diagnostics {
        self.client.diagnostics()
    }

    pub fn cancel(&self) {
        self.client.cancel();
    }

    /// Evolution switched on AND consent for the current disclosure. Cheap and lock-free: safe to call inside a database transaction.
    pub fn still_allowed(&self) -> bool {
        self.settings.enabled() && self.consent.granted()
    }

    /// The closure the pipeline re-checks before and after the wait and inside the commit.
    pub fn gate(self: &Arc<Self>) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let provider = self.clone();
        Arc::new(move || provider.still_allowed())
    }

    fn preflight(&self) -> Result<ApiKey, JevError> {
        if !self.settings.enabled() {
            return Err(JevError::Disabled);
        }
        if !self.consent.granted() {
            return Err(JevError::NoConsent);
        }
        self.credential.api_key().ok_or(JevError::NoCredential)
    }

    async fn classify_one(&self, key: &ApiKey, claim: &Claim, candidates: &[Candidate], budget: &Budget) -> Result<ClassifierOutput, JevError> {
        let ids: Vec<String> = candidates.iter().map(|c| c.object_id.clone()).collect();
        let mut runs = Vec::with_capacity(self.limits.runs);
        for run in 0..self.limits.runs {
            // revoked or switched off between runs: stop now, send nothing more
            if !self.still_allowed() {
                return Err(if self.settings.enabled() { JevError::NoConsent } else { JevError::Disabled });
            }
            let plan = build_run(claim, candidates, run)?;
            let text = self.client.send(key, &plan.body, budget).await?;
            let parsed = match parse_run(&plan, &ids, &text, &self.mapping) {
                Ok(parsed) => parsed,
                Err(error) => {
                    self.client.meter().fail(error.code());
                    return Err(error);
                }
            };
            let estimated = (plan.body.chars().count() as u64).div_ceil(4);
            self.client.meter().usage(parsed.usage.map(|u| u.input_tokens), parsed.usage.map(|u| u.output_tokens), estimated);
            runs.push(parsed.signals);
        }
        Ok(ClassifierOutput { model_id: JEV_MODEL.to_string(), runs })
    }
}

impl AsyncIdentityClassifier for JevIdentityProvider {
    fn classify_capture<'a>(&'a self, items: &'a [(Claim, Vec<Candidate>)]) -> BoxFuture<'a, Vec<Result<ClassifierOutput, ClassifierFailure>>> {
        Box::pin(async move {
            // one gate for the whole capture: nothing is sent unless every precondition holds
            let key = match self.preflight() {
                Ok(key) => key,
                Err(error) => {
                    self.client.meter().fail(error.code());
                    return items.iter().map(|_| Err(error.to_classifier_failure())).collect();
                }
            };
            let budget = Budget::new(self.limits.max_requests_per_capture);
            let mut results = Vec::with_capacity(items.len());
            // A failure that will repeat for the next claim (bad key, exhausted retries, budget, cancel, withdrawn permission) stops the
            // capture: the remaining claims are not sent, so a struggling provider is never hammered.
            let mut stopped: Option<JevError> = None;
            for (claim, candidates) in items {
                if let Some(error) = stopped {
                    results.push(Err(error.to_classifier_failure()));
                    continue;
                }
                let result = if candidates.is_empty() { Err(JevError::Malformed("no candidates")) } else { self.classify_one(&key, claim, candidates, &budget).await };
                if let Err(error) = &result {
                    if matches!(error, JevError::Auth | JevError::RetriesExhausted(_) | JevError::BudgetExceeded | JevError::Cancelled | JevError::Disabled | JevError::NoConsent | JevError::RateLimited | JevError::Overloaded) {
                        stopped = Some(*error);
                    }
                }
                results.push(result.map_err(|error| error.to_classifier_failure()));
            }
            results
        })
    }
}
