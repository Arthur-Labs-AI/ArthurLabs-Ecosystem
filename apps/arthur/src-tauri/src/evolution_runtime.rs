//! The production composition of Automatic Thought Evolution (M04.7B Phase 5): REVIEW-FIRST, and nothing else.
//!
//! ```text
//! identity     TypeSafe JEV 1.13        (own consent, own native credential slot)
//! synthesis    OpenAI GPT-6 Luna        (own authorization; the person's OpenAI key)
//! verification OpenAI GPT-6 Luna        (own authorization; SameFamilyReview: a self-check, never independent)
//! deterministic IdentityResolver + draft validation + compare-and-set
//! authority    the person: a draft is stored as a PROPOSAL and applied only by their approval
//! ```
//! This is the only place that builds the pipeline for the app. It builds it with `SynthesisStage::new_same_family_review`, so a passing
//! draft is never applied by the pipeline (`EvolutionPipeline::review_first`); the hand-written drafter is replaced by one that always
//! declines; the feature stays OFF until a person switches it on, and it can only be switched on when every consent and credential it
//! needs exists. Revoking any of them stops new provider work at once and stops an operation in flight from applying its result.
//!
//! Nothing here reads a key back out to the UI: the status carries booleans, never a secret.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::distillation::evolution::{DraftFailure, DraftRequest, EvolutionLimits, EvolutionPipeline, EvolutionSettings, ClassifierBackend, RevisionDraft, RevisionDrafter};
use crate::jev::{self, JevClient, JevConsent, JevIdentityProvider, ReqwestTransport, RetryPolicy};
use crate::providers::credentials::{ApiKey, CredentialSource};
use crate::providers::registry::ProviderId;
use crate::providers::secrets::SecretStore;
use crate::synthesis::authorization::{ProviderAuthorization, Purpose};
use crate::synthesis::disclosure::{SYNTHESIS_DISCLOSURE, SYNTHESIS_DISCLOSURE_VERSION, VERIFICATION_DISCLOSURE, VERIFICATION_DISCLOSURE_VERSION};
use crate::synthesis::openai::OpenAiRevisionSynthesizer;
use crate::synthesis::openai_verifier::OpenAiRevisionVerifier;
use crate::synthesis::stage::{StageLimits, SynthesisStage};

/// The one supported mode. There is no automatic-apply mode to select.
pub const MODE: &str = "review_first";

/// Requests TypeSafe may be sent per day across all captures (a hard stop on top of the per-capture budget).
const JEV_DAILY_REQUESTS: u64 = 600;
const JEV_TIMEOUT: Duration = Duration::from_secs(20);
const SYNTHESIS_TIMEOUT: Duration = Duration::from_secs(60);
const VERIFICATION_TIMEOUT: Duration = Duration::from_secs(30);

/// There is no hand-written drafting in production: revision text comes only from synthesis, validation and review.
struct NoHandwrittenDrafts;

impl RevisionDrafter for NoHandwrittenDrafts {
    fn draft(&self, _: &DraftRequest<'_>) -> Result<RevisionDraft, DraftFailure> {
        Err(DraftFailure::Unavailable)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentKind {
    Typesafe,
    Synthesis,
    Verification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// The provider's name as it is shown to the person (the UI never hard-codes one).
    pub provider: &'static str,
    pub consented: bool,
    pub has_credential: bool,
    pub disclosure_version: String,
    pub disclosure: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvolutionStatus {
    /// The saved switch. OFF until a person turns it on.
    pub enabled: bool,
    /// Always `review_first`: a suggestion is never applied without the person's approval.
    pub mode: &'static str,
    /// Everything it needs exists right now.
    pub ready: bool,
    /// Switched on AND ready: new suggestions can be produced.
    pub active: bool,
    /// What is missing, as stable codes: `typesafe_consent`, `typesafe_credential`, `llm_credential`, `synthesis_authorization`, `verification_authorization`.
    pub blockers: Vec<&'static str>,
    pub typesafe: ProviderStatus,
    pub synthesis: ProviderStatus,
    pub verification: ProviderStatus,
    /// The verification is the same model family as the suggestion (a self-check). Always true in this build.
    pub same_family_verification: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeError {
    pub code: &'static str,
    pub message: String,
}

impl RuntimeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// Every handle the settings screen needs, and nothing that can send anything.
pub struct EvolutionRuntime {
    settings: Arc<EvolutionSettings>,
    consent: Arc<JevConsent>,
    synthesis_authorization: Arc<ProviderAuthorization>,
    verification_authorization: Arc<ProviderAuthorization>,
    secrets: Arc<dyn SecretStore>,
    llm: Arc<dyn CredentialSource>,
}

pub struct Built {
    pub runtime: EvolutionRuntime,
    pub pipeline: EvolutionPipeline,
}

/// Builds the review-first pipeline and the runtime that controls it from the same shared handles.
pub fn build(dir: &Path, secrets: Arc<dyn SecretStore>, llm: Arc<dyn CredentialSource>) -> Result<Built, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let settings = Arc::new(EvolutionSettings::new(dir.join("settings.json")));
    let consent = Arc::new(JevConsent::new(dir.join("typesafe-consent.json")));
    let synthesis_authorization = Arc::new(ProviderAuthorization::new(dir.join("openai-synthesis.json"), "openai", Purpose::Synthesis, SYNTHESIS_DISCLOSURE_VERSION));
    let verification_authorization = Arc::new(ProviderAuthorization::new(dir.join("openai-verification.json"), "openai", Purpose::Verification, VERIFICATION_DISCLOSURE_VERSION));

    let transport = ReqwestTransport::production().map_err(|e| e.to_string())?;
    let client = JevClient::new(Arc::new(transport), RetryPolicy::default(), JEV_TIMEOUT, 2, JEV_DAILY_REQUESTS);
    let identity = Arc::new(JevIdentityProvider::new(client, Arc::new(jev::provider::TypeSafeCredential::new(secrets.clone())), consent.clone(), settings.clone()));

    let synthesizer = Arc::new(OpenAiRevisionSynthesizer::new(llm.clone(), synthesis_authorization.clone(), SYNTHESIS_TIMEOUT).map_err(|e| e.to_string())?);
    let verifier = Arc::new(OpenAiRevisionVerifier::new(llm.clone(), verification_authorization.clone(), VERIFICATION_TIMEOUT).map_err(|e| e.to_string())?);
    // GPT-6 Luna reviewing GPT-6 Luna: the stage records `SameFamilyReview` and can never apply a revision on its own.
    let stage = SynthesisStage::new_same_family_review(synthesizer, verifier, synthesis_authorization.clone(), verification_authorization.clone(), StageLimits::default()).map_err(|e| format!("{e:?}"))?;

    let pipeline = EvolutionPipeline {
        settings: settings.clone(),
        classifier: ClassifierBackend::Async(identity.clone()),
        still_allowed: Some(identity.gate()),
        drafter: Arc::new(NoHandwrittenDrafts),
        synthesis: Some(stage),
        policy: jev::resolver_policy(),
        limits: EvolutionLimits::default(),
    };
    debug_assert!(pipeline.review_first());
    Ok(Built { runtime: EvolutionRuntime { settings, consent, synthesis_authorization, verification_authorization, secrets, llm }, pipeline })
}

impl EvolutionRuntime {
    fn blockers(&self) -> Vec<&'static str> {
        let mut blockers = Vec::new();
        if !self.consent.granted() {
            blockers.push("typesafe_consent");
        }
        if !self.secrets.has(ProviderId::TypeSafe) {
            blockers.push("typesafe_credential");
        }
        if self.llm.api_key().is_none() {
            blockers.push("llm_credential");
        }
        if !self.synthesis_authorization.granted() {
            blockers.push("synthesis_authorization");
        }
        if !self.verification_authorization.granted() {
            blockers.push("verification_authorization");
        }
        blockers
    }

    pub fn status(&self) -> EvolutionStatus {
        let blockers = self.blockers();
        let ready = blockers.is_empty();
        let enabled = self.settings.enabled();
        let openai = self.llm.api_key().is_some();
        EvolutionStatus {
            enabled,
            mode: MODE,
            ready,
            active: enabled && ready,
            blockers,
            typesafe: ProviderStatus {
                provider: "TypeSafe",
                consented: self.consent.granted(),
                has_credential: self.secrets.has(ProviderId::TypeSafe),
                disclosure_version: jev::DISCLOSURE_VERSION.into(),
                disclosure: jev::DISCLOSURE_POINTS.iter().map(|s| s.to_string()).collect(),
            },
            synthesis: ProviderStatus {
                provider: "OpenAI",
                consented: self.synthesis_authorization.granted(),
                has_credential: openai,
                disclosure_version: SYNTHESIS_DISCLOSURE_VERSION.into(),
                disclosure: SYNTHESIS_DISCLOSURE.iter().map(|s| s.to_string()).collect(),
            },
            verification: ProviderStatus {
                provider: "OpenAI",
                consented: self.verification_authorization.granted(),
                has_credential: openai,
                disclosure_version: VERIFICATION_DISCLOSURE_VERSION.into(),
                disclosure: VERIFICATION_DISCLOSURE.iter().map(|s| s.to_string()).collect(),
            },
            same_family_verification: true,
        }
    }

    /// Switching ON needs every consent and credential; switching OFF always works and takes effect for the very next provider request.
    pub fn set_enabled(&self, enabled: bool) -> Result<EvolutionStatus, RuntimeError> {
        if enabled {
            let blockers = self.blockers();
            if !blockers.is_empty() {
                return Err(RuntimeError::new("not_ready", format!("Automatic Thought Evolution needs: {}.", blockers.join(", "))));
            }
        }
        self.settings.set(enabled).map_err(|_| RuntimeError::new("settings_not_saved", "The setting could not be saved."))?;
        Ok(self.status())
    }

    /// Records one explicit decision. Granting must name the disclosure version the person was shown; revoking needs no version.
    pub fn set_consent(&self, kind: ConsentKind, granted: bool, disclosure_version: Option<&str>) -> Result<EvolutionStatus, RuntimeError> {
        let current = match kind {
            ConsentKind::Typesafe => jev::DISCLOSURE_VERSION,
            ConsentKind::Synthesis => SYNTHESIS_DISCLOSURE_VERSION,
            ConsentKind::Verification => VERIFICATION_DISCLOSURE_VERSION,
        };
        if granted && disclosure_version != Some(current) {
            return Err(RuntimeError::new("disclosure_outdated", "The explanation you saw has changed. Read it again before agreeing."));
        }
        let saved = match (kind, granted) {
            (ConsentKind::Typesafe, true) => self.consent.grant(),
            (ConsentKind::Typesafe, false) => self.consent.revoke(),
            (ConsentKind::Synthesis, true) => self.synthesis_authorization.grant(),
            (ConsentKind::Synthesis, false) => self.synthesis_authorization.revoke(),
            (ConsentKind::Verification, true) => self.verification_authorization.grant(),
            (ConsentKind::Verification, false) => self.verification_authorization.revoke(),
        };
        saved.map_err(|_| RuntimeError::new("consent_not_saved", "Your choice could not be saved, so nothing changed."))?;
        Ok(self.status())
    }

    /// Write-only. The key goes straight into the native credential store under the dedicated TypeSafe slot and is never returned.
    pub fn set_typesafe_credential(&self, secret: &str) -> Result<EvolutionStatus, RuntimeError> {
        let key = ApiKey::parse(secret).ok_or_else(|| RuntimeError::new("invalid_credential", "That does not look like an API key."))?;
        self.secrets.set(ProviderId::TypeSafe, &key).map_err(|_| RuntimeError::new("credential_not_saved", "The key could not be saved securely on this device."))?;
        Ok(self.status())
    }

    pub fn delete_typesafe_credential(&self) -> Result<EvolutionStatus, RuntimeError> {
        self.secrets.delete(ProviderId::TypeSafe).map_err(|_| RuntimeError::new("credential_not_removed", "The key could not be removed."))?;
        Ok(self.status())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;
    use crate::providers::secrets::SecretError;

    #[derive(Default)]
    struct Memory(Mutex<HashMap<&'static str, String>>);

    impl SecretStore for Memory {
        fn set(&self, provider: ProviderId, key: &ApiKey) -> Result<(), SecretError> {
            self.0.lock().unwrap().insert(provider.as_str(), key.expose().to_string());
            Ok(())
        }
        fn has(&self, provider: ProviderId) -> bool {
            self.0.lock().unwrap().contains_key(provider.as_str())
        }
        fn delete(&self, provider: ProviderId) -> Result<(), SecretError> {
            self.0.lock().unwrap().remove(provider.as_str());
            Ok(())
        }
        fn get(&self, provider: ProviderId) -> Option<ApiKey> {
            self.0.lock().unwrap().get(provider.as_str()).and_then(|raw| ApiKey::parse(raw))
        }
    }

    /// The OpenAI credential, as the app resolves it per request.
    struct Llm(Arc<Memory>);
    impl CredentialSource for Llm {
        fn api_key(&self) -> Option<ApiKey> {
            self.0.get(ProviderId::OpenAi)
        }
    }

    const TYPESAFE_SECRET: &str = "ts-SECRET-must-never-be-echoed-9f2";
    const OPENAI_SECRET: &str = "sk-OPENAI-SECRET-must-never-be-echoed-41";

    fn rig(dir: &Path) -> (Built, Arc<Memory>) {
        let secrets = Arc::new(Memory::default());
        let built = build(dir, secrets.clone(), Arc::new(Llm(secrets.clone()))).unwrap();
        (built, secrets)
    }

    fn grant_everything(runtime: &EvolutionRuntime, secrets: &Memory) {
        secrets.set(ProviderId::OpenAi, &ApiKey::parse(OPENAI_SECRET).unwrap()).unwrap();
        runtime.set_typesafe_credential(TYPESAFE_SECRET).unwrap();
        runtime.set_consent(ConsentKind::Typesafe, true, Some(jev::DISCLOSURE_VERSION)).unwrap();
        runtime.set_consent(ConsentKind::Synthesis, true, Some(SYNTHESIS_DISCLOSURE_VERSION)).unwrap();
        runtime.set_consent(ConsentKind::Verification, true, Some(VERIFICATION_DISCLOSURE_VERSION)).unwrap();
    }

    #[test]
    fn a_fresh_install_is_off_review_first_and_missing_everything() {
        let dir = tempfile::tempdir().unwrap();
        let (built, _) = rig(dir.path());
        let status = built.runtime.status();
        assert!(!status.enabled && !status.ready && !status.active);
        assert_eq!(status.mode, "review_first");
        assert_eq!(status.blockers, vec!["typesafe_consent", "typesafe_credential", "llm_credential", "synthesis_authorization", "verification_authorization"]);
        assert!(status.same_family_verification);
        assert!(built.pipeline.review_first() && !built.pipeline.enabled(), "installed, review-first, and OFF");
    }

    #[test]
    fn switching_on_needs_every_consent_and_credential_and_off_always_works() {
        let dir = tempfile::tempdir().unwrap();
        let (built, secrets) = rig(dir.path());
        let runtime = &built.runtime;
        assert_eq!(runtime.set_enabled(true).unwrap_err().code, "not_ready");
        assert!(!runtime.status().enabled, "a refused switch changes nothing");
        grant_everything(runtime, &secrets);
        let on = runtime.set_enabled(true).unwrap();
        assert!(on.enabled && on.ready && on.active && on.blockers.is_empty());
        assert!(built.pipeline.enabled());
        // revoking any single permission stops new provider work AT ONCE, without the switch being touched
        for (kind, version) in [(ConsentKind::Typesafe, jev::DISCLOSURE_VERSION), (ConsentKind::Synthesis, SYNTHESIS_DISCLOSURE_VERSION), (ConsentKind::Verification, VERIFICATION_DISCLOSURE_VERSION)] {
            let off = runtime.set_consent(kind, false, None).unwrap();
            assert!(off.enabled && !off.active && !off.ready, "{kind:?}");
            assert!(!built.pipeline.allowed(), "{kind:?}: the pipeline's own check (read inside the commit) is false");
            runtime.set_consent(kind, true, Some(version)).unwrap();
            assert!(built.pipeline.allowed());
        }
        let off = runtime.set_enabled(false).unwrap();
        assert!(!off.enabled && !built.pipeline.allowed());
        // removing a credential makes it not ready again
        runtime.set_enabled(true).unwrap();
        assert!(runtime.delete_typesafe_credential().unwrap().blockers.contains(&"typesafe_credential"));
        assert_eq!(runtime.set_enabled(true).unwrap_err().code, "not_ready");
    }

    #[test]
    fn a_consent_needs_the_disclosure_version_the_person_was_shown() {
        let dir = tempfile::tempdir().unwrap();
        let (built, _) = rig(dir.path());
        for (kind, current) in [(ConsentKind::Typesafe, jev::DISCLOSURE_VERSION), (ConsentKind::Synthesis, SYNTHESIS_DISCLOSURE_VERSION), (ConsentKind::Verification, VERIFICATION_DISCLOSURE_VERSION)] {
            let before = built.runtime.status().blockers.len();
            for wrong in [None, Some("an-older-version"), Some("")] {
                assert_eq!(built.runtime.set_consent(kind, true, wrong).unwrap_err().code, "disclosure_outdated", "{kind:?} {wrong:?}");
            }
            assert_eq!(built.runtime.status().blockers.len(), before, "a refused grant changes nothing");
            assert!(built.runtime.set_consent(kind, true, Some(current)).is_ok());
        }
    }

    #[test]
    fn the_three_permissions_are_independent_and_the_openai_key_alone_grants_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (built, secrets) = rig(dir.path());
        secrets.set(ProviderId::OpenAi, &ApiKey::parse(OPENAI_SECRET).unwrap()).unwrap();
        assert!(!built.runtime.status().synthesis.consented && !built.runtime.status().verification.consented, "a key is never permission");
        built.runtime.set_consent(ConsentKind::Synthesis, true, Some(SYNTHESIS_DISCLOSURE_VERSION)).unwrap();
        let status = built.runtime.status();
        assert!(status.synthesis.consented && !status.verification.consented && !status.typesafe.consented, "synthesis consent does not authorize verification or TypeSafe");
        assert!(status.synthesis.disclosure_version != status.verification.disclosure_version);
        assert!(status.verification.disclosure.join(" ").contains("not an independent review"));
    }

    #[test]
    fn credentials_are_write_only_and_never_appear_in_any_status() {
        let dir = tempfile::tempdir().unwrap();
        let (built, secrets) = rig(dir.path());
        assert_eq!(built.runtime.set_typesafe_credential("two words").unwrap_err().code, "invalid_credential");
        assert_eq!(built.runtime.set_typesafe_credential("").unwrap_err().code, "invalid_credential");
        grant_everything(&built.runtime, &secrets);
        let status = built.runtime.status();
        let rendered = format!("{}{:?}", serde_json::to_string(&status).unwrap(), status);
        assert!(!rendered.contains(TYPESAFE_SECRET) && !rendered.contains(OPENAI_SECRET), "no key is ever rendered");
        assert!(status.typesafe.has_credential && status.synthesis.has_credential);
        // the TypeSafe key sits in its own slot: the OpenAI slot is untouched by it, and neither is copied to the other
        assert_eq!(secrets.get(ProviderId::TypeSafe).unwrap().expose(), TYPESAFE_SECRET);
        assert_eq!(secrets.get(ProviderId::OpenAi).unwrap().expose(), OPENAI_SECRET);
        // nothing is written to disk by the runtime except the three small permission/setting files
        let mut files: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        files.sort();
        for name in &files {
            let text = std::fs::read_to_string(dir.path().join(name)).unwrap();
            assert!(!text.contains(TYPESAFE_SECRET) && !text.contains(OPENAI_SECRET), "{name}");
        }
        built.runtime.delete_typesafe_credential().unwrap();
        assert!(!built.runtime.status().typesafe.has_credential);
    }

    #[test]
    fn settings_and_consents_survive_a_restart_and_a_changed_disclosure_does_not_count() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (built, secrets) = rig(dir.path());
            grant_everything(&built.runtime, &secrets);
            built.runtime.set_enabled(true).unwrap();
            built.runtime.set_consent(ConsentKind::Verification, false, None).unwrap();
        }
        let (again, secrets) = rig(dir.path());
        let status = again.runtime.status();
        assert!(status.enabled && status.typesafe.consented && status.synthesis.consented, "saved choices are back");
        assert!(!status.verification.consented, "a revocation is durable too");
        assert!(secrets.get(ProviderId::TypeSafe).is_none(), "credentials live in the secret store, not in these files");
        // a record written for an OLDER disclosure is not consent
        std::fs::write(dir.path().join("openai-synthesis.json"), r#"{"version":1,"provider":"openai","purpose":"synthesis","granted":true,"disclosureVersion":"openai-synthesis-2020-01-v0"}"#).unwrap();
        let (stale, _) = rig(dir.path());
        assert!(!stale.runtime.status().synthesis.consented);
        // damaged files mean OFF, never ON
        for file in ["settings.json", "typesafe-consent.json", "openai-verification.json"] {
            std::fs::write(dir.path().join(file), "{ not json").unwrap();
        }
        let (damaged, _) = rig(dir.path());
        let status = damaged.runtime.status();
        assert!(!status.enabled && !status.typesafe.consented && !status.verification.consented);
    }

    #[test]
    fn a_pipeline_that_is_off_leaves_distillation_on_its_old_path() {
        use crate::distillation::{Candidate, DistillError, DistillationService, Distiller};
        use crate::storage::capture_store::{CaptureStore, CreateCaptureInput};
        struct One;
        impl Distiller for One {
            fn distill<'a>(&'a self, _: &'a str) -> crate::async_util::BoxFuture<'a, Result<Vec<Candidate>, DistillError>> {
                Box::pin(async { Ok(vec![Candidate { kind: "idea".into(), title: "T".into(), body: "B".into(), evidence: "hello world".into(), source_start: None, source_end: None }]) })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let (built, _) = rig(dir.path());
        let service = DistillationService::new(Arc::new(One)).with_evolution(built.pipeline);
        let store = CaptureStore::open_in_memory().unwrap();
        let capture = store.create(CreateCaptureInput { source: "text".into(), content: "hello world".into(), project_id: None }).unwrap();
        let outcome = tauri::async_runtime::block_on(service.distill_detailed(&store, &capture.id)).unwrap();
        assert_eq!((outcome.objects.len(), outcome.revised.len(), outcome.pending.len(), outcome.proposals.len()), (1, 0, 0, 0));
        assert_eq!(store.list_revision_proposals(None, &[]).unwrap().len(), 0);
        assert!(store.identity_decisions_for(&capture.id).unwrap().is_empty(), "OFF: not even a decision is recorded, exactly as before");
    }

    /// Every shipped (non-test) source file, as `(path relative to src, text)`.
    fn shipped_sources() -> Vec<(String, String)> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    let name = path.file_name().unwrap().to_string_lossy().to_string();
                    let is_test = name.ends_with("_tests.rs") || name.starts_with("tests") || name == "fake.rs" || name == "test_support.rs" || rel.contains("/eval/") || rel.starts_with("live_") || rel.ends_with("/live.rs") || rel.contains("bench");
                    if !is_test {
                        let text = std::fs::read_to_string(&path).unwrap();
                        // production code only: everything before the first `#[cfg(test)]`
                        let production = text.split("#[cfg(test)]").next().unwrap().to_string();
                        out.push((rel, production));
                    }
                }
            }
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut out = Vec::new();
        walk(&root, &root, &mut out);
        out
    }

    #[test]
    fn no_shipped_path_can_turn_a_suggestion_into_a_revision_except_a_deliberate_review() {
        let sources = shipped_sources();
        let files_with = |needle: &str| -> Vec<String> { sources.iter().filter(|(_, text)| text.contains(needle)).map(|(rel, _)| rel.clone()).collect() };
        // the one command that reviews: nothing else calls the review operation
        for file in files_with("review_revision_proposal(") {
            assert!(["commands/evolution.rs", "storage/proposal_store.rs"].contains(&file.as_str()), "{file} must not review a proposal");
        }
        for file in files_with("review_in(") {
            assert_eq!(file, "storage/proposal_store.rs", "{file} must not run the review step");
        }
        // writing a revision as an automatic one: only the pending-claim acceptance (called by the review) and the pipeline's own guarded path
        for file in files_with("CasOrigin::System") {
            assert!(["storage/identity_store.rs", "distillation/evolution.rs", "storage/lineage_store.rs"].contains(&file.as_str()), "{file} writes automatic revisions");
        }
        for file in files_with("accept_pending_claim") {
            assert!(["storage/identity_store.rs", "storage/proposal_store.rs"].contains(&file.as_str()), "{file} accepts a pending claim");
        }
        // the pipeline's only revising branch is switched off for review-first, and production is always review-first
        let evolution = sources.iter().find(|(rel, _)| rel == "distillation/evolution.rs").unwrap();
        assert!(evolution.1.contains("Plan::Revise { target, .. } if review_first"));
        assert!(evolution.1.contains("let review_first = pipeline.review_first();"));
        let runtime = sources.iter().find(|(rel, _)| rel == "evolution_runtime.rs").unwrap();
        assert!(runtime.1.contains("new_same_family_review(") && !runtime.1.contains(&["SynthesisStage::", "new("].concat()));
        // no command can change the mode, switch review off, or apply text a model wrote
        let commands = sources.iter().find(|(rel, _)| rel == "commands/evolution.rs").unwrap();
        let lower = commands.1.to_lowercase();
        for forbidden in ["auto_apply", "autoapply", "apply_proposal", "set_mode", "approval_mode"] {
            assert!(!lower.contains(forbidden), "no command may mention {forbidden}");
        }
        // reading, listing and reviewing a suggestion never needs a provider: the review path does not consult any authorization or credential
        let store = sources.iter().find(|(rel, _)| rel == "storage/proposal_store.rs").unwrap();
        for provider_word in ["ProviderAuthorization".to_string(), "SecretStore".to_string(), ["req", "west"].concat(), ["api", "_key"].concat()] {
            assert!(!store.1.contains(&provider_word), "the review store must not touch {provider_word}");
        }
    }
}
