//! The user's consent to semantic Recall.
//!
//! Semantic Recall sends text to a cloud embedding provider, so it is OPT-IN, never implied by the presence of an API key. The
//! choice is one global, per-device preference kept in app-private storage, deliberately OUTSIDE the database: the `recall_*`
//! tables are rebuildable projections and must never own a privacy decision (dropping them must not change consent).
//!
//! The preference is bound to the embedding space it was granted for (`ModelKey`: provider, model, dimensions, template version).
//! A different provider or model is a different recipient, so a saved "yes" for another key is NOT consent for this one.
//!
//! It fails CLOSED: a missing, unreadable, corrupt, wrong-version or wrong-type file means OFF. It is read on every use, so turning
//! it off takes effect for the very next request.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Value};

use crate::providers::embed::ModelKey;

const FILE_VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    /// The saved choice, if the file is valid.
    pub saved_enabled: bool,
    /// The embedding space the choice was granted for.
    pub saved_model_key: Option<String>,
    /// The file exists but cannot be trusted (treated as OFF).
    pub corrupt: bool,
}

pub struct SemanticSettings {
    path: PathBuf,
}

impl SemanticSettings {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn state(&self) -> SettingsState {
        let absent = SettingsState { saved_enabled: false, saved_model_key: None, corrupt: false };
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return absent,
            Err(_) => return SettingsState { corrupt: true, ..absent },
        };
        let corrupt = || SettingsState { corrupt: true, ..absent.clone() };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else { return corrupt() };
        if value.get("version").and_then(Value::as_u64) != Some(FILE_VERSION) {
            return corrupt();
        }
        let Some(section) = value.get("semanticRecall").and_then(Value::as_object) else { return corrupt() };
        let (Some(enabled), Some(model_key)) = (section.get("enabled").and_then(Value::as_bool), section.get("modelKey").and_then(Value::as_str)) else { return corrupt() };
        if model_key.is_empty() {
            return corrupt();
        }
        SettingsState { saved_enabled: enabled, saved_model_key: Some(model_key.to_string()), corrupt: false }
    }

    /// True only when the user explicitly enabled semantic Recall FOR THIS embedding space.
    pub fn is_enabled_for(&self, key: &ModelKey) -> bool {
        let state = self.state();
        state.saved_enabled && state.saved_model_key.as_deref() == Some(key.as_str())
    }

    /// Records the choice atomically (write a temporary file, then rename), so a crash never leaves a half-written preference.
    pub fn set(&self, key: &ModelKey, enabled: bool) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = json!({ "version": FILE_VERSION, "semanticRecall": { "enabled": enabled, "modelKey": key.as_str() } });
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&body).map_err(io::Error::other)?)?;
        fs::rename(&temporary, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(dims: usize) -> ModelKey {
        ModelKey::new("openai", "text-embedding-3-small", dims, "v1")
    }

    fn settings() -> (tempfile::TempDir, SemanticSettings) {
        let dir = tempfile::tempdir().unwrap();
        let settings = SemanticSettings::new(dir.path().join("recall").join("semantic.json"));
        (dir, settings)
    }

    #[test]
    fn it_is_off_by_default_and_a_missing_file_is_not_corruption() {
        let (_dir, settings) = settings();
        assert!(!settings.is_enabled_for(&key(512)));
        assert_eq!(settings.state(), SettingsState { saved_enabled: false, saved_model_key: None, corrupt: false });
    }

    #[test]
    fn enabling_and_disabling_take_effect_immediately_and_persist() {
        let (dir, settings) = settings();
        settings.set(&key(512), true).unwrap();
        assert!(settings.is_enabled_for(&key(512)));
        // A fresh handle (a restart) sees the same.
        assert!(SemanticSettings::new(dir.path().join("recall").join("semantic.json")).is_enabled_for(&key(512)));
        settings.set(&key(512), false).unwrap();
        assert!(!settings.is_enabled_for(&key(512)));
        assert_eq!(settings.state().saved_model_key.as_deref(), Some("openai:text-embedding-3-small:512:v1"));
    }

    #[test]
    fn consent_is_bound_to_the_embedding_space_it_was_granted_for() {
        let (_dir, settings) = settings();
        settings.set(&key(512), true).unwrap();
        assert!(!settings.is_enabled_for(&key(1536)), "another dimension is another key");
        assert!(!settings.is_enabled_for(&ModelKey::new("local", "e5", 512, "v1")), "another provider is another recipient");
    }

    #[test]
    fn every_kind_of_damage_fails_closed() {
        let (dir, settings) = settings();
        let path = dir.path().join("recall").join("semantic.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for damaged in [
            "",
            "not json",
            "[]",
            "{}",
            r#"{"version":2,"semanticRecall":{"enabled":true,"modelKey":"openai:text-embedding-3-small:512:v1"}}"#,
            r#"{"version":1,"semanticRecall":{"enabled":"yes","modelKey":"openai:text-embedding-3-small:512:v1"}}"#,
            r#"{"version":1,"semanticRecall":{"enabled":true}}"#,
            r#"{"version":1,"semanticRecall":{"enabled":true,"modelKey":""}}"#,
            r#"{"version":1,"semanticRecall":true}"#,
            "{\"version\":1,\"semanticRecall\":{\"enabled\":true,\"modelKey\":\"openai:text-embedding-3-small:512:v1\"",
        ] {
            std::fs::write(&path, damaged).unwrap();
            assert!(!settings.is_enabled_for(&key(512)), "{damaged:?}");
            assert!(settings.state().corrupt, "{damaged:?}");
        }
        // An unreadable path (a directory where the file should be) also fails closed.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(!settings.is_enabled_for(&key(512)));
        assert!(settings.state().corrupt);
    }

    #[test]
    fn the_api_key_alone_never_enables_it() {
        // The settings file is the only thing consulted: there is no code path from a credential to consent.
        let (_dir, settings) = settings();
        assert!(!settings.is_enabled_for(&key(512)));
    }
}
