//! TypeSafe JEV identity provider adapter (M04.7B Phase 4A): the PROVIDER BOUNDARY for Automatic Thought Evolution.
//!
//! ```text
//! distillation (async)                         jev (this module)                                  identity (pure, sync)
//!   claims + same-project candidates  ──►  JevIdentityProvider::classify_capture ──►  ClassifierOutput per claim ──► Prefetched ──► resolve_capture
//!                                              preflight: evolution ON + consent + credential
//!                                              3 shuffled-order runs per claim, each ONE request
//!                                              strict validation, model pinned, typed failures only
//! ```
//! This phase implements the adapter and nothing that activates it: production never constructs it (`distillation` keeps its test-only
//! injector), no command or UI exposes it, there is no revision synthesis, and nothing here touches SQLite, the graph or Recall
//! (`architecture_tests`). The deterministic safety gates live in `identity` and know nothing about TypeSafe.
//!
//! Official contract (verified against docs.typesafe.ai, 2026-10): `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`,
//! body `{ state, model, questions }`, response `{ model, answers, usage }`; 401 bad key, 422 invalid request, 429 rate limit, 529
//! overload (retry with exponential backoff); Noul answers carry `noul` only (no confidence), Choice answers `choice`, `probabilities`,
//! `confidence`. See `docs/architecture/m047b-phase4a-jev-adapter.md` for sources, privacy findings and blockers.
//!
//! EVERYTHING numeric the adapter maps (risk thresholds, referent/supersession cut-offs) is EXPERIMENTAL and uncalibrated: the Phase 1A
//! benchmarks used a different request shape (a single text, no evidence quote, no relation or referent questions) on synthetic,
//! author-labelled data. They must be re-benchmarked on this exact request before anything is enabled.

pub mod client;
pub mod consent;
pub mod protocol;
pub mod provider;
pub mod transport;

#[cfg(test)]
mod architecture_tests;
#[cfg(test)]
mod live;
#[cfg(test)]
mod tests;

#[allow(unused_imports)]
pub use client::{Diagnostics, JevClient, RetryPolicy};
#[allow(unused_imports)]
pub use consent::{ConsentState, JevConsent};
#[allow(unused_imports)]
pub use provider::{resolver_policy, JevIdentityProvider, JevLimits};
#[allow(unused_imports)]
pub use transport::{JevTransport, RawResponse, ReqwestTransport, TransportError};

use crate::identity::ClassifierFailure;

/// The only endpoint ever called.
pub const JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
/// The pinned model. Never substituted: not by `jev-latest`, not by whatever the provider answers with.
pub const JEV_MODEL: &str = "jev-1.13.0";
/// Bump this whenever `DISCLOSURE_POINTS`, the data sent, the processor or its terms change: consent given for an older disclosure no
/// longer counts and fails closed (`disclosure_is_pinned` fails until it is bumped). Consent is never migrated across versions.
/// Reviewed against the TypeSafe documents of 2026-10 (privacy policy 2025-11-19, DPA 2026-04-24, MCA 2026-09-23).
pub const DISCLOSURE_VERSION: &str = "typesafe-optin-2026-10-v1";

/// The facts a consent screen MUST present, in plain language, before a person can opt in (the screen itself is Phase 5). They state
/// only what is established: TypeSafe's published training commitment is reported as its own statement; retention and logging are
/// reported as NOT established; nothing here promises deletion, zero retention or compliance.
pub const DISCLOSURE_POINTS: [&str; 8] = [
    "To decide whether something you just captured updates an idea you already have, Arthur sends TypeSafe, a third-party AI provider, the exact words of that one idea and up to four of your existing ideas from the same project.",
    "Nothing else is sent: not your other captures, your other projects, or any other account key.",
    "TypeSafe states in its privacy policy that it will not train or fine-tune models on your input.",
    "How long TypeSafe keeps these requests, and whether it logs their contents, is not fully established in its published terms.",
    "TypeSafe hosts its service in the United States, so your text may be processed there.",
    "Turning this off, or withdrawing consent, stops future requests. It does not delete anything TypeSafe may already hold.",
    "This is off until you turn it on, and you can turn it off at any time.",
    "Having an API key does not turn it on; only your explicit choice does.",
];

/// FNV-1a over the disclosure points: pins the text to `DISCLOSURE_VERSION`.
pub fn disclosure_checksum() -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in DISCLOSURE_POINTS.join("\n").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// docs.typesafe.ai/models: input tokens only, output free. Used for accounting estimates, not for billing.
pub const PRICE_PER_INPUT_TOKEN_USD: f64 = 0.042 / 1_000_000.0;

/// Why a JEV call produced no usable classification. `Display`/`Debug` print a fixed code and nothing else: no claim or candidate text,
/// no key, no header, no provider payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JevError {
    // refused before any request
    Disabled,
    NoConsent,
    NoCredential,
    CrossProject,
    TooManyCandidates,
    InputTooLarge,
    Cancelled,
    BudgetExceeded,
    // transport and provider
    Timeout,
    Network,
    Auth,
    Rejected,
    RateLimited,
    Overloaded,
    Server,
    UnexpectedStatus,
    ResponseTooLarge,
    /// The last retryable failure persisted through every attempt.
    RetriesExhausted(&'static str),
    // answer validation (never retried: a wrong answer is not a transport failure)
    UnexpectedModel,
    Malformed(&'static str),
}

impl JevError {
    pub fn code(&self) -> &'static str {
        match self {
            JevError::Disabled => "disabled",
            JevError::NoConsent => "no_consent",
            JevError::NoCredential => "no_credential",
            JevError::CrossProject => "cross_project",
            JevError::TooManyCandidates => "too_many_candidates",
            JevError::InputTooLarge => "input_too_large",
            JevError::Cancelled => "cancelled",
            JevError::BudgetExceeded => "budget_exceeded",
            JevError::Timeout => "timeout",
            JevError::Network => "network",
            JevError::Auth => "auth",
            JevError::Rejected => "rejected",
            JevError::RateLimited => "rate_limited",
            JevError::Overloaded => "overloaded",
            JevError::Server => "server",
            JevError::UnexpectedStatus => "unexpected_status",
            JevError::ResponseTooLarge => "response_too_large",
            JevError::RetriesExhausted(_) => "retries_exhausted",
            JevError::UnexpectedModel => "unexpected_model",
            JevError::Malformed(_) => "malformed",
        }
    }

    /// Transport-level conditions worth another attempt. A disagreeing or malformed answer is NEVER retried.
    pub fn retryable(&self) -> bool {
        matches!(self, JevError::Timeout | JevError::Network | JevError::RateLimited | JevError::Overloaded | JevError::Server)
    }

    /// The coarse reason the identity pipeline records (`classifier_failed`). The precise code stays in `Diagnostics`.
    pub fn to_classifier_failure(&self) -> ClassifierFailure {
        match self {
            JevError::Timeout | JevError::RetriesExhausted("timeout") => ClassifierFailure::Timeout,
            JevError::Network | JevError::RateLimited | JevError::Overloaded | JevError::Server | JevError::RetriesExhausted(_) => ClassifierFailure::Network,
            JevError::UnexpectedModel | JevError::Malformed(_) | JevError::ResponseTooLarge | JevError::UnexpectedStatus => ClassifierFailure::Unreadable,
            _ => ClassifierFailure::Unavailable,
        }
    }
}

impl std::fmt::Display for JevError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JevError::RetriesExhausted(last) => write!(f, "retries_exhausted({last})"),
            JevError::Malformed(reason) => write!(f, "malformed({reason})"),
            other => f.write_str(other.code()),
        }
    }
}

impl std::error::Error for JevError {}
