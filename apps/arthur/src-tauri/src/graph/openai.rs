use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;

use crate::async_util::BoxFuture;
use crate::providers::chat::{self, ChatRequest, Sampling, DEFAULT_ENDPOINT, DEFAULT_MODEL};
use crate::providers::credentials::CredentialSource;
use crate::providers::http;
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::Relation;

use super::prompt::{focus_system_prompt, focused_user_message, response_schema, system_prompt, user_message};
use super::verify::{actionable_signal_lacks_evidence, orient, Confidence, Decision, Presentation, RelationVerifier, Support, Verdict, VerifyCandidate};
use super::verify_prompt;
use super::{RelationCandidate, RelationError, RelationProposer};

/// Reasoning models think before answering, so allow for it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Stage B is the safety-critical judgement and is one small batched request, so it uses a stronger model than
/// Stage A. Chosen by measurement (see apps/arthur/README.md), not by assumption.
pub const VERIFIER_MODEL: &str = "gpt-5-mini";
const VERIFIER_REASONING_EFFORT: &str = "low";

/// One strict-JSON chat completion. Shared by the proposer and the verifier, which differ only in
/// what they ask and how they read the answer.
struct Backend {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    sampling: Sampling,
    credentials: Arc<dyn CredentialSource>,
}

impl Backend {
    fn new(credentials: Arc<dyn CredentialSource>, endpoint: &str, model: &str, sampling: Sampling) -> Result<Self, reqwest::Error> {
        Ok(Self { client: http::client(REQUEST_TIMEOUT)?, endpoint: endpoint.to_string(), model: model.to_string(), sampling, credentials })
    }

    async fn complete(&self, system: &str, user: &str, schema_name: &str, schema: Value) -> Result<String, RelationError> {
        Ok(chat::complete_json(
            &self.client,
            self.credentials.as_ref(),
            ChatRequest { endpoint: &self.endpoint, model: &self.model, system, user, schema_name, schema, sampling: self.sampling },
        )
        .await?)
    }
}

impl fmt::Debug for Backend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Backend").field("endpoint", &self.endpoint).field("model", &self.model).finish_non_exhaustive()
    }
}

/// Stage A: proposes relation candidates.
#[derive(Debug)]
pub struct OpenAiRelationProposer {
    backend: Backend,
}

impl OpenAiRelationProposer {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Result<Self, reqwest::Error> {
        Self::with_endpoint(credentials, DEFAULT_ENDPOINT, DEFAULT_MODEL)
    }

    pub fn with_endpoint(credentials: Arc<dyn CredentialSource>, endpoint: &str, model: &str) -> Result<Self, reqwest::Error> {
        Ok(Self { backend: Backend::new(credentials, endpoint, model, Sampling::Deterministic)? })
    }

    async fn request(&self, objects: &[KnowledgeObject], existing: &[Relation]) -> Result<Vec<RelationCandidate>, RelationError> {
        let content = self.backend.complete(&system_prompt(), &user_message(objects, existing), "relations", response_schema()).await?;
        parse_candidates(&content)
    }

    async fn request_focused(&self, focus_id: &str, objects: &[KnowledgeObject], existing: &[Relation]) -> Result<Vec<RelationCandidate>, RelationError> {
        let content = self.backend.complete(&focus_system_prompt(), &focused_user_message(objects, existing, focus_id), "relations", response_schema()).await?;
        parse_candidates(&content)
    }
}

impl RelationProposer for OpenAiRelationProposer {
    fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
        Box::pin(self.request(objects, existing))
    }

    fn propose_for<'a>(&'a self, focus_id: &'a str, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>> {
        Box::pin(self.request_focused(focus_id, objects, existing))
    }
}

/// Stage B: judges the kind and direction of every candidate, in one request.
#[derive(Debug)]
pub struct OpenAiRelationVerifier {
    backend: Backend,
}

impl OpenAiRelationVerifier {
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Result<Self, reqwest::Error> {
        Self::with_endpoint(credentials, DEFAULT_ENDPOINT, VERIFIER_MODEL)
    }

    /// The sampling mode follows the model family: a reasoning model (gpt-5*, o*) takes a reasoning effort
    /// instead of `temperature: 0`.
    pub fn with_endpoint(credentials: Arc<dyn CredentialSource>, endpoint: &str, model: &str) -> Result<Self, reqwest::Error> {
        let reasoning = model.starts_with("gpt-5") || model.starts_with('o');
        let sampling = if reasoning { Sampling::Reasoning(VERIFIER_REASONING_EFFORT) } else { Sampling::Deterministic };
        Ok(Self { backend: Backend::new(credentials, endpoint, model, sampling)? })
    }

    async fn request(&self, candidates: &[VerifyCandidate], presentation: Presentation) -> Result<Vec<Verdict>, RelationError> {
        let user = verify_prompt::user_message(candidates, presentation);
        let content = self.backend.complete(&verify_prompt::system_prompt(), &user, "relation_verdicts", verify_prompt::response_schema()).await?;
        parse_verdicts(&content, candidates, presentation)
    }
}

impl RelationVerifier for OpenAiRelationVerifier {
    fn verify<'a>(&'a self, candidates: &'a [VerifyCandidate], presentation: Presentation) -> BoxFuture<'a, Result<Vec<Verdict>, RelationError>> {
        Box::pin(self.request(candidates, presentation))
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
pub(super) fn parse_candidates(content: &str) -> Result<Vec<RelationCandidate>, RelationError> {
    let output: Output = serde_json::from_str(content).map_err(|_| RelationError::InvalidOutput("not the requested structure".into()))?;
    Ok(output
        .relations
        .into_iter()
        .map(|raw| RelationCandidate { source_object_id: raw.source_object_id, target_object_id: raw.target_object_id, kind: raw.kind, reason: raw.reason })
        .collect())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifyOutput {
    verdicts: Vec<RawVerdict>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawVerdict {
    index: usize,
    decision: Decision,
    kind: String,
    confidence: Confidence,
    /// Support for "first KIND second", where first/second are in the order that was SENT.
    first_to_second: Support,
    second_to_first: Support,
    explicit_link: bool,
    /// One object's later decision makes the OTHER's action unnecessary (a veto on `contradicts` only).
    cancels_or_obsoletes: bool,
    /// The object, in the order SENT, whose OWN text cancels its OWN plan; resolved to an id below.
    cancelled_plan: Plan,
    /// `depends_on` only: the dependent's requirement itself changed.
    dependency_no_longer_required: bool,
    temporal_evidence: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Plan {
    First,
    Second,
    None,
}

/// Strict, like the proposer: any missing, extra, mistyped or out-of-vocabulary field rejects the whole
/// answer. The model never copies ids and never picks a direction: the two ratings are turned into a
/// direction by `verify::orient`, using the same listing order that was sent.
pub(super) fn parse_verdicts(content: &str, candidates: &[VerifyCandidate], presentation: Presentation) -> Result<Vec<Verdict>, RelationError> {
    let output: VerifyOutput = serde_json::from_str(content).map_err(|_| RelationError::InvalidOutput("not the requested structure".into()))?;
    output
        .verdicts
        .into_iter()
        .map(|raw| {
            let candidate = candidates.get(raw.index).ok_or_else(|| RelationError::InvalidOutput("a verdict has an index that was not asked about".into()))?;
            if !crate::storage::relation_store::KINDS.contains(&raw.kind.as_str()) {
                return Err(RelationError::InvalidOutput("unknown relation kind".into()));
            }
            let (first, second) = verify_prompt::presented(candidate, presentation);
            let (first_is_source, forward_support, reverse_support) = orient(&raw.kind, raw.first_to_second, raw.second_to_first);
            let (source, target) = if first_is_source { (first, second) } else { (second, first) };
            let cancelled_plan_object_id = match raw.cancelled_plan {
                Plan::First => Some(first.id.clone()),
                Plan::Second => Some(second.id.clone()),
                Plan::None => None,
            };
            if actionable_signal_lacks_evidence(candidate, &raw.kind, source, cancelled_plan_object_id.as_deref(), raw.dependency_no_longer_required, &raw.temporal_evidence) {
                return Err(RelationError::InvalidOutput("an actionable cancellation or changed-requirement verdict has no temporalEvidence".into()));
            }
            Ok(Verdict {
                index: raw.index,
                decision: raw.decision,
                kind: raw.kind,
                source_object_id: source.id.clone(),
                target_object_id: target.id.clone(),
                confidence: raw.confidence,
                forward_support,
                reverse_support,
                explicit_link: raw.explicit_link,
                cancels_or_obsoletes: raw.cancels_or_obsoletes,
                temporal_evidence: Some(raw.temporal_evidence.trim().to_string()).filter(|e| !e.is_empty()),
                cancelled_plan_object_id,
                dependency_no_longer_required: raw.dependency_no_longer_required,
            })
        })
        .collect()
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
        KnowledgeObject { id: id.into(), kind: "idea".into(), title: title.into(), body: "body".into(), created_at: "2026-10-04T10:00:00Z".into(), provenance: Provenance { capture_id: "c".into(), source_start: 0, source_end: 1 }, project_id: "p".into() }
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
        assert_eq!(body["messages"][0]["content"], system_prompt());
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

    // --- Stage B client -------------------------------------------------------------------------

    fn verifier(url: &str, key: Option<&'static str>) -> OpenAiRelationVerifier {
        OpenAiRelationVerifier::with_endpoint(Arc::new(FixedKey(key)), url, DEFAULT_MODEL).unwrap()
    }

    fn candidate() -> VerifyCandidate {
        VerifyCandidate { index: 0, source: object(A, "first"), target: object(B, "second"), kind: "depends_on".into(), source_written_at: None, target_written_at: None }
    }

    fn run_verify(verifier: &OpenAiRelationVerifier) -> Result<Vec<Verdict>, RelationError> {
        tauri::async_runtime::block_on(verifier.verify(&[candidate()], Presentation::LowerIdFirst))
    }

    fn one_verdict() -> String {
        // Listed lower id first (A, then B). The verifier rates "second depends_on first" strong and the opposite none.
        r#"{"verdicts":[{"index":0,"decision":"accept","kind":"depends_on","confidence":"high","firstToSecond":"none","secondToFirst":"strong","explicitLink":true,"cancelsOrObsoletes":false,"cancelledPlan":"none","dependencyNoLongerRequired":false,"temporalEvidence":""}]}"#.to_string()
    }

    #[test]
    fn the_verifier_sends_the_documented_request_and_parses_the_verdicts() {
        let (url, request) = serve_once(PATH, "200 OK", completion(&one_verdict()));
        let verdicts = run_verify(&verifier(&url, Some("sk-test-key"))).unwrap();

        assert_eq!(verdicts.len(), 1);
        assert_eq!((verdicts[0].source_object_id.as_str(), verdicts[0].target_object_id.as_str()), (B, A), "the direction is derived from the two ratings and the order that was sent");
        assert_eq!((verdicts[0].decision, verdicts[0].confidence, verdicts[0].forward_support, verdicts[0].reverse_support, verdicts[0].explicit_link), (Decision::Accept, Confidence::High, Support::Strong, Support::None, true));

        let raw = request.recv().unwrap();
        let wire = String::from_utf8_lossy(&raw).to_string();
        assert!(wire.to_lowercase().contains("authorization: bearer sk-test-key"));
        let body: Value = serde_json::from_str(&wire[find(&raw, b"\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], DEFAULT_MODEL);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["messages"][0]["content"], verify_prompt::system_prompt());
        let user = body["messages"][1]["content"].as_str().unwrap();
        assert!(user.contains("<<<CANDIDATES") && user.contains("\"proposedKind\":\"depends_on\""));
        assert!(!user.contains("\"source\"") && !user.contains("\"target\""), "no direction is shown");
        assert_eq!(body["response_format"]["json_schema"]["name"], "relation_verdicts");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert!(body.get("tools").is_none() && body.get("functions").is_none(), "the verifier gets no tools");
    }

    #[test]
    fn verifier_failures_are_classified_and_never_leak_provider_detail() {
        assert_eq!(run_verify(&verifier("http://127.0.0.1:9/x", None)), Err(RelationError::NotConfigured));
        for (status, expected) in [("401 Unauthorized", RelationError::Auth(401)), ("429 Too Many Requests", RelationError::Provider(429)), ("500 Internal Server Error", RelationError::Provider(500))] {
            let (url, _request) = serve_once(PATH, status, r#"{"error":{"message":"secret detail"}}"#.into());
            assert_eq!(run_verify(&verifier(&url, Some("sk-k"))), Err(expected), "{status}");
        }
        assert_eq!(run_verify(&verifier(&dead_endpoint(PATH), Some("sk-k"))), Err(RelationError::Network));
    }

    #[test]
    fn malformed_verifier_json_and_out_of_vocabulary_values_are_rejected() {
        let good = |patch: &dyn Fn(&str) -> String| patch(&one_verdict());
        for content in [
            "not json".to_string(),
            "".to_string(),
            "{}".to_string(),
            r#"{"verdicts":"nope"}"#.to_string(),
            r#"{"verdicts":[],"summary":"extra"}"#.to_string(),
            good(&|s| s.replace("\"accept\"", "\"maybe\"")),
            good(&|s| s.replace("\"accept\"", "\"reverse\"")),
            good(&|s| s.replace("\"secondToFirst\":\"strong\"", "\"secondToFirst\":\"very\"")),
            good(&|s| s.replace("\"firstToSecond\":\"none\",", "")),
            good(&|s| s.replace("\"firstToSecond\"", "\"source\"")),
            good(&|s| s.replace("\"kind\":\"depends_on\"", "\"kind\":\"friends_with\"")),
            good(&|s| s.replace("\"firstToSecond\":\"none\"", "\"firstToSecond\":\"none\",\"sourceObjectId\":\"x\"")),
            good(&|s| s.replace("\"index\":0", "\"index\":5")),
            good(&|s| s.replace("\"high\"", "\"certain\"")),
            good(&|s| s.replace("\"strong\"", "\"very\"")),
            good(&|s| s.replace("\"index\":0", "\"index\":-1")),
            good(&|s| s.replace("\"index\":0", "\"index\":\"0\"")),
            good(&|s| s.replace("\"explicitLink\":true", "\"explicitLink\":\"yes\"")),
            good(&|s| s.replace(",\"explicitLink\":true", "")),
            good(&|s| s.replace("\"explicitLink\":true", "\"explicitLink\":true,\"why\":\"x\"")),
            format!("```json\n{}\n```", one_verdict()),
        ] {
            let (url, _request) = serve_once(PATH, "200 OK", completion(&content));
            assert!(matches!(run_verify(&verifier(&url, Some("sk-k"))), Err(RelationError::InvalidOutput(_))), "{content}");
        }
    }

    #[test]
    fn a_verifier_refusal_is_reported_as_such_and_debug_exposes_no_key() {
        let refusal = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": null, "refusal": "no" } }] }).to_string();
        let (url, _request) = serve_once(PATH, "200 OK", refusal);
        assert_eq!(run_verify(&verifier(&url, Some("sk-k"))), Err(RelationError::Refused));
        assert!(!format!("{:?}", verifier("http://x/y", Some("sk-super-secret"))).contains("super-secret"));
    }

    #[test]
    fn a_reasoning_verifier_is_steered_by_effort_and_a_standard_one_by_temperature() {
        for (model, reasoning) in [("gpt-5-mini", true), ("gpt-5", true), ("o4-mini", true), ("gpt-4.1", false), ("gpt-4.1-mini", false)] {
            let (url, request) = serve_once(PATH, "200 OK", completion(&one_verdict()));
            let verifier = OpenAiRelationVerifier::with_endpoint(Arc::new(FixedKey(Some("sk-k"))), &url, model).unwrap();
            run_verify(&verifier).unwrap();
            let raw = request.recv().unwrap();
            let body: Value = serde_json::from_str(&String::from_utf8_lossy(&raw)[find(&raw, b"\r\n\r\n").unwrap() + 4..]).unwrap();
            assert_eq!(body["model"], model);
            if reasoning {
                assert_eq!(body["reasoning_effort"], "low", "{model}");
                assert!(body.get("temperature").is_none(), "{model}: reasoning models reject temperature");
            } else {
                assert_eq!(body["temperature"], 0, "{model}");
                assert!(body.get("reasoning_effort").is_none(), "{model}");
            }
        }
    }

    #[test]
    fn the_default_verifier_is_a_stronger_model_than_the_proposer() {
        assert_eq!(VERIFIER_MODEL, "gpt-5-mini");
        assert_ne!(VERIFIER_MODEL, DEFAULT_MODEL);
    }

    // ----- M04.7A.5: the structured signals and their output contract, in the multiclass verdict -----

    const FIRST: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND: &str = "22222222-2222-4222-8222-222222222222";

    fn depends_on_candidate() -> VerifyCandidate {
        VerifyCandidate { index: 0, source: object(FIRST, "dependent"), target: object(SECOND, "prerequisite"), kind: "depends_on".into(), source_written_at: None, target_written_at: None }
    }

    fn verdict_json(kind: &str, plan: &str, gone: bool, evidence: &str, ratings: (&str, &str)) -> String {
        serde_json::json!({ "verdicts": [{ "index": 0, "decision": "accept", "kind": kind, "confidence": "high", "firstToSecond": ratings.0, "secondToFirst": ratings.1, "explicitLink": true,
            "cancelsOrObsoletes": false, "cancelledPlan": plan, "dependencyNoLongerRequired": gone, "temporalEvidence": evidence }] }).to_string()
    }

    #[test]
    fn only_an_actionable_signal_without_evidence_is_a_contract_failure() {
        let candidate = vec![depends_on_candidate()];
        let lower = Presentation::LowerIdFirst; // FIRST is listed first and is the claimed dependent (source)
        let higher = Presentation::HigherIdFirst; // SECOND is listed first
        // The DEPENDENT's plan is cancelled: actionable, evidence required.
        assert!(matches!(parse_verdicts(&verdict_json("depends_on", "first", false, "", ("strong", "none")), &candidate, lower), Err(RelationError::InvalidOutput(_))));
        assert!(matches!(parse_verdicts(&verdict_json("depends_on", "first", false, "  \n ", ("strong", "none")), &candidate, lower), Err(RelationError::InvalidOutput(_))));
        // Reversed listing order: now "second" is the dependent (FIRST is listed second).
        assert!(matches!(parse_verdicts(&verdict_json("depends_on", "second", false, "", ("none", "strong")), &candidate, higher), Err(RelationError::InvalidOutput(_))));
        // The PREREQUISITE cancelled: valid without evidence, parsed as given.
        let kept = parse_verdicts(&verdict_json("depends_on", "second", false, "", ("strong", "none")), &candidate, lower).unwrap();
        assert_eq!(kept[0].cancelled_plan_object_id.as_deref(), Some(SECOND));
        // No claim: no evidence. A different kind: nothing actionable.
        assert!(parse_verdicts(&verdict_json("depends_on", "none", false, "", ("strong", "none")), &candidate, lower).is_ok());
        assert!(parse_verdicts(&verdict_json("extends", "first", false, "", ("strong", "none")), &[VerifyCandidate { kind: "extends".into(), ..depends_on_candidate() }], lower).is_ok());
        // A changed requirement is actionable and must be explained.
        assert!(matches!(parse_verdicts(&verdict_json("depends_on", "none", true, "", ("strong", "none")), &candidate, lower), Err(RelationError::InvalidOutput(_))));
        let ok = parse_verdicts(&verdict_json("depends_on", "first", false, "The dependent is cancelled.", ("strong", "none")), &candidate, lower).unwrap();
        assert_eq!((ok[0].cancelled_plan_object_id.as_deref(), ok[0].temporal_evidence.as_deref()), (Some(FIRST), Some("The dependent is cancelled.")));
    }

    #[test]
    fn the_direction_comes_from_the_ratings_and_the_order_sent_never_from_a_label() {
        let candidate = vec![depends_on_candidate()];
        // The same claim, listed either way round, names the same direction when the ratings say so.
        let a = &parse_verdicts(&verdict_json("depends_on", "none", false, "", ("strong", "none")), &candidate, Presentation::LowerIdFirst).unwrap()[0];
        let b = &parse_verdicts(&verdict_json("depends_on", "none", false, "", ("none", "strong")), &candidate, Presentation::HigherIdFirst).unwrap()[0];
        assert_eq!((a.source_object_id.as_str(), b.source_object_id.as_str()), (FIRST, FIRST));
    }
}
