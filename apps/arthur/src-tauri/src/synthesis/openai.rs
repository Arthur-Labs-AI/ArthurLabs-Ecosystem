//! The real synthesis adapter: OpenAI chat completions with strict JSON-schema output, through Arthur's shared `providers::chat`.
//!
//! MODEL: GPT-6 Luna (`gpt-6-luna`) with reasoning effort `low`. A reasoning request carries NO sampling parameter (no `temperature`, no
//! `top_p`); the strict JSON schema, the deterministic validation and the verifier are what bound the output. The answering model reported
//! by the provider must be the requested id (or that id with a date snapshot); anything else is `ModelMismatch`, is not retried, and
//! there is no fallback to another model. Its family is `gpt`: it is NOT an independent verifier of itself.
//!
//! SAFETY: it needs the shared OpenAI LLM credential AND its own `Purpose::Synthesis` authorization (not implied by the key, by AI &
//! Voice setup, or by TypeSafe consent). Nothing is sent otherwise. Input and output are bounded, requests are retried a bounded
//! number of times for transport and server failures only (never because an answer was unwanted), concurrency is bounded, a cancel
//! stops new requests, and usage is counted. Nothing is logged: errors and `Debug` carry fixed codes only.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Semaphore;

use super::authorization::ProviderAuthorization;
use super::prompt::{response_schema, user_message, SYSTEM_PROMPT};
use super::{
    Assertion, ChangeClass, ModelIdentity, RevisionSynthesizer, SynthesisDraft, SynthesisFailure,
    SynthesisRequest,
};
use crate::async_util::BoxFuture;
use crate::providers::chat::{
    complete_json_detailed, model_matches, ChatFailure, ChatRequest, Sampling, DEFAULT_ENDPOINT,
    LUNA_MODEL, LUNA_PRICE_IN, LUNA_PRICE_OUT,
};
use crate::providers::credentials::CredentialSource;

pub const MODEL: &str = LUNA_MODEL;
/// Reasoning effort `low`: synthesis weighs several sources, so it gets a little reasoning (and therefore no sampling parameters).
const REASONING_EFFORT: &str = "low";
/// Reasoning tokens count toward this, so it covers a short revision plus its reasoning; exhausting it is a typed failure, not a retry.
const MAX_OUTPUT_TOKENS: u32 = 8_192;
pub const FAMILY: &str = "gpt";
/// Characters of user message one request may carry.
pub const MAX_INPUT_CHARS: usize = 14_000;
const MAX_OUTPUT_CHARS: usize = 16_000;
const MAX_ATTEMPTS: u32 = 2;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SynthesisUsage {
    pub requests: u64,
    pub retries: u64,
    pub prompt_tokens: u64,
    /// Output tokens billed, reasoning included.
    pub completion_tokens: u64,
    /// The part of `completion_tokens` spent reasoning.
    pub reasoning_tokens: u64,
    pub estimated_cost_usd: f64,
    pub failures: BTreeMap<&'static str, u64>,
}

pub struct OpenAiRevisionSynthesizer {
    client: reqwest::Client,
    endpoint: String,
    credential: Arc<dyn CredentialSource>,
    authorization: Arc<ProviderAuthorization>,
    permits: Arc<Semaphore>,
    cancel: Arc<AtomicBool>,
    usage: Mutex<SynthesisUsage>,
    backoff: Duration,
    attempts: u32,
}

impl std::fmt::Debug for OpenAiRevisionSynthesizer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OpenAiRevisionSynthesizer(<redacted>)")
    }
}

impl OpenAiRevisionSynthesizer {
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
            usage: Mutex::new(SynthesisUsage::default()),
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

    /// Tests only: never retry (the live smoke test spends exactly one request).
    #[cfg(test)]
    pub fn single_attempt(mut self) -> Self {
        self.attempts = 1;
        self
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn usage(&self) -> SynthesisUsage {
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
}

fn parse_assertions(value: &Value) -> Result<Vec<Assertion>, SynthesisFailure> {
    let bad = SynthesisFailure::Unreadable("assertions");
    value
        .as_array()
        .ok_or(bad)?
        .iter()
        .map(|item| {
            let object = item.as_object().filter(|o| o.len() == 2).ok_or(bad)?;
            Ok(Assertion {
                text: object
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or(bad)?
                    .to_string(),
                source: object
                    .get("source")
                    .and_then(Value::as_str)
                    .ok_or(bad)?
                    .to_string(),
            })
        })
        .collect()
}

/// Strict reading of the structured answer: exactly the schema's keys, nothing else.
pub fn parse_draft(text: &str, model: String) -> Result<SynthesisDraft, SynthesisFailure> {
    if text.chars().count() > MAX_OUTPUT_CHARS {
        return Err(SynthesisFailure::Unreadable("too long"));
    }
    let value: Value =
        serde_json::from_str(text).map_err(|_| SynthesisFailure::Unreadable("not json"))?;
    let object = value
        .as_object()
        .ok_or(SynthesisFailure::Unreadable("not an object"))?;
    let keys = [
        "kind",
        "revised_body",
        "change",
        "retained",
        "added",
        "withdrawn",
    ];
    if object.len() != keys.len() || !keys.iter().all(|k| object.contains_key(*k)) {
        return Err(SynthesisFailure::Unreadable("keys"));
    }
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(SynthesisFailure::Unreadable("types"))
    };
    Ok(SynthesisDraft {
        kind: string("kind")?,
        revised_body: string("revised_body")?,
        change: ChangeClass::parse(&string("change")?)
            .ok_or(SynthesisFailure::Unreadable("change"))?,
        retained: parse_assertions(&object["retained"])?,
        added: parse_assertions(&object["added"])?,
        withdrawn: parse_assertions(&object["withdrawn"])?,
        model,
    })
}

impl RevisionSynthesizer for OpenAiRevisionSynthesizer {
    fn identity(&self) -> ModelIdentity {
        ModelIdentity {
            provider: "openai",
            family: FAMILY,
            model: MODEL.to_string(),
        }
    }

    fn synthesize<'a>(
        &'a self,
        request: &'a SynthesisRequest,
    ) -> BoxFuture<'a, Result<SynthesisDraft, SynthesisFailure>> {
        Box::pin(async move {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(SynthesisFailure::Cancelled);
            }
            if !self.authorization.granted() {
                self.fail("not_authorized");
                return Err(SynthesisFailure::Unavailable);
            }
            let user = user_message(request);
            if user.chars().count() > MAX_INPUT_CHARS {
                self.fail("input_too_large");
                return Err(SynthesisFailure::InputTooLarge);
            }
            let mut last = SynthesisFailure::Unavailable;
            for attempt in 1..=self.attempts {
                if self.cancel.load(Ordering::SeqCst) {
                    return Err(SynthesisFailure::Cancelled);
                }
                {
                    let mut usage = self.usage.lock().unwrap_or_else(|p| p.into_inner());
                    usage.requests += 1;
                    if attempt > 1 {
                        usage.retries += 1;
                    }
                }
                let outcome = {
                    let _permit = self
                        .permits
                        .acquire()
                        .await
                        .map_err(|_| SynthesisFailure::Cancelled)?;
                    complete_json_detailed(
                        &self.client,
                        self.credential.as_ref(),
                        ChatRequest {
                            endpoint: &self.endpoint,
                            model: MODEL,
                            system: SYSTEM_PROMPT,
                            user: &user,
                            schema_name: "revision_draft",
                            schema: response_schema(),
                            sampling: Sampling::Reasoning(REASONING_EFFORT),
                            max_output_tokens: Some(MAX_OUTPUT_TOKENS),
                        },
                    )
                    .await
                };
                let (failure, retryable) = match outcome {
                    Ok(completion) => {
                        {
                            let mut usage = self.usage.lock().unwrap_or_else(|p| p.into_inner());
                            usage.prompt_tokens += completion.prompt_tokens.unwrap_or(0);
                            usage.completion_tokens += completion.completion_tokens.unwrap_or(0);
                            usage.reasoning_tokens += completion.reasoning_tokens.unwrap_or(0);
                            // reasoning tokens are inside completion_tokens and billed as output
                            usage.estimated_cost_usd = usage.prompt_tokens as f64 * LUNA_PRICE_IN
                                + usage.completion_tokens as f64 * LUNA_PRICE_OUT;
                        }
                        let Some(model) = completion.model.filter(|m| model_matches(m, MODEL))
                        else {
                            self.fail("model_mismatch");
                            return Err(SynthesisFailure::ModelMismatch);
                        };
                        return parse_draft(&completion.text, model)
                            .inspect_err(|_| self.fail("unreadable"));
                    }
                    Err(ChatFailure::NotConfigured) => (SynthesisFailure::Unavailable, false),
                    Err(ChatFailure::Auth(_)) => (SynthesisFailure::Auth, false),
                    Err(ChatFailure::Refused) => (SynthesisFailure::Refused, false),
                    Err(ChatFailure::Unreadable(_)) => {
                        (SynthesisFailure::Unreadable("provider"), false)
                    }
                    Err(ChatFailure::Network) => (SynthesisFailure::Network, true),
                    Err(ChatFailure::Provider(status)) => {
                        (SynthesisFailure::Network, status == 429 || status >= 500)
                    }
                };
                self.fail(match failure {
                    SynthesisFailure::Unavailable => "unavailable",
                    SynthesisFailure::Auth => "auth",
                    SynthesisFailure::Refused => "refused",
                    SynthesisFailure::Unreadable(_) => "unreadable",
                    _ => "network",
                });
                last = failure;
                if !retryable {
                    return Err(failure);
                }
                if attempt < self.attempts {
                    tokio::time::sleep(self.backoff * 2u32.pow(attempt - 1)).await;
                }
            }
            Err(last)
        })
    }
}
