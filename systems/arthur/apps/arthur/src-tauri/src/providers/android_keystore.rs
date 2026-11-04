//! Android Keystore-backed `SecretStore`: a thin bridge to the Kotlin `SecretsPlugin`
//! (`gen/android/app/src/main/java/dev/kaloyan/arthur/SecretsPlugin.kt`).
//!
//! The plugin encrypts each credential with AES-256-GCM under a non-extractable key that lives in the Android Keystore and
//! stores only the ciphertext in app-private preferences. Plugin commands are reachable only from this Rust module (they are not
//! Tauri commands), so the webview can never read a credential back; `get` exists for native providers alone.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

use super::credentials::ApiKey;
use super::registry::ProviderId;
use super::secrets::{SecretError, SecretStore};

const PLUGIN_IDENTIFIER: &str = "dev.kaloyan.arthur";
const PLUGIN_CLASS: &str = "SecretsPlugin";

pub struct AndroidKeystoreStore {
    handle: PluginHandle<Wry>,
}

#[derive(Serialize)]
struct IdArgs<'a> {
    id: &'a str,
}

#[derive(Serialize)]
struct PutArgs<'a> {
    id: &'a str,
    value: &'a str,
}

#[derive(Deserialize)]
struct PresentPayload {
    present: bool,
}

#[derive(Deserialize)]
struct ValuePayload {
    value: Option<String>,
}

impl SecretStore for AndroidKeystoreStore {
    fn set(&self, provider: ProviderId, key: &ApiKey) -> Result<(), SecretError> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(
                "putSecret",
                PutArgs {
                    id: provider.as_str(),
                    value: key.expose(),
                },
            )
            .map(|_| ())
            .map_err(|_| {
                SecretError("the credential could not be saved securely on this device".into())
            })
    }

    fn has(&self, provider: ProviderId) -> bool {
        self.handle
            .run_mobile_plugin::<PresentPayload>(
                "hasSecret",
                IdArgs {
                    id: provider.as_str(),
                },
            )
            .is_ok_and(|payload| payload.present)
    }

    fn delete(&self, provider: ProviderId) -> Result<(), SecretError> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(
                "deleteSecret",
                IdArgs {
                    id: provider.as_str(),
                },
            )
            .map(|_| ())
            .map_err(|_| SecretError("the credential could not be removed".into()))
    }

    fn get(&self, provider: ProviderId) -> Option<ApiKey> {
        let payload = self
            .handle
            .run_mobile_plugin::<ValuePayload>(
                "readSecret",
                IdArgs {
                    id: provider.as_str(),
                },
            )
            .ok()?;
        payload.value.as_deref().and_then(ApiKey::parse)
    }
}

/// Registers the Kotlin plugin and makes the store available as managed state.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("arthur-secrets")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
            app.manage(Arc::new(AndroidKeystoreStore { handle }));
            Ok(())
        })
        .build()
}
