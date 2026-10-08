//! OPTIONAL live smoke test: SYNTHETIC text only, never run automatically (`#[ignore]`), never part of CI.
//!
//! It makes real, PAID requests to TypeSafe. Do not run it without approval, and only with a ROTATED key (the key shared earlier in a
//! conversation is compromised). Expected cost: 6 synthetic claims x 3 runs = 18 requests of roughly 900 input tokens each, about 16k
//! input tokens, i.e. under $0.001 at $0.042 per million. SYNTHETIC text only: never real captures.
//!
//! ```text
//! ARTHUR_JEV_LIVE_SMOKE=yes ARTHUR_TYPESAFE_API_KEY=<rotated key> \
//!   cargo test --offline --lib jev::live -- --ignored --nocapture
//! ```
//! The key is read from the environment into memory and never printed or written; only fixed error codes, counts and the aggregate
//! token usage are printed. Privacy context: docs/architecture/m047b-phase4a-jev-adapter.md section 3.

use std::sync::Arc;
use std::time::Duration;

use super::client::{JevClient, RetryPolicy};
use super::consent::JevConsent;
use super::provider::{JevIdentityProvider, TypeSafeCredential};
use super::transport::ReqwestTransport;
use crate::distillation::evolution::{AsyncIdentityClassifier, EvolutionSettings};
use crate::identity::{Candidate, Claim, EvidenceSpan, ObjectLifecycle, ProjectState, RevisionView};
use crate::providers::credentials::ApiKey;
use crate::providers::secrets::SecretStore;

fn project() -> ProjectState {
    ProjectState { id: "synthetic-project".into(), archived: false, is_inbox: false }
}

fn idea(id: &str, title: &str, body: &str) -> Candidate {
    Candidate { object_id: id.into(), project: project(), lifecycle: ObjectLifecycle::Active, current_revision_id: format!("{id}-r1"), revision: RevisionView { id: format!("{id}-r1"), origin: "initial".into(), kind: "idea".into(), title: title.into(), body: body.into() } }
}

fn claim(ordinal: usize, title: &str, text: &str) -> Claim {
    Claim { ordinal, kind: "idea".into(), title: title.into(), body: text.into(), evidence: EvidenceSpan { capture_id: "synthetic".into(), start: 0, end: text.chars().count() as i64 }, evidence_text: text.into(), project: project() }
}

#[test]
#[ignore = "makes real paid requests; needs ARTHUR_JEV_LIVE_SMOKE=yes and a rotated ARTHUR_TYPESAFE_API_KEY"]
fn synthetic_smoke_test_against_the_real_endpoint() {
    assert_eq!(std::env::var("ARTHUR_JEV_LIVE_SMOKE").as_deref(), Ok("yes"), "set ARTHUR_JEV_LIVE_SMOKE=yes to confirm you want paid requests");
    let raw = std::env::var("ARTHUR_TYPESAFE_API_KEY").expect("ARTHUR_TYPESAFE_API_KEY");
    let key = ApiKey::parse(&raw).expect("a well-formed key");

    struct Fixed(ApiKey);
    impl SecretStore for Fixed {
        fn set(&self, _: crate::providers::registry::ProviderId, _: &ApiKey) -> Result<(), crate::providers::secrets::SecretError> {
            Ok(())
        }
        fn has(&self, _: crate::providers::registry::ProviderId) -> bool {
            true
        }
        fn delete(&self, _: crate::providers::registry::ProviderId) -> Result<(), crate::providers::secrets::SecretError> {
            Ok(())
        }
        fn get(&self, provider: crate::providers::registry::ProviderId) -> Option<ApiKey> {
            (provider == crate::providers::registry::ProviderId::TypeSafe).then(|| self.0.clone())
        }
    }
    let transport = Arc::new(ReqwestTransport::production().expect("client"));
    let client = JevClient::new(transport, RetryPolicy::default(), Duration::from_secs(20), 2, 100);
    let settings = Arc::new(EvolutionSettings::in_memory(true));
    let consent = Arc::new(JevConsent::in_memory(true));
    let provider = JevIdentityProvider::new(client, Arc::new(TypeSafeCredential::new(Arc::new(Fixed(key)))), consent, settings);

    let mobile = idea("a", "Mobile", "Arthur is a mobile application.");
    let voice = idea("b", "Voice", "Arthur needs voice recognition.");
    let items = vec![
        (claim(0, "Desktop too", "Arthur will also support desktop."), vec![mobile.clone(), voice.clone()]),
        (claim(1, "Offline storage", "Arthur needs offline storage."), vec![mobile.clone(), voice.clone()]),
        (claim(2, "Tablet", "Arthur is a thinking tool, not an app."), vec![mobile.clone()]),
        (claim(3, "Десктоп", "Arthur ще работи и на десктоп."), vec![mobile.clone()]),
        (claim(4, "Бързо", "Направи го по-бързо."), vec![mobile.clone(), voice.clone()]),
        (claim(5, "Hotel", "Book the hotel in Rome."), vec![idea("c", "Trip", "Plan the trip to Rome.")]),
    ];
    let results = tauri::async_runtime::block_on(provider.classify_capture(&items));
    for (index, result) in results.iter().enumerate() {
        match result {
            Ok(out) => println!("claim {index}: {} runs, model {}", out.runs.len(), out.model_id),
            Err(failure) => println!("claim {index}: failed ({failure:?})"),
        }
    }
    let d = provider.diagnostics();
    println!("requests {} retries {} input_tokens {} output_tokens {} usage_missing {} est_cost_usd {:.6} failures {:?}", d.requests, d.retries, d.input_tokens, d.output_tokens, d.usage_missing, d.estimated_cost_usd, d.failures);
    assert!(results.iter().any(|r| r.is_ok()), "at least one claim should classify");
}
