//! Shared plumbing for cloud providers (speech-to-text, distillation).
//!
//! Provider-specific request and response handling lives in its own module
//! (`stt`, `distillation`); this module only holds what they share: where the
//! API key comes from and how the HTTP client is built.

pub mod credentials;
pub mod http;
