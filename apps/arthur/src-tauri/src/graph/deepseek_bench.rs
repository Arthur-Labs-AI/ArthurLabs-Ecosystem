//! Benchmark-only DeepSeek transport for model A/B comparisons (multiclass Stage A / Stage B, exactly the production prompts and parsers). NOT part of the product: compiled only under `cfg(test)`, it changes no
//! provider registry, no credential architecture and no production prompt.
//!
//! The relation prompts, schemas, parsers and admission rules are the production ones. The only difference on the wire is forced by the
//! provider: DeepSeek offers JSON mode (`json_object`) and no strict `json_schema`, so the SAME schema the production request sends is
//! appended to the system message as an output-format block, and the parsers (which already reject anything off-contract) run unchanged.
//! The key is read from `DEEPSEEK_API_KEY` at request time and never logged.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::openai::{parse_candidates, parse_verdicts};
use super::prompt::{focus_system_prompt, focused_user_message, response_schema, system_prompt, user_message};
use super::verify::{Presentation, RelationVerifier, Verdict, VerifyCandidate};
use super::verify_prompt;
use super::{RelationCandidate, RelationError, RelationProposer};
use crate::async_util::BoxFuture;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::Relation;

pub const ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
/// `deepseek-flash` is reported by the provider's /models as "DeepSeek-V4.1-Flash".
pub const MODEL: &str = "deepseek-flash";

#[derive(Default)]
pub struct Meter {
    pub requests: AtomicU64,
    pub prompt_tokens: AtomicU64,
    pub completion_tokens: AtomicU64,
    pub reasoning_tokens: AtomicU64,
    pub cache_hit_tokens: AtomicU64,
    pub millis: AtomicU64,
    /// Transport retries (dropped connections, 429, 5xx) that were absorbed before reaching the pipeline.
    pub retries: AtomicU64,
}

pub struct DeepSeek {
    client: reqwest::Client,
    pub meter: Meter,
}

impl DeepSeek {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { client: crate::providers::http::client(Duration::from_secs(300)).unwrap(), meter: Meter::default() })
    }

    async fn complete(&self, system: &str, user: &str, schema: Value) -> Result<String, RelationError> {
        let key = std::env::var("DEEPSEEK_API_KEY").map_err(|_| RelationError::NotConfigured)?;
        let system = format!("{system}\n\nOUTPUT FORMAT: reply with ONE JSON object and nothing else (no markdown, no prose). It must validate against this JSON Schema:\n{schema}");
        let body = json!({
            "model": MODEL,
            "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
            "response_format": { "type": "json_object" },
            "temperature": 0,
        });
        let started = Instant::now();
        // Transport only: a dropped connection, 429 or 5xx is retried (at most 3 attempts, short backoff) BEFORE it reaches the
        // pipeline. Anything still failing after that is reported as a provider failure and contaminates the run, as before.
        let mut attempt = 0;
        let response = loop {
            attempt += 1;
            match self.client.post(ENDPOINT).bearer_auth(&key).json(&body).send().await {
                Ok(response) if response.status().as_u16() == 429 || response.status().is_server_error() => {
                    if attempt >= 3 {
                        break Ok(response);
                    }
                }
                Ok(response) => break Ok(response),
                Err(_) if attempt >= 3 => break Err(()),
                Err(_) => {}
            }
            self.meter.retries.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
        }
        .map_err(|_| RelationError::Network)?;
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            return Err(RelationError::Auth(status));
        }
        if !(200..300).contains(&status) {
            return Err(RelationError::Provider(status));
        }
        let envelope: Value = response.json().await.map_err(|_| RelationError::InvalidOutput("unreadable response".into()))?;
        let m = &self.meter;
        m.requests.fetch_add(1, Ordering::SeqCst);
        m.millis.fetch_add(started.elapsed().as_millis() as u64, Ordering::SeqCst);
        let usage = &envelope["usage"];
        m.prompt_tokens.fetch_add(usage["prompt_tokens"].as_u64().unwrap_or(0), Ordering::SeqCst);
        m.completion_tokens.fetch_add(usage["completion_tokens"].as_u64().unwrap_or(0), Ordering::SeqCst);
        m.reasoning_tokens.fetch_add(usage["completion_tokens_details"]["reasoning_tokens"].as_u64().unwrap_or(0), Ordering::SeqCst);
        m.cache_hit_tokens.fetch_add(usage["prompt_cache_hit_tokens"].as_u64().unwrap_or(0), Ordering::SeqCst);
        let choice = &envelope["choices"][0];
        if choice["finish_reason"] == "length" {
            return Err(RelationError::InvalidOutput("the answer was cut off".into()));
        }
        choice["message"]["content"].as_str().map(str::to_string).ok_or_else(|| RelationError::InvalidOutput("no content".into()))
    }
}

pub struct DeepSeekProposer(pub Arc<DeepSeek>);
pub struct DeepSeekVerifier(pub Arc<DeepSeek>);

impl RelationProposer for DeepSeekProposer {
    fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
        Box::pin(async move { parse_candidates(&self.0.complete(&system_prompt(), &user_message(objects, existing), response_schema()).await?) })
    }

    fn propose_for<'a>(&'a self, focus_id: &'a str, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
        Box::pin(async move { parse_candidates(&self.0.complete(&focus_system_prompt(), &focused_user_message(objects, existing, focus_id), response_schema()).await?) })
    }
}

impl RelationVerifier for DeepSeekVerifier {
    fn verify<'a>(&'a self, candidates: &'a [VerifyCandidate], presentation: Presentation) -> BoxFuture<'a, Result<Vec<Verdict>, RelationError>> {
        Box::pin(async move {
            let content = self.0.complete(&verify_prompt::system_prompt(), &verify_prompt::user_message(candidates, presentation), verify_prompt::response_schema()).await?;
            parse_verdicts(&content, candidates, presentation)
        })
    }
}
