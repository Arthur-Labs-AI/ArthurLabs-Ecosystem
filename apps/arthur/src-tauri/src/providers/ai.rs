//! The AI provider service: credentials, capability bindings and the semantic operations the UI is allowed to ask for.
//!
//! There is no operation here that returns a credential. `credential_for` hands native providers a `CredentialSource` that
//! resolves capability -> provider -> secret on every request, so removing or changing a credential takes effect immediately.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;

use super::ai_config::AiConfigStore;
use super::credentials::{ApiKey, CredentialSource};
use super::probe::{probe_models, ProbeOutcome};
use super::registry::{models, Capability, ProviderId};
use super::secrets::{migrate_legacy_file, SecretError, SecretStore};

/// A credential for one capability, resolved at the moment of each request.
struct BoundCredential {
    capability: Capability,
    config: Arc<AiConfigStore>,
    store: Arc<dyn SecretStore>,
}

impl CredentialSource for BoundCredential {
    fn api_key(&self) -> Option<ApiKey> {
        self.store.get(self.config.read().provider_for(self.capability))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: ProviderId,
    pub name: &'static str,
    /// Whether a credential is stored. The value is never exposed.
    pub has_credential: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityStatus {
    Ready,
    NeedsCredential,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityView {
    pub capability: Capability,
    pub provider: ProviderId,
    pub provider_name: &'static str,
    /// The models in use, the first being the one to show.
    pub models: Vec<&'static str>,
    pub status: CapabilityStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub setup_completed: bool,
    pub providers: Vec<ProviderView>,
    pub capabilities: Vec<CapabilityView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub capability: Capability,
    pub outcome: ProbeOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum AiError {
    /// The value is not a plausible key. Says nothing about the value itself.
    InvalidCredentialFormat,
    UnknownProvider,
    UnknownCapability,
    Storage { message: String },
}

impl From<SecretError> for AiError {
    fn from(error: SecretError) -> Self {
        AiError::Storage { message: error.0 }
    }
}

pub struct AiService {
    config: Arc<AiConfigStore>,
    store: Arc<dyn SecretStore>,
    /// Overrides every provider's API base. Tests only.
    api_base: Option<String>,
}

impl AiService {
    /// `legacy_file` is the credential file earlier builds used; on Android it is moved into the secure store once.
    pub fn new(config: AiConfigStore, store: Arc<dyn SecretStore>, legacy_file: Option<&Path>) -> Self {
        let config = Arc::new(config);
        let migrated = legacy_file.is_some_and(|path| migrate_legacy_file(path, ProviderId::OpenAi, store.as_ref()));
        // An installation that already had a working credential (migrated, or provisioned before Setup existed) is not asked to
        // run first-run Setup. A fresh install has neither a config file nor a credential, so it is.
        let existing = migrated || (!config.read().exists && ProviderId::ALL.into_iter().any(|provider| store.has(provider)));
        if existing {
            let _ = config.set_setup_completed(true);
        }
        Self { config, store, api_base: None }
    }

    #[cfg(test)]
    fn with_api_base(mut self, base: &str) -> Self {
        self.api_base = Some(base.to_string());
        self
    }

    pub fn credential_for(&self, capability: Capability) -> Arc<dyn CredentialSource> {
        Arc::new(BoundCredential { capability, config: self.config.clone(), store: self.store.clone() })
    }

    pub fn snapshot(&self) -> AiConfig {
        let file = self.config.read();
        AiConfig {
            setup_completed: file.setup_completed,
            providers: ProviderId::ALL.into_iter().map(|id| ProviderView { id, name: id.display_name(), has_credential: self.store.has(id) }).collect(),
            capabilities: Capability::ALL
                .into_iter()
                .map(|capability| {
                    let provider = file.provider_for(capability);
                    CapabilityView {
                        capability,
                        provider,
                        provider_name: provider.display_name(),
                        models: models(provider, capability).to_vec(),
                        status: if self.store.has(provider) { CapabilityStatus::Ready } else { CapabilityStatus::NeedsCredential },
                    }
                })
                .collect(),
        }
    }

    pub fn set_credential(&self, provider: &str, secret: &str) -> Result<AiConfig, AiError> {
        let provider = ProviderId::parse(provider).ok_or(AiError::UnknownProvider)?;
        let key = ApiKey::parse(secret).ok_or(AiError::InvalidCredentialFormat)?;
        self.store.set(provider, &key)?;
        Ok(self.snapshot())
    }

    pub fn has_credential(&self, provider: &str) -> Result<bool, AiError> {
        Ok(self.store.has(ProviderId::parse(provider).ok_or(AiError::UnknownProvider)?))
    }

    pub fn delete_credential(&self, provider: &str) -> Result<AiConfig, AiError> {
        self.store.delete(ProviderId::parse(provider).ok_or(AiError::UnknownProvider)?)?;
        Ok(self.snapshot())
    }

    pub fn complete_setup(&self) -> Result<AiConfig, AiError> {
        self.config.set_setup_completed(true).map_err(|_| AiError::Storage { message: "the setup state could not be saved".into() })?;
        Ok(self.snapshot())
    }

    pub async fn test(&self, capability: &str) -> Result<ProviderTestResult, AiError> {
        let capability = Capability::parse(capability).ok_or(AiError::UnknownCapability)?;
        let provider = self.config.read().provider_for(capability);
        let outcome = match self.store.get(provider) {
            None => ProbeOutcome::NotConfigured,
            Some(key) => probe_models(self.api_base.as_deref().unwrap_or(provider.api_base()), &key, models(provider, capability)).await,
        };
        Ok(ProviderTestResult { capability, outcome })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::secrets::tests::MemorySecretStore;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn service(dir: &Path) -> (AiService, Arc<MemorySecretStore>) {
        let store = Arc::new(MemorySecretStore::default());
        (AiService::new(AiConfigStore::new(dir.join("ai.json")), store.clone(), None), store)
    }

    #[test]
    fn a_fresh_install_needs_setup_and_every_capability_needs_a_credential() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = service(dir.path());
        let config = service.snapshot();
        assert!(!config.setup_completed);
        assert!(config.providers.iter().all(|provider| !provider.has_credential));
        assert!(config.capabilities.iter().all(|capability| capability.status == CapabilityStatus::NeedsCredential));
        assert_eq!(config.capabilities.len(), 3, "no TTS capability exists");
    }

    #[test]
    fn one_provider_credential_serves_every_capability_bound_to_it_and_removal_revokes_all() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = service(dir.path());
        let llm = service.credential_for(Capability::Llm);
        let stt = service.credential_for(Capability::Stt);
        assert!(llm.api_key().is_none() && stt.api_key().is_none());

        let config = service.set_credential("openai", "sk-shared").unwrap();
        assert!(config.capabilities.iter().all(|capability| capability.status == CapabilityStatus::Ready));
        assert_eq!(llm.api_key().unwrap().expose(), "sk-shared");
        assert_eq!(stt.api_key().unwrap().expose(), "sk-shared");

        let config = service.delete_credential("openai").unwrap();
        assert!(config.capabilities.iter().all(|capability| capability.status == CapabilityStatus::NeedsCredential));
        assert!(llm.api_key().is_none(), "removal applies to the very next request");
    }

    #[test]
    fn the_serialised_config_never_contains_the_secret() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = service(dir.path());
        let config = service.set_credential("openai", "sk-never-shown-9876").unwrap();
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("never-shown") && !json.contains("9876"), "{json}");
        assert!(json.contains("\"hasCredential\":true") && json.contains("\"id\":\"openai\"") && json.contains("\"provider\":\"openai\""), "{json}");
    }

    #[test]
    fn implausible_values_and_unknown_names_are_rejected_without_echoing_the_value() {
        let dir = tempfile::tempdir().unwrap();
        let (service, store) = service(dir.path());
        for bad in ["", "two words", "sk-a\nsk-b"] {
            assert_eq!(service.set_credential("openai", bad), Err(AiError::InvalidCredentialFormat));
        }
        assert_eq!(service.set_credential("tts", "sk-x"), Err(AiError::UnknownProvider));
        assert_eq!(service.has_credential("nope"), Err(AiError::UnknownProvider));
        assert!(!store.has(ProviderId::OpenAi));
    }

    #[test]
    fn setup_completion_persists_and_an_existing_credential_skips_first_run_setup() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = service(dir.path());
        assert!(service.complete_setup().unwrap().setup_completed);
        let again = AiService::new(AiConfigStore::new(dir.path().join("ai.json")), Arc::new(MemorySecretStore::default()), None);
        assert!(again.snapshot().setup_completed);

        let fresh_dir = tempfile::tempdir().unwrap();
        let provisioned = Arc::new(MemorySecretStore::default());
        provisioned.set(ProviderId::OpenAi, &ApiKey::parse("sk-existing").unwrap()).unwrap();
        let upgraded = AiService::new(AiConfigStore::new(fresh_dir.path().join("ai.json")), provisioned, None);
        assert!(upgraded.snapshot().setup_completed);
    }

    #[test]
    fn a_legacy_credential_file_is_imported_once_and_marks_setup_done() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("openai_api_key");
        std::fs::write(&legacy, "sk-dev-provisioned\n").unwrap();
        let store = Arc::new(MemorySecretStore::default());
        let service = AiService::new(AiConfigStore::new(dir.path().join("ai.json")), store.clone(), Some(&legacy));
        assert_eq!(store.get(ProviderId::OpenAi).unwrap().expose(), "sk-dev-provisioned");
        assert!(!legacy.exists());
        assert!(service.snapshot().setup_completed);
    }

    #[test]
    fn testing_without_a_credential_makes_no_request() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = service(dir.path());
        let result = tauri::async_runtime::block_on(service.test("stt")).unwrap();
        assert_eq!(result.outcome, ProbeOutcome::NotConfigured);
        assert_eq!(tauri::async_runtime::block_on(service.test("tts")), Err(AiError::UnknownCapability));
    }

    #[test]
    fn testing_uses_the_bound_credential_against_the_capabilitys_models() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buffer[..read]).lines().next().unwrap_or("").to_string());
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = service(dir.path());
        let service = service.with_api_base(&base);
        service.set_credential("openai", "sk-probe").unwrap();
        let result = tauri::async_runtime::block_on(service.test("llm")).unwrap();
        assert_eq!(result.outcome, ProbeOutcome::Connected);
        let lines: Vec<String> = rx.try_iter().collect();
        assert_eq!(lines.len(), 2, "the answer model and the relation verifier are both checked");
        assert!(lines.iter().all(|line| line.starts_with("GET /models/")));
    }
}
