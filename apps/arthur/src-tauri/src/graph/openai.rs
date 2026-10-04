use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::async_util::BoxFuture;
use crate::providers::chat::{self, ChatRequest, DEFAULT_ENDPOINT, DEFAULT_MODEL};
use crate::providers::credentials::CredentialSource;
use crate::providers::http;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::Relation;

use super::prompt::{response_schema, user_message, SYSTEM_PROMPT};
use super::{RelationCandidate, RelationError, RelationProposer};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

pub struct OpenAiRelationProposer {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    credentials: Arc<dyn CredentialSource>,
}

impl OpenAiRelationProposer {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Result<Self, reqwest::Error> {
        Self::with_endpoint(credentials, DEFAULT_ENDPOINT, DEFAULT_MODEL)
    }

    pub fn with_endpoint(credentials: Arc<dyn CredentialSource>, endpoint: &str, model: &str) -> Result<Self, reqwest::Error> {
        Ok(Self { client: http::client(REQUEST_TIMEOUT)?, endpoint: endpoint.to_string(), model: model.to_string(), credentials })
    }

    async fn request(&self, objects: &[KnowledgeObject], existing: &[Relation]) -> Result<Vec<RelationCandidate>, RelationError> {
        let user = user_message(objects, existing);
        let content = chat::complete_json(
            &self.client,
            self.credentials.as_ref(),
            ChatRequest { endpoint: &self.endpoint, model: &self.model, system: SYSTEM_PROMPT, user: &user, schema_name: "relations", schema: response_schema() },
        )
        .await?;
        parse_candidates(&content)
    }
}

impl RelationProposer for OpenAiRelationProposer {
    fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
        Box::pin(self.request(objects, existing))
    }
}

impl fmt::Debug for OpenAiRelationProposer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiRelationProposer").field("endpoint", &self.endpoint).field("model", &self.model).finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Output {
    relations: Vec<RawRelation>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawRelation {
    source_object_id: String,
    target_object_id: String,
    kind: String,
    reason: String,
}

/// Strict: any missing, extra or mistyped field rejects the whole answer.
fn parse_candidates(content: &str) -> Result<Vec<RelationCandidate>, RelationError> {
    let output: Output = serde_json::from_str(content).map_err(|_| RelationError::InvalidOutput("not the requested structure".into()))?;
    Ok(output
        .relations
        .into_iter()
        .map(|raw| RelationCandidate { source_object_id: raw.source_object_id, target_object_id: raw.target_object_id, kind: raw.kind, reason: raw.reason })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::credentials::ApiKey;
    use crate::storage::knowledge_store::Provenance;
    use crate::test_support::{dead_endpoint, find, serve_once};
    use serde_json::{json, Value};

    struct FixedKey(Option<&'static str>);
    impl CredentialSource for FixedKey {
        fn api_key(&self) -> Option<ApiKey> {
            self.0.and_then(ApiKey::parse)
        }
    }

    const PATH: &str = "/v1/chat/completions";
    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    fn object(id: &str, title: &str) -> KnowledgeObject {
        KnowledgeObject { id: id.into(), kind: "idea".into(), title: title.into(), body: "body".into(), created_at: "2026-10-04T10:00:00Z".into(), provenance: Provenance { capture_id: "c".into(), source_start: 0, source_end: 1 } }
    }

    fn proposer(url: &str, key: Option<&'static str>) -> OpenAiRelationProposer {
        OpenAiRelationProposer::with_endpoint(Arc::new(FixedKey(key)), url, DEFAULT_MODEL).unwrap()
    }

    fn run(proposer: &OpenAiRelationProposer) -> Result<Vec<RelationCandidate>, RelationError> {
        tauri::async_runtime::block_on(proposer.propose(&[object(A, "first"), object(B, "second")], &[]))
    }

    fn completion(content: &str) -> String {
        json!({ "choices": [{ "finish_reason": "stop", "message": { "role": "assistant", "content": content, "refusal": null } }] }).to_string()
    }

    fn one_relation() -> String {
        format!(r#"{{"relations":[{{"sourceObjectId":"{A}","targetObjectId":"{B}","kind":"depends_on","reason":"needs it"}}]}}"#)
    }

    #[test]
    fn sends_the_documented_request_and_returns_the_candidates() {
        let (url, request) = serve_once(PATH, "200 OK", completion(&one_relation()));
        let candidates = run(&proposer(&url, Some("sk-test-key"))).unwrap();

        assert_eq!(candidates, vec![RelationCandidate { source_object_id: A.into(), target_object_id: B.into(), kind: "depends_on".into(), reason: "needs it".into() }]);

        let raw = request.recv().unwrap();
        let wire = String::from_utf8_lossy(&raw).to_string();
        assert!(wire.starts_with(&format!("POST {PATH} ")));
        assert!(wire.to_lowercase().contains("authorization: bearer sk-test-key"));
        let body: Value = serde_json::from_str(&wire[find(&raw, b"\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], DEFAULT_MODEL);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["messages"][0]["content"], SYSTEM_PROMPT);
        let user = body["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains(A) && user.contains(B) && user.contains("<<<OBJECTS"));
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(body["response_format"]["json_schema"]["name"], "relations");
        assert!(body.get("tools").is_none() && body.get("functions").is_none(), "the model gets no tools");
    }

    #[test]
    fn zero_relations_is_a_valid_answer() {
        let (url, _request) = serve_once(PATH, "200 OK", completion(r#"{"relations":[]}"#));
        assert_eq!(run(&proposer(&url, Some("sk-k"))).unwrap(), vec![]);
    }

    #[test]
    fn without_a_credential_it_fails_before_touching_the_network() {
        assert_eq!(run(&proposer("http://127.0.0.1:9/x", None)), Err(RelationError::NotConfigured));
    }

    #[test]
    fn classifies_provider_failures() {
        for (status, expected) in [
            ("401 Unauthorized", RelationError::Auth(401)),
            ("403 Forbidden", RelationError::Auth(403)),
            ("429 Too Many Requests", RelationError::Provider(429)),
            ("500 Internal Server Error", RelationError::Provider(500)),
        ] {
            let (url, _request) = serve_once(PATH, status, r#"{"error":{"message":"secret detail"}}"#.into());
            assert_eq!(run(&proposer(&url, Some("sk-k"))), Err(expected), "{status}");
        }
    }

    #[test]
    fn an_unreachable_provider_is_a_network_error() {
        assert_eq!(run(&proposer(&dead_endpoint(PATH), Some("sk-k"))), Err(RelationError::Network));
    }

    fn invalid_output(body: String) {
        let (url, _request) = serve_once(PATH, "200 OK", body.clone());
        assert!(matches!(run(&proposer(&url, Some("sk-k"))), Err(RelationError::InvalidOutput(_))), "{body}");
    }

    #[test]
    fn malformed_json_and_unsupported_structure_are_rejected() {
        for content in [
            "not json at all",
            "",
            "{}",
            r#"{"relations":"nope"}"#,
            r#"{"relations":[],"summary":"extra top-level field"}"#,
            &format!(r#"{{"relations":[{{"sourceObjectId":"{A}","targetObjectId":"{B}","kind":"extends","reason":"r","confidence":0.9}}]}}"#),
            &format!(r#"{{"relations":[{{"sourceObjectId":"{A}","targetObjectId":"{B}","kind":"extends"}}]}}"#),
            &format!(r#"{{"relations":[{{"sourceObjectId":"{A}","kind":"extends","reason":"r"}}]}}"#),
            &format!(r#"{{"relations":[{{"sourceObjectId":7,"targetObjectId":"{B}","kind":"extends","reason":"r"}}]}}"#),
            &format!(r#"{{"relations":[{{"sourceObjectId":"{A}","targetObjectId":"{B}","kind":null,"reason":"r"}}]}}"#),
            "```json\n{\"relations\":[]}\n```",
        ] {
            invalid_output(completion(content));
        }
    }

    #[test]
    fn an_invalid_kind_is_passed_through_for_the_validator_to_reject() {
        // Parsing is structural only; whether a kind is allowed is the validator's job.
        let body = completion(&format!(r#"{{"relations":[{{"sourceObjectId":"{A}","targetObjectId":"{B}","kind":"friends_with","reason":"r"}}]}}"#));
        let (url, _request) = serve_once(PATH, "200 OK", body);
        assert_eq!(run(&proposer(&url, Some("sk-k"))).unwrap()[0].kind, "friends_with");
    }

    #[test]
    fn broken_envelopes_refusals_and_truncation_are_classified() {
        invalid_output("not json".into());
        invalid_output(r#"{"choices":[]}"#.into());
        invalid_output(json!({ "choices": [{ "finish_reason": "length", "message": { "content": one_relation() } }] }).to_string());
        let refusal = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": null, "refusal": "I can't help with that." } }] }).to_string();
        let (url, _request) = serve_once(PATH, "200 OK", refusal);
        assert_eq!(run(&proposer(&url, Some("sk-k"))), Err(RelationError::Refused));
    }

    #[test]
    fn debug_output_exposes_no_key() {
        assert!(!format!("{:?}", proposer("http://x/y", Some("sk-super-secret"))).contains("super-secret"));
    }
}
