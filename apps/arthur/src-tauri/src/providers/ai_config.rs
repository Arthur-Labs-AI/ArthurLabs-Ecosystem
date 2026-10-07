//! Non-secret AI configuration: whether first-run Setup is done and which provider serves each capability.
//!
//! Kept in one small JSON file in app-private storage, outside the database (like the Semantic Recall consent). It holds no
//! credential and no consent. A missing or damaged file means "Setup not done, default bindings", never a crash.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::registry::{tts_options, Capability, ProviderId};

const FILE_VERSION: u64 = 1;

pub struct AiConfigStore {
    path: PathBuf,
    // Serialises the read-modify-write below.
    lock: Mutex<()>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiConfigFile {
    /// False when the file is absent or unreadable.
    pub exists: bool,
    pub setup_completed: bool,
    bindings: BTreeMap<String, String>,
    tts_model: Option<String>,
    tts_voice: Option<String>,
}

impl AiConfigFile {
    /// The configured text-to-speech model, or the provider default when it is unset or not one the provider offers.
    pub fn tts_model(&self) -> String {
        let options = tts_options(self.provider_for(Capability::Tts));
        self.tts_model.clone().filter(|model| options.models.contains(&model.as_str())).unwrap_or_else(|| options.default_model.to_string())
    }

    pub fn tts_voice(&self) -> String {
        let options = tts_options(self.provider_for(Capability::Tts));
        self.tts_voice.clone().filter(|voice| options.voices.contains(&voice.as_str())).unwrap_or_else(|| options.default_voice.to_string())
    }

    /// The provider serving `capability`. An unknown or unsupported binding falls back to the capability's default.
    pub fn provider_for(&self, capability: Capability) -> ProviderId {
        self.bindings
            .get(capability.as_str())
            .and_then(|name| ProviderId::parse(name))
            .filter(|provider| provider.supports(capability))
            .unwrap_or_else(|| capability.default_provider())
    }
}

impl AiConfigStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    pub fn read(&self) -> AiConfigFile {
        let absent = AiConfigFile { exists: false, setup_completed: false, bindings: BTreeMap::new(), tts_model: None, tts_voice: None };
        let Ok(raw) = fs::read_to_string(&self.path) else { return absent };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else { return absent };
        if value.get("version").and_then(Value::as_u64) != Some(FILE_VERSION) {
            return absent;
        }
        let bindings = value
            .get("bindings")
            .and_then(Value::as_object)
            .map(|map| map.iter().filter_map(|(name, provider)| provider.as_str().map(|provider| (name.clone(), provider.to_string()))).collect())
            .unwrap_or_default();
        let tts = value.get("tts");
        let text = |key: &str| tts.and_then(|section| section.get(key)).and_then(Value::as_str).map(str::to_string);
        AiConfigFile { exists: true, setup_completed: value.get("setupCompleted").and_then(Value::as_bool).unwrap_or(false), bindings, tts_model: text("model"), tts_voice: text("voice") }
    }

    /// Rewrites the file from what is currently read, so every field (including the text-to-speech model and voice defaults) is written
    /// out explicitly even when the file predates it or does not exist yet. Idempotent; never changes a value.
    pub fn refresh(&self) -> io::Result<()> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = self.read();
        self.write(current.setup_completed, &current)
    }

    pub fn set_setup_completed(&self, completed: bool) -> io::Result<()> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = self.read();
        self.write(completed, &current)
    }

    fn write(&self, completed: bool, current: &AiConfigFile) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bindings: BTreeMap<&str, &str> = Capability::ALL.into_iter().map(|capability| (capability.as_str(), current.provider_for(capability).as_str())).collect();
        let body = json!({ "version": FILE_VERSION, "setupCompleted": completed, "bindings": bindings, "tts": { "model": current.tts_model(), "voice": current.tts_voice() } });
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&body).map_err(io::Error::other)?)?;
        fs::rename(&temporary, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_damaged_file_means_setup_not_done_with_default_bindings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai.json");
        let store = AiConfigStore::new(path.clone());
        let file = store.read();
        assert!(!file.exists && !file.setup_completed);
        assert_eq!(file.provider_for(Capability::Stt), ProviderId::OpenAi);

        for damaged in ["not json", "{}", "{\"version\":9,\"setupCompleted\":true}"] {
            fs::write(&path, damaged).unwrap();
            let file = store.read();
            assert!(!file.exists && !file.setup_completed, "{damaged}");
        }
    }

    #[test]
    fn completion_persists_and_the_file_holds_only_non_secret_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai.json");
        let store = AiConfigStore::new(path.clone());
        store.set_setup_completed(true).unwrap();
        assert!(store.read().setup_completed);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("setupCompleted") && raw.contains("\"stt\": \"openai\""));
        assert!(!raw.to_lowercase().contains("key"), "{raw}");
    }

    #[test]
    fn tts_model_and_voice_are_explicit_in_the_file_and_fall_back_when_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai.json");
        let store = AiConfigStore::new(path.clone());
        store.set_setup_completed(true).unwrap();
        let file = store.read();
        assert_eq!((file.tts_model().as_str(), file.tts_voice().as_str()), ("gpt-4o-mini-tts", "alloy"));
        assert!(fs::read_to_string(&path).unwrap().contains("\"voice\": \"alloy\""), "the defaults are written out, not implied");

        fs::write(&path, r#"{"version":1,"setupCompleted":true,"tts":{"model":"gpt-4o-mini-tts","voice":"coral"}}"#).unwrap();
        assert_eq!(store.read().tts_voice(), "coral");
        fs::write(&path, r#"{"version":1,"setupCompleted":true,"tts":{"model":"made-up","voice":"made-up"}}"#).unwrap();
        assert_eq!((store.read().tts_model().as_str(), store.read().tts_voice().as_str()), ("gpt-4o-mini-tts", "alloy"));
    }

    #[test]
    fn refresh_writes_new_fields_into_an_older_file_without_changing_any_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai.json");
        fs::write(&path, r#"{"version":1,"setupCompleted":true,"bindings":{"llm":"openai","stt":"openai","embeddings":"openai"}}"#).unwrap();
        let store = AiConfigStore::new(path.clone());
        assert!(!fs::read_to_string(&path).unwrap().contains("tts"));
        store.refresh().unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"voice\": \"alloy\"") && raw.contains("\"tts\": \"openai\""), "{raw}");
        assert!(store.read().setup_completed);

        let fresh = AiConfigStore::new(dir.path().join("new.json"));
        fresh.refresh().unwrap();
        assert!(!fresh.read().setup_completed, "a fresh install still shows Setup");
    }

    #[test]
    fn an_unsupported_binding_falls_back_to_the_default_provider() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ai.json");
        fs::write(&path, r#"{"version":1,"setupCompleted":true,"bindings":{"llm":"nonexistent"}}"#).unwrap();
        assert_eq!(AiConfigStore::new(path).read().provider_for(Capability::Llm), ProviderId::OpenAi);
    }
}
