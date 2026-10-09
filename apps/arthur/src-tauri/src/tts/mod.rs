//! Voice output (M04.6): text in, spoken audio out. Output only: no conversation, no wake word, no automatic speech.
//!
//! The audio never reaches the webview. React asks the native layer to *speak* some text; the native layer synthesizes it with the
//! configured provider (credentials from the `SecretStore` through the capability-bound source), plays it, and deletes it. Nothing is
//! archived and nothing about what was spoken is stored.

pub mod chunk;
pub mod openai;
pub mod player;
pub mod service;
#[cfg(target_os = "android")]
pub mod android;

use crate::async_util::BoxFuture;

/// Why a piece of text could not be turned into audio. Never carries a provider body or a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtsError {
    /// No credential. No request was made.
    NotConfigured,
    /// The provider rejected the credential (401/403).
    Auth,
    /// The provider could not be reached, or timed out.
    Network,
    /// The provider does not offer this voice or model (400/404).
    Unsupported,
    /// Another failure status.
    Provider(u16),
    /// A 2xx that is not usable audio, or audio larger than the bound.
    Protocol,
}

/// Audio as the provider returned it (MP3). Held in memory only until it is written to a transient file for playback.
pub struct Speech {
    pub bytes: Vec<u8>,
}

pub trait Synthesizer: Send + Sync {
    fn synthesize<'a>(&'a self, text: &'a str, voice: &'a str, model: &'a str) -> BoxFuture<'a, Result<Speech, TtsError>>;
}
