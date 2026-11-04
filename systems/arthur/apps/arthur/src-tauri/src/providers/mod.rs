//! Shared plumbing for cloud providers (speech-to-text, distillation, embeddings, answers).
//!
//! Provider-specific request and response handling lives in its own module
//! (`stt`, `distillation`); this module holds what they share: which providers and capabilities exist (`registry`), where
//! credentials are kept (`secrets`, `android_keystore`), the semantic operations the UI may ask for (`ai`), and the HTTP client.

pub mod ai;
pub mod ai_config;
#[cfg(target_os = "android")]
pub mod android_keystore;
pub mod answer;
pub mod chat;
pub mod credentials;
pub mod embed;
pub mod http;
pub mod probe;
pub mod registry;
pub mod secrets;
