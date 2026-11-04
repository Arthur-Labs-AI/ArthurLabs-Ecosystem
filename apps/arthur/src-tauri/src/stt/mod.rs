//! Cloud speech-to-text. Audio in, transcript out; nothing else.
//!
//! This is the native counterpart of the TypeScript `OpenAiSttProvider`
//! (`src/voice/stt/openai_provider.ts`), which cannot run inside the Android
//! app (no Node). It follows the same wire contract: the OpenAI transcription
//! endpoint, `gpt-4o-transcribe`, language left on auto, strictly parsed
//! `{ text }` response.

pub mod openai;

use crate::async_util::BoxFuture;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttError {
    /// No credential is available. No request was made.
    NotConfigured,
    /// The provider could not be reached or timed out.
    Network,
    /// The provider rejected the credential (HTTP 401/403).
    Auth(u16),
    /// The provider answered with another failure status.
    Provider(u16),
    /// The provider answered 2xx with something that is not a transcript.
    Protocol,
}

pub trait Transcriber: Send + Sync {
    /// `file_name` carries the container type (for example `recording.m4a`).
    fn transcribe<'a>(
        &'a self,
        audio: &'a [u8],
        file_name: &'a str,
    ) -> BoxFuture<'a, Result<String, SttError>>;
}
