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

/// How the model is sampled. A non-reasoning model is made deterministic with `temperature: 0`; a reasoning
/// model rejects that parameter and is steered with a reasoning effort instead.
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
}

/// What a completion carried besides its text: the model that actually answered and the token usage, when the provider reports them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub text: String,
    pub model: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
}

/// Sends the request and returns the text of the model's answer.
pub async fn complete_json(client: &reqwest::Client, credentials: &dyn CredentialSource, request: ChatRequest<'_>) -> Result<String, ChatFailure> {
    complete_json_detailed(client, credentials, request).await.map(|completion| completion.text)
}

/// As `complete_json`, also returning the answering model and token usage so a caller can check it got the model it asked for and
/// account for what it spent.
pub async fn complete_json_detailed(client: &reqwest::Client, credentials: &dyn CredentialSource, request: ChatRequest<'_>) -> Result<Completion, ChatFailure> {
    let key = credentials.api_key().ok_or(ChatFailure::NotConfigured)?;

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

    let response = client.post(request.endpoint).bearer_auth(key.expose()).json(&body).send().await.map_err(|_| ChatFailure::Network)?;

    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err(ChatFailure::Auth(status));
    }
    if !(200..300).contains(&status) {
        return Err(ChatFailure::Provider(status));
    }

    let envelope: Value = response.json().await.map_err(|error| {
        if error.is_decode() { ChatFailure::Unreadable("unreadable response".into()) } else { ChatFailure::Network }
    })?;
    let text = answer_text(&envelope)?;
    Ok(Completion {
        text,
        model: envelope.get("model").and_then(Value::as_str).map(str::to_string),
        prompt_tokens: envelope.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
        completion_tokens: envelope.pointer("/usage/completion_tokens").and_then(Value::as_u64),
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
