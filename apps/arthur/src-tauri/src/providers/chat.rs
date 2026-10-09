//! One strict-JSON chat completion against an OpenAI-compatible endpoint.
//!
//! Shared by Thought Distillation and relation proposal so the wire format, redirect/credential
//! handling and refusal/truncation classification exist exactly once. This module only transports
//! text: what the answer means, and whether to trust it, is up to the caller. The model is given no tools.

use serde_json::{json, Value};

use super::credentials::CredentialSource;

pub const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";
/// Non-reasoning model with strict JSON-schema output and a deterministic temperature.
pub const DEFAULT_MODEL: &str = "gpt-4.1-mini";
/// GPT-6 Luna (official API id `gpt-6-luna`; developers.openai.com/api/docs/models/gpt-6-luna). Arthur's model for Thought Distillation
/// (effort `none`), grounded revision synthesis (effort `low`) and the Automatic Connections Stage B verifier (effort `none`).
pub const LUNA_MODEL: &str = "gpt-6-luna";
/// Listed price, dollars per token (developers.openai.com, 2026-10): $0.10 per million input, $0.50 per million output. Reasoning tokens
/// are part of `completion_tokens` and are billed as output, so they are counted in the output total. Cached-input discounts are ignored,
/// so an estimate is an upper bound.
pub const LUNA_PRICE_IN: f64 = 0.10 / 1e6;
pub const LUNA_PRICE_OUT: f64 = 0.50 / 1e6;

/// Why a completion could not be turned into a text answer. Never carries provider bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatFailure {
    NotConfigured,
    Network,
    Auth(u16),
    Provider(u16),
    Refused,
    Unreadable(String),
}

/// How the model is sampled. A non-reasoning model is made deterministic with `temperature: 0`. A reasoning model (gpt-5*, gpt-6*, o*)
/// is steered with a reasoning effort INSTEAD and is sent no sampling parameter at all: `temperature`, `top_p` and the other sampling
/// options are documented as unsupported once reasoning is on, and Arthur does not rely on them for GPT-6 Luna even at effort `none`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sampling {
    Deterministic,
    Reasoning(&'static str),
}

pub struct ChatRequest<'a> {
    pub endpoint: &'a str,
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
    pub schema_name: &'a str,
    pub schema: Value,
    pub sampling: Sampling,
    /// Upper bound on generated tokens, reasoning included (`max_completion_tokens`). `None` leaves the provider default.
    pub max_output_tokens: Option<u32>,
}

/// The exact JSON body sent for a request. Separate from the transport so the parameters (and the ones that must NOT be present) can be
/// asserted without a network.
pub fn request_body(request: &ChatRequest<'_>) -> Value {
    let mut body = json!({
        "model": request.model,
        "messages": [
            { "role": "system", "content": request.system },
            { "role": "user", "content": request.user },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": request.schema_name, "strict": true, "schema": request.schema },
        },
    });
    match request.sampling {
        Sampling::Deterministic => body["temperature"] = json!(0),
        Sampling::Reasoning(effort) => body["reasoning_effort"] = json!(effort),
    }
    if let Some(limit) = request.max_output_tokens {
        body["max_completion_tokens"] = json!(limit);
    }
    body
}

/// Whether the model that answered is the one asked for: the same id, or that id with a date snapshot suffix (`gpt-6-luna-20260922`).
/// A longer id (`gpt-6-luna-pro`, `gpt-6-lunar`) or a different family is NOT a match.
pub fn model_matches(answered: &str, requested: &str) -> bool {
    answered == requested || answered.strip_prefix(requested).and_then(|rest| rest.strip_prefix('-')).is_some_and(|date| !date.is_empty() && date.chars().all(|c| c.is_ascii_digit() || c == '-'))
}

/// What a completion carried besides its text: the model that actually answered and the token usage, when the provider reports them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub text: String,
    pub model: Option<String>,
    pub prompt_tokens: Option<u64>,
    /// Output tokens billed, reasoning included.
    pub completion_tokens: Option<u64>,
    /// The part of `completion_tokens` spent reasoning, when the provider reports it.
    pub reasoning_tokens: Option<u64>,
    /// Why generation stopped (`stop`, `length`, ...), when reported.
    pub finish_reason: Option<String>,
}

/// Test-only record of the last request's transport facts (never the text), for the live smoke tests.
#[cfg(test)]
pub mod last_call {
    use std::sync::Mutex;

    #[derive(Debug, Clone, Default)]
    pub struct CallRecord {
        pub status: Option<u16>,
        pub model: Option<String>,
        pub finish_reason: Option<String>,
        pub prompt_tokens: Option<u64>,
        pub completion_tokens: Option<u64>,
        pub reasoning_tokens: Option<u64>,
        /// The provider's own error `message` (for diagnosing a rejected request), truncated.
        pub error_message: Option<String>,
        pub error_param: Option<String>,
    }

    pub static LAST: Mutex<Option<CallRecord>> = Mutex::new(None);

    pub fn take() -> Option<CallRecord> {
        LAST.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    pub fn update(f: impl FnOnce(&mut CallRecord)) {
        let mut guard = LAST.lock().unwrap_or_else(|p| p.into_inner());
        f(guard.get_or_insert_with(CallRecord::default));
    }
}

/// Sends the request and returns the text of the model's answer.
pub async fn complete_json(client: &reqwest::Client, credentials: &dyn CredentialSource, request: ChatRequest<'_>) -> Result<String, ChatFailure> {
    complete_json_detailed(client, credentials, request).await.map(|completion| completion.text)
}

/// As `complete_json`, also returning the answering model and token usage so a caller can check it got the model it asked for and
/// account for what it spent.
pub async fn complete_json_detailed(client: &reqwest::Client, credentials: &dyn CredentialSource, request: ChatRequest<'_>) -> Result<Completion, ChatFailure> {
    let key = credentials.api_key().ok_or(ChatFailure::NotConfigured)?;
    let body = request_body(&request);

    let response = client.post(request.endpoint).bearer_auth(key.expose()).json(&body).send().await.map_err(|_| ChatFailure::Network)?;

    let status = response.status().as_u16();
    #[cfg(test)]
    last_call::update(|record| *record = last_call::CallRecord { status: Some(status), ..Default::default() });
    if status == 401 || status == 403 {
        return Err(ChatFailure::Auth(status));
    }
    if !(200..300).contains(&status) {
        #[cfg(test)]
        {
            let body: Value = response.json().await.unwrap_or(Value::Null);
            last_call::update(|record| {
                record.error_message = body.pointer("/error/message").and_then(Value::as_str).map(|m| m.chars().take(300).collect());
                record.error_param = body.pointer("/error/param").and_then(Value::as_str).map(str::to_string);
            });
        }
        return Err(ChatFailure::Provider(status));
    }

    let envelope: Value = response.json().await.map_err(|error| {
        if error.is_decode() { ChatFailure::Unreadable("unreadable response".into()) } else { ChatFailure::Network }
    })?;
    #[cfg(test)]
    last_call::update(|record| {
        record.model = envelope.get("model").and_then(Value::as_str).map(str::to_string);
        record.finish_reason = envelope.pointer("/choices/0/finish_reason").and_then(Value::as_str).map(str::to_string);
        record.prompt_tokens = envelope.pointer("/usage/prompt_tokens").and_then(Value::as_u64);
        record.completion_tokens = envelope.pointer("/usage/completion_tokens").and_then(Value::as_u64);
        record.reasoning_tokens = envelope.pointer("/usage/completion_tokens_details/reasoning_tokens").and_then(Value::as_u64);
    });
    let text = answer_text(&envelope)?;
    Ok(Completion {
        finish_reason: envelope.pointer("/choices/0/finish_reason").and_then(Value::as_str).map(str::to_string),
        text,
        model: envelope.get("model").and_then(Value::as_str).map(str::to_string),
        prompt_tokens: envelope.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
        completion_tokens: envelope.pointer("/usage/completion_tokens").and_then(Value::as_u64),
        reasoning_tokens: envelope.pointer("/usage/completion_tokens_details/reasoning_tokens").and_then(Value::as_u64),
    })
}

fn unreadable(reason: &str) -> ChatFailure {
    ChatFailure::Unreadable(reason.into())
}

/// Reads the chat-completion envelope and returns the answer text inside it.
fn answer_text(envelope: &Value) -> Result<String, ChatFailure> {
    let choice = envelope.get("choices").and_then(Value::as_array).and_then(|choices| choices.first()).ok_or_else(|| unreadable("no completion"))?;
    let message = choice.get("message").ok_or_else(|| unreadable("no message"))?;

    if message.get("refusal").is_some_and(|refusal| refusal.as_str().is_some_and(|text| !text.is_empty())) {
        return Err(ChatFailure::Refused);
    }
    match choice.get("finish_reason").and_then(Value::as_str) {
        Some("content_filter") => return Err(ChatFailure::Refused),
        Some("length") => return Err(unreadable("the answer was cut off")),
        _ => {}
    }
    message.get("content").and_then(Value::as_str).map(str::to_string).ok_or_else(|| unreadable("no content"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(model: &'static str, sampling: Sampling, limit: Option<u32>) -> Value {
        request_body(&ChatRequest { endpoint: "http://x", model, system: "s", user: "u", schema_name: "n", schema: json!({ "type": "object" }), sampling, max_output_tokens: limit })
    }

    #[test]
    fn a_luna_request_sets_the_effort_and_the_output_budget_and_never_a_sampling_parameter() {
        for (effort, limit) in [("none", 4096u32), ("low", 8192)] {
            let body = request(LUNA_MODEL, Sampling::Reasoning(effort), Some(limit));
            assert_eq!((body["model"].as_str(), body["reasoning_effort"].as_str(), body["max_completion_tokens"].as_u64()), (Some("gpt-6-luna"), Some(effort), Some(u64::from(limit))));
            for unsupported in ["temperature", "top_p", "logprobs", "top_logprobs", "presence_penalty", "frequency_penalty", "max_tokens", "tools", "functions"] {
                assert!(body.get(unsupported).is_none(), "effort {effort}: {unsupported} must not be sent");
            }
            assert_eq!((body["response_format"]["type"].as_str(), body["response_format"]["json_schema"]["strict"].as_bool()), (Some("json_schema"), Some(true)), "structured output is preserved");
        }
    }

    #[test]
    fn the_non_reasoning_models_that_remain_are_requested_exactly_as_before() {
        let body = request(DEFAULT_MODEL, Sampling::Deterministic, None);
        assert_eq!((body["model"].as_str(), body["temperature"].as_i64()), (Some("gpt-4.1-mini"), Some(0)));
        assert!(body.get("reasoning_effort").is_none() && body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn only_the_requested_model_or_its_dated_snapshot_matches() {
        for ok in ["gpt-6-luna", "gpt-6-luna-20260922", "gpt-6-luna-2026-09-22"] {
            assert!(model_matches(ok, LUNA_MODEL), "{ok}");
        }
        for bad in ["", "gpt-6", "gpt-6-lunar", "gpt-6-luna-pro", "gpt-6-luna-", "gpt-6-luna-mini-20260922", "GPT-6-LUNA", "gpt-5-mini", "gpt-4.1-mini", " gpt-6-luna"] {
            assert!(!model_matches(bad, LUNA_MODEL), "{bad:?}");
        }
    }

    #[test]
    fn luna_pricing_is_the_listed_price_and_the_old_models_are_not_the_luna_default() {
        assert!((LUNA_PRICE_IN * 1e6 - 0.10).abs() < 1e-12 && (LUNA_PRICE_OUT * 1e6 - 0.50).abs() < 1e-12);
        assert_eq!((LUNA_MODEL, DEFAULT_MODEL), ("gpt-6-luna", "gpt-4.1-mini"));
    }

    #[test]
    fn extracts_the_answer_text() {
        let envelope = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "{\"a\":1}", "refusal": null } }] });
        assert_eq!(answer_text(&envelope).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn classifies_refusals_truncation_and_broken_envelopes() {
        let refusal = json!({ "choices": [{ "message": { "content": null, "refusal": "no" } }] });
        assert_eq!(answer_text(&refusal), Err(ChatFailure::Refused));
        let filtered = json!({ "choices": [{ "finish_reason": "content_filter", "message": { "content": "" } }] });
        assert_eq!(answer_text(&filtered), Err(ChatFailure::Refused));
        for broken in [
            json!({ "choices": [{ "finish_reason": "length", "message": { "content": "x" } }] }),
            json!({ "choices": [] }),
            json!({}),
            json!({ "choices": [{ "message": { "content": null } }] }),
            json!({ "choices": [{}] }),
        ] {
            assert!(matches!(answer_text(&broken), Err(ChatFailure::Unreadable(_))), "{broken}");
        }
    }
}
