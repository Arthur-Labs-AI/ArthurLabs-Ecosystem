//! The revision verifier backed by GPT-6 Luna through Arthur's shared OpenAI chat boundary (`providers::chat`).
//!
//! **THIS IS NOT AN INDEPENDENT VERIFIER.** The synthesizer is also GPT-6 Luna. A model reviewing its own family's draft shares its blind
//! spots, so a `Pass` here is a same-family self-check (`VerificationMode::SameFamilyReview`), never an independent confirmation, and the
//! stage never lets such a pass apply a revision on its own (it is held for a person's approval). The adapter reports family `gpt` so the
//! stage's independence guard sees the truth; replacing it with a model of another family later needs no change to the pipeline.
//!
//! CONFIGURATION: model `gpt-6-luna` (exact id or dated snapshot is accepted, anything else is `InvalidResponse`), reasoning effort `none`,
//! strict JSON-schema output, at most 1 500 output tokens, 14 000 characters of input, two attempts for transport failures only, two
//! concurrent requests. No sampling parameter is sent. Expected cost is about $0.0002 per check at the listed Luna prices.
//!
//! SAFETY: needs the shared OpenAI credential AND its own `Purpose::Verification` authorization (not implied by the key, by synthesis
//! authorization, or by anything else). Nothing is sent otherwise. A cancel abandons a request already in flight. Everything but a complete,
//! self-consistent verdict is `Unavailable`. Nothing is logged: errors and `Debug` carry fixed codes only.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;

use super::authorization::ProviderAuthorization;
use super::verdict::{parse_verdict, response_schema, user_message, SYSTEM_PROMPT};
use super::{ModelIdentity, RevisionVerifier, UnavailableReason, Verdict, VerifyRequest};
use crate::async_util::BoxFuture;
use crate::providers::chat::{
    complete_json_detailed, model_matches, ChatFailure, ChatRequest, Completion, Sampling,
    DEFAULT_ENDPOINT, LUNA_MODEL, LUNA_PRICE_IN, LUNA_PRICE_OUT,
};
use crate::providers::credentials::CredentialSource;

pub const MODEL: &str = LUNA_MODEL;
pub const FAMILY: &str = "gpt";
const REASONING_EFFORT: &str = "none";
const MAX_OUTPUT_TOKENS: u32 = 1_500;
pub const MAX_INPUT_CHARS: usize = 14_000;
const MAX_OUTPUT_CHARS: usize = 4_000;
const MAX_ATTEMPTS: u32 = 2;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct VerifierUsage {
    pub requests: u64,
    pub retries: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: u64,
    pub estimated_cost_usd: f64,
    pub failures: BTreeMap<&'static str, u64>,
}

pub struct OpenAiRevisionVerifier {
    client: reqwest::Client,
    endpoint: String,
    credential: Arc<dyn CredentialSource>,
    authorization: Arc<ProviderAuthorization>,
    permits: Arc<Semaphore>,
    cancel: Arc<AtomicBool>,
    usage: Mutex<VerifierUsage>,
    timeout: Duration,
    backoff: Duration,
    attempts: u32,
}

impl std::fmt::Debug for OpenAiRevisionVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpenAiRevisionVerifier(<redacted>)")
    }
}

impl OpenAiRevisionVerifier {
    pub fn new(
        credential: Arc<dyn CredentialSource>,
        authorization: Arc<ProviderAuthorization>,
        timeout: Duration,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: crate::providers::http::client(timeout)?,
            endpoint: DEFAULT_ENDPOINT.to_string(),
            credential,
            authorization,
            permits: Arc::new(Semaphore::new(2)),
            cancel: Arc::new(AtomicBool::new(false)),
            usage: Mutex::new(VerifierUsage::default()),
            timeout,
            backoff: Duration::from_millis(500),
            attempts: MAX_ATTEMPTS,
        })
    }

    /// Tests only: a localhost endpoint and no waiting between attempts.
    #[cfg(test)]
    pub fn for_test(
        credential: Arc<dyn CredentialSource>,
        authorization: Arc<ProviderAuthorization>,
        endpoint: String,
        timeout: Duration,
    ) -> Self {
        let mut me = Self::new(credential, authorization, timeout).expect("client");
        me.endpoint = endpoint;
        me.backoff = Duration::ZERO;
        me
    }

    /// Tests only: never retry.
    #[cfg(test)]
    pub fn single_attempt(mut self) -> Self {
        self.attempts = 1;
        self
    }

    /// Stops new requests AND abandons one that is already in flight.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn usage(&self) -> VerifierUsage {
        self.usage.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn fail(&self, code: &'static str) {
        *self
            .usage
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .failures
            .entry(code)
            .or_insert(0) += 1;
    }

    /// One attempt, abandoned if `cancel()` is called or the timeout passes while it is in flight.
    async fn attempt(
        &self,
        user: &str,
    ) -> Result<Completion, Result<ChatFailure, UnavailableReason>> {
        let call = complete_json_detailed(
            &self.client,
            self.credential.as_ref(),
            ChatRequest {
                endpoint: &self.endpoint,
                model: MODEL,
                system: SYSTEM_PROMPT,
                user,
                schema_name: "revision_verdict",
                schema: response_schema(),
                sampling: Sampling::Reasoning(REASONING_EFFORT),
                max_output_tokens: Some(MAX_OUTPUT_TOKENS),
            },
        );
        let mut call = Box::pin(call);
        let started = Instant::now();
        loop {
            match tokio::time::timeout(Duration::from_millis(25), &mut call).await {
                Ok(result) => return result.map_err(Ok),
                Err(_) => {
                    if self.cancel.load(Ordering::SeqCst) {
                        return Err(Err(UnavailableReason::Cancelled));
                    }
                    if started.elapsed() > self.timeout {
                        return Err(Err(UnavailableReason::Timeout));
                    }
                }
            }
        }
    }

    fn read(&self, completion: Completion) -> Verdict {
        {
            let mut usage = self.usage.lock().unwrap_or_else(|p| p.into_inner());
            usage.prompt_tokens += completion.prompt_tokens.unwrap_or(0);
            usage.completion_tokens += completion.completion_tokens.unwrap_or(0);
            usage.reasoning_tokens += completion.reasoning_tokens.unwrap_or(0);
            usage.estimated_cost_usd = usage.prompt_tokens as f64 * LUNA_PRICE_IN
                + usage.completion_tokens as f64 * LUNA_PRICE_OUT;
        }
        let invalid = |code: &'static str| {
            self.fail(code);
            Verdict::Unavailable(UnavailableReason::InvalidResponse)
        };
        if !completion
            .model
            .as_deref()
            .is_some_and(|m| model_matches(m, MODEL))
        {
            return invalid("model_mismatch");
        }
        if completion.finish_reason.as_deref() != Some("stop") {
            return invalid("not_finished");
        }
        let text = completion.text.trim();
        if text.is_empty() || text.chars().count() > MAX_OUTPUT_CHARS {
            return invalid("empty_or_oversized");
        }
        parse_verdict(text).unwrap_or_else(|_| invalid("bad_verdict"))
    }

    async fn verify_inner(&self, request: &VerifyRequest) -> Verdict {
        if self.cancel.load(Ordering::SeqCst) {
            return Verdict::Unavailable(UnavailableReason::Cancelled);
        }
        if !self.authorization.granted() {
            self.fail("not_authorized");
            return Verdict::Unavailable(UnavailableReason::NotAuthorized);
        }
        if self.credential.api_key().is_none() {
            self.fail("no_credential");
            return Verdict::Unavailable(UnavailableReason::NotConfigured);
        }
        let user = user_message(request);
        if user.chars().count() > MAX_INPUT_CHARS {
            self.fail("input_too_large");
            return Verdict::Unavailable(UnavailableReason::InvalidResponse);
        }
        for attempt in 1..=self.attempts {
            {
                let mut usage = self.usage.lock().unwrap_or_else(|p| p.into_inner());
                usage.requests += 1;
                if attempt > 1 {
                    usage.retries += 1;
                }
            }
            let outcome = {
                let Ok(_permit) = self.permits.acquire().await else {
                    return Verdict::Unavailable(UnavailableReason::Cancelled);
                };
                self.attempt(&user).await
            };
            let (reason, retryable) = match outcome {
                Ok(completion) => return self.read(completion),
                Err(Err(UnavailableReason::Cancelled)) => {
                    return Verdict::Unavailable(UnavailableReason::Cancelled)
                }
                Err(Err(reason)) => (reason, true),
                Err(Ok(ChatFailure::NotConfigured)) => (UnavailableReason::NotConfigured, false),
                Err(Ok(ChatFailure::Auth(_))) => (UnavailableReason::Provider, false),
                Err(Ok(ChatFailure::Refused | ChatFailure::Unreadable(_))) => {
                    (UnavailableReason::InvalidResponse, false)
                }
                Err(Ok(ChatFailure::Network)) => (UnavailableReason::Provider, true),
                Err(Ok(ChatFailure::Provider(status))) => {
                    (UnavailableReason::Provider, status == 429 || status >= 500)
                }
            };
            self.fail(match reason {
                UnavailableReason::Timeout => "timeout",
                UnavailableReason::InvalidResponse => "invalid_response",
                UnavailableReason::NotConfigured => "no_credential",
                _ => "provider",
            });
            if !retryable || attempt == self.attempts {
                return Verdict::Unavailable(reason);
            }
            tokio::time::sleep(self.backoff * 2u32.pow(attempt - 1)).await;
        }
        Verdict::Unavailable(UnavailableReason::Provider)
    }
}

impl RevisionVerifier for OpenAiRevisionVerifier {
    fn identity(&self) -> ModelIdentity {
        ModelIdentity {
            provider: "openai",
            family: FAMILY,
            model: MODEL.to_string(),
        }
    }

    fn available(&self) -> bool {
        self.credential.api_key().is_some()
    }

    fn verify<'a>(&'a self, request: &'a VerifyRequest) -> BoxFuture<'a, Verdict> {
        Box::pin(self.verify_inner(request))
    }
}
