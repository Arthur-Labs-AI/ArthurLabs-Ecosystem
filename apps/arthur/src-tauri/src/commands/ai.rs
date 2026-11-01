//! Native boundary of provider setup (M04.5).
//!
//! These are the only operations the UI has over credentials: store one, ask whether one exists, delete one, test a capability.
//! There is deliberately no command that returns a credential, and no command or event payload here ever contains one.

use std::sync::Arc;

use tauri::State;

use crate::providers::ai::{AiConfig, AiError, AiService, ProviderTestResult};

type Ai<'a> = State<'a, Arc<AiService>>;

#[tauri::command]
pub fn get_ai_config(ai: Ai<'_>) -> AiConfig {
    ai.snapshot()
}

/// Stores the credential for a provider account and returns the configuration WITHOUT it. `secret` is moved into secure storage
/// and is never logged or echoed, including in errors.
#[tauri::command]
pub fn set_provider_credential(
    ai: Ai<'_>,
    provider: String,
    secret: String,
) -> Result<AiConfig, AiError> {
    ai.set_credential(&provider, &secret)
}

#[tauri::command]
pub fn has_provider_credential(ai: Ai<'_>, provider: String) -> Result<bool, AiError> {
    ai.has_credential(&provider)
}

#[tauri::command]
pub fn delete_provider_credential(ai: Ai<'_>, provider: String) -> Result<AiConfig, AiError> {
    ai.delete_credential(&provider)
}

/// A bounded, token-free check of the credential for one capability.
#[tauri::command]
pub async fn test_provider(ai: Ai<'_>, capability: String) -> Result<ProviderTestResult, AiError> {
    ai.test(&capability).await
}

/// Records that first-run Setup was finished or skipped. Stores no secret and no consent.
#[tauri::command]
pub fn complete_setup(ai: Ai<'_>) -> Result<AiConfig, AiError> {
    ai.complete_setup()
}
