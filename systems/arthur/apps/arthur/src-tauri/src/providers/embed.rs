//! Text embeddings behind a provider abstraction.
//!
//! Recall depends on `EmbeddingProvider`, never on OpenAI. The first implementation is OpenAI `text-embedding-3-small` at 512
//! dimensions; a local embedder is a second implementation with its own `ModelKey` and changes nothing else.
//!
//! Embeddings are an INDEX of the Cognitive Store, never its source of truth, and they are OPT-IN: whoever calls `embed` is
//! responsible for having checked the user's consent first (see `recall::settings`). This module only transports text and
//! validates what comes back. It never logs text and never carries a provider body in an error.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::credentials::CredentialSource;
use super::http;
use crate::async_util::BoxFuture;

pub const DEFAULT_ENDPOINT: &str = "https://api.openai.com/v1/embeddings";
pub const OPENAI_MODEL: &str = "text-embedding-3-small";
pub const OPENAI_DIMS: usize = 512;
/// Bumped when OUR embedded-text template changes, so old vectors become incompatible.
pub const TEMPLATE_VERSION: &str = "v1";
/// Provider limit we stay well inside of (inputs per request).
pub const MAX_BATCH: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Identity of an embedding space: provider, model, dimensions and our template version. Two vectors are comparable only if
/// their keys are equal; any difference makes stored vectors incompatible (ignored, and rebuildable), never silently mixed.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelKey(String);

impl ModelKey {
    pub fn new(provider: &str, model: &str, dims: usize, version: &str) -> Self {
        ModelKey(format!("{provider}:{model}:{dims}:{version}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ModelKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// What the text is for. OpenAI has no asymmetric mode; a future local model (e5-style prefixes) may.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedPurpose {
    Document,
    Query,
}

/// Why embedding failed. Never carries provider bodies, keys or text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedFailure {
    NotConfigured,
    Network,
    Auth(u16),
    Provider(u16),
    Unreadable(String),
}

impl fmt::Display for EmbedFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EmbedFailure::NotConfigured => f.write_str("the embedding provider is not configured"),
            EmbedFailure::Network => f.write_str("could not reach the embedding provider"),
            EmbedFailure::Auth(status) => write!(
                f,
                "the embedding provider rejected the credentials (HTTP {status})"
            ),
            EmbedFailure::Provider(status) => {
                write!(f, "the embedding provider failed (HTTP {status})")
            }
            EmbedFailure::Unreadable(reason) => {
                write!(f, "the embedding response was unusable ({reason})")
            }
        }
    }
}

pub trait EmbeddingProvider: Send + Sync {
    fn model_key(&self) -> &ModelKey;
    fn dims(&self) -> usize;
    fn max_batch(&self) -> usize {
        MAX_BATCH
    }
    /// One vector per input text, in order, each of `dims()` finite values, L2-normalised.
    fn embed<'a>(
        &'a self,
        texts: &'a [String],
        purpose: EmbedPurpose,
    ) -> BoxFuture<'a, Result<Vec<Vec<f32>>, EmbedFailure>>;
}

/// The text that represents one object. It deliberately contains no project, relation or provenance, so moving an object
/// never invalidates its vector.
pub fn embedding_text(kind: &str, title: &str, body: &str) -> String {
    format!("{kind}: {title}\n{body}")
}

/// 64-bit FNV-1a, hex. Stable across platforms and releases (unlike `DefaultHasher`); used only to notice identical text.
pub fn text_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// L2-normalises in place. Returns false for a zero or non-finite vector.
pub fn normalize(vector: &mut [f32]) -> bool {
    let norm = vector
        .iter()
        .map(|v| f64::from(*v) * f64::from(*v))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return false;
    }
    for value in vector.iter_mut() {
        *value = (f64::from(*value) / norm) as f32;
    }
    vector.iter().all(|v| v.is_finite())
}

pub struct OpenAiEmbedder {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    dims: usize,
    key: ModelKey,
    credentials: Arc<dyn CredentialSource>,
}

impl fmt::Debug for OpenAiEmbedder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiEmbedder")
            .field("endpoint", &self.endpoint)
            .field("model", &self.model)
            .field("dims", &self.dims)
            .finish_non_exhaustive()
    }
}

impl OpenAiEmbedder {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Result<Self, reqwest::Error> {
        Self::with_endpoint(credentials, DEFAULT_ENDPOINT, OPENAI_MODEL, OPENAI_DIMS)
    }

    pub fn with_endpoint(
        credentials: Arc<dyn CredentialSource>,
        endpoint: &str,
        model: &str,
        dims: usize,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: http::client(REQUEST_TIMEOUT)?,
            endpoint: endpoint.to_string(),
            model: model.to_string(),
            dims,
            key: ModelKey::new("openai", model, dims, TEMPLATE_VERSION),
            credentials,
        })
    }

    async fn request(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedFailure> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let key = self
            .credentials
            .api_key()
            .ok_or(EmbedFailure::NotConfigured)?;
        let body = json!({ "model": self.model, "input": texts, "dimensions": self.dims, "encoding_format": "float" });
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(key.expose())
            .json(&body)
            .send()
            .await
            .map_err(|_| EmbedFailure::Network)?;
        let status = response.status().as_u16();
        if status == 401 || status == 403 {
            return Err(EmbedFailure::Auth(status));
        }
        if !(200..300).contains(&status) {
            return Err(EmbedFailure::Provider(status));
        }
        let envelope: Value = response.json().await.map_err(|error| {
            if error.is_decode() {
                EmbedFailure::Unreadable("not JSON".into())
            } else {
                EmbedFailure::Network
            }
        })?;
        parse_embeddings(&envelope, texts.len(), self.dims)
    }
}

/// Reads the `data` array, orders it by `index`, and insists on exactly `count` vectors of `dims` finite, normalisable values.
pub fn parse_embeddings(
    envelope: &Value,
    count: usize,
    dims: usize,
) -> Result<Vec<Vec<f32>>, EmbedFailure> {
    let unreadable = |reason: &str| EmbedFailure::Unreadable(reason.into());
    let data = envelope
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| unreadable("no data"))?;
    if data.len() != count {
        return Err(unreadable("wrong number of vectors"));
    }
    let mut slots: Vec<Option<Vec<f32>>> = vec![None; count];
    for item in data {
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .ok_or_else(|| unreadable("no index"))? as usize;
        let values = item
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| unreadable("no embedding"))?;
        if index >= count || slots[index].is_some() || values.len() != dims {
            return Err(unreadable("unexpected vector"));
        }
        let mut vector = Vec::with_capacity(dims);
        for value in values {
            let number = value
                .as_f64()
                .ok_or_else(|| unreadable("non-numeric value"))?;
            vector.push(number as f32);
        }
        if !normalize(&mut vector) {
            return Err(unreadable("degenerate vector"));
        }
        slots[index] = Some(vector);
    }
    slots
        .into_iter()
        .map(|slot| slot.ok_or_else(|| unreadable("missing vector")))
        .collect()
}

impl EmbeddingProvider for OpenAiEmbedder {
    fn model_key(&self) -> &ModelKey {
        &self.key
    }

    fn dims(&self) -> usize {
        self.dims
    }

    fn embed<'a>(
        &'a self,
        texts: &'a [String],
        _purpose: EmbedPurpose,
    ) -> BoxFuture<'a, Result<Vec<Vec<f32>>, EmbedFailure>> {
        Box::pin(self.request(texts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::credentials::ApiKey;
    use crate::test_support::{dead_endpoint, find, serve_once};

    struct FixedKey(Option<&'static str>);
    impl CredentialSource for FixedKey {
        fn api_key(&self) -> Option<ApiKey> {
            self.0.and_then(ApiKey::parse)
        }
    }

    const PATH: &str = "/v1/embeddings";

    fn embedder(url: &str, key: Option<&'static str>, dims: usize) -> OpenAiEmbedder {
        OpenAiEmbedder::with_endpoint(Arc::new(FixedKey(key)), url, OPENAI_MODEL, dims).unwrap()
    }

    fn response(vectors: &[Vec<f64>]) -> String {
        let data: Vec<Value> = vectors
            .iter()
            .enumerate()
            .map(|(index, v)| json!({ "object": "embedding", "index": index, "embedding": v }))
            .collect();
        json!({ "object": "list", "data": data }).to_string()
    }

    fn run(embedder: &OpenAiEmbedder, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedFailure> {
        let texts: Vec<String> = texts.iter().map(|t| t.to_string()).collect();
        tauri::async_runtime::block_on(embedder.embed(&texts, EmbedPurpose::Document))
    }

    #[test]
    fn model_keys_name_provider_model_dimensions_and_template_version() {
        let provider = embedder("http://x", Some("k"), 512);
        assert_eq!(
            provider.model_key().as_str(),
            "openai:text-embedding-3-small:512:v1"
        );
        assert_ne!(
            ModelKey::new("openai", OPENAI_MODEL, 1536, "v1"),
            *provider.model_key()
        );
        assert_eq!(provider.dims(), 512);
    }

    #[test]
    fn sends_the_documented_request_and_returns_normalised_vectors_in_input_order() {
        // The provider answers out of order; the result must follow the request order.
        let body = json!({ "data": [ { "index": 1, "embedding": [0.0, 2.0] }, { "index": 0, "embedding": [3.0, 4.0] } ] }).to_string();
        let (url, request) = serve_once(PATH, "200 OK", body);
        let vectors = run(
            &embedder(&url, Some("sk-test-key"), 2),
            &["first", "second"],
        )
        .unwrap();
        assert!((vectors[0][0] - 0.6).abs() < 1e-6 && (vectors[0][1] - 0.8).abs() < 1e-6);
        assert!((vectors[1][0]).abs() < 1e-6 && (vectors[1][1] - 1.0).abs() < 1e-6);

        let raw = request.recv().unwrap();
        let wire = String::from_utf8_lossy(&raw).to_string();
        assert!(wire.starts_with(&format!("POST {PATH} ")));
        assert!(wire
            .to_lowercase()
            .contains("authorization: bearer sk-test-key"));
        let sent: Value =
            serde_json::from_str(&wire[find(&raw, b"\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(sent["model"], OPENAI_MODEL);
        assert_eq!(sent["dimensions"], 2);
        assert_eq!(sent["input"], json!(["first", "second"]));
        assert!(sent.get("tools").is_none());
    }

    #[test]
    fn without_a_credential_it_fails_before_touching_the_network() {
        let url = dead_endpoint(PATH);
        assert_eq!(
            run(&embedder(&url, None, 2), &["x"]),
            Err(EmbedFailure::NotConfigured)
        );
    }

    #[test]
    fn classifies_provider_failures_without_leaking_bodies() {
        let (url, _r) = serve_once(
            PATH,
            "401 Unauthorized",
            "{\"error\":\"secret-detail\"}".into(),
        );
        assert_eq!(
            run(&embedder(&url, Some("k"), 2), &["x"]),
            Err(EmbedFailure::Auth(401))
        );
        let (url, _r) = serve_once(PATH, "500 Internal Server Error", "boom".into());
        assert_eq!(
            run(&embedder(&url, Some("k"), 2), &["x"]),
            Err(EmbedFailure::Provider(500))
        );
        let url = dead_endpoint(PATH);
        assert_eq!(
            run(&embedder(&url, Some("k"), 2), &["x"]),
            Err(EmbedFailure::Network)
        );
        assert!(!EmbedFailure::Provider(500).to_string().contains("boom"));
    }

    #[test]
    fn rejects_untrustworthy_responses() {
        for bad in [
            json!({ "data": [] }),
            json!({ "data": [ { "index": 0, "embedding": [1.0] } ] }), // wrong dims
            json!({ "data": [ { "index": 0, "embedding": [0.0, 0.0] } ] }), // zero vector
            json!({ "data": [ { "index": 0, "embedding": ["a", 1.0] } ] }), // non-numeric
            json!({ "data": [ { "index": 3, "embedding": [1.0, 1.0] } ] }), // index out of range
            json!({ "data": [ { "index": 0, "embedding": [1.0, 1.0] }, { "index": 0, "embedding": [1.0, 1.0] } ] }),
            json!({}),
        ] {
            let count = if bad["data"].as_array().is_some_and(|a| a.len() == 2) {
                2
            } else {
                1
            };
            assert!(
                matches!(
                    parse_embeddings(&bad, count, 2),
                    Err(EmbedFailure::Unreadable(_))
                ),
                "{bad}"
            );
        }
        assert!(parse_embeddings(
            &json!({ "data": [ { "index": 0, "embedding": [1.0, 0.0] } ] }),
            1,
            2
        )
        .is_ok());
    }

    #[test]
    fn embedding_text_has_no_project_and_the_hash_is_stable() {
        assert_eq!(embedding_text("idea", "T", "B"), "idea: T\nB");
        assert_eq!(text_hash("idea: T\nB"), text_hash("idea: T\nB"));
        assert_ne!(text_hash("a"), text_hash("b"));
        assert_eq!(text_hash(""), "cbf29ce484222325");
        let unused = response(&[]);
        assert!(unused.contains("data"));
    }
}
