//! Cognitive Graph construction: KnowledgeObjects -> proposed relations -> validated -> persisted.
//!
//! Pipeline: a bounded, deterministic candidate set of objects goes to the cloud model, which
//! proposes relation CANDIDATES (untrusted: ids and kinds only). The model never writes to storage.
//! `validate` checks every candidate against the supplied set; the store re-validates and writes
//! the whole accepted set in one transaction. Any invalid candidate rejects the whole run, so a
//! hallucinated edge can never be persisted. Zero relations is a valid result.
//!
//! This is graph construction only. There is no lineage, no revision mechanics, no recall and no
//! retrieval ranking here.

pub mod candidates;
pub mod openai;
pub mod prompt;
pub mod validate;

use std::fmt;
use std::sync::Arc;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

use crate::async_util::BoxFuture;
use crate::providers::chat::ChatFailure;
use crate::storage::capture_store::{CaptureStore, StoreError};
use crate::storage::knowledge_store::KnowledgeObject;
use crate::storage::relation_store::{NewRelation, Relation};

/// What the model proposed. Untrusted: nothing here is stored as-is, and `reason` is never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelationCandidate {
    pub source_object_id: String,
    pub target_object_id: String,
    pub kind: String,
    pub reason: String,
}

/// Why a relation attempt failed. `code()` values mirror `RELATION_ERROR_CODES` in
/// `packages/contracts/cognitive.ts`. Messages never contain credentials, prompts or provider bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelationError {
    ObjectNotFound,
    InvalidRelation(String),
    NotConfigured,
    Network,
    Auth(u16),
    Provider(u16),
    Refused,
    InvalidOutput(String),
    Storage(String),
}

impl RelationError {
    pub fn code(&self) -> &'static str {
        match self {
            RelationError::ObjectNotFound => "object_not_found",
            RelationError::InvalidRelation(_) => "invalid_relation",
            RelationError::NotConfigured => "llm_not_configured",
            RelationError::Network | RelationError::Auth(_) | RelationError::Provider(_) => "llm_failed",
            RelationError::Refused => "llm_refused",
            RelationError::InvalidOutput(_) => "llm_invalid_output",
            RelationError::Storage(_) => "storage_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            RelationError::ObjectNotFound => "One of those knowledge objects no longer exists.".into(),
            RelationError::InvalidRelation(reason) => format!("That relation is not valid: {reason}."),
            RelationError::NotConfigured => "The language model is not configured on this device.".into(),
            RelationError::Network => "Could not reach the language model. Check the connection and try again.".into(),
            RelationError::Auth(_) => "The language model rejected the configured credentials.".into(),
            RelationError::Provider(status) => format!("The language model failed (HTTP {status}). Try again."),
            RelationError::Refused => "The language model declined to process these objects.".into(),
            RelationError::InvalidOutput(reason) => {
                format!("The language model returned something that could not be trusted ({reason}). Nothing was saved. Try again.")
            }
            RelationError::Storage(reason) => format!("The result could not be saved: {reason}"),
        }
    }
}

impl fmt::Display for RelationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for RelationError {}

/// Serialized as `{ code, message }`, matching `RelationErrorPayload`.
impl Serialize for RelationError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("RelationError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.message())?;
        state.end()
    }
}

impl From<ChatFailure> for RelationError {
    fn from(failure: ChatFailure) -> Self {
        match failure {
            ChatFailure::NotConfigured => RelationError::NotConfigured,
            ChatFailure::Network => RelationError::Network,
            ChatFailure::Auth(status) => RelationError::Auth(status),
            ChatFailure::Provider(status) => RelationError::Provider(status),
            ChatFailure::Refused => RelationError::Refused,
            ChatFailure::Unreadable(reason) => RelationError::InvalidOutput(reason),
        }
    }
}

/// Store errors for something the USER asked for (manual creation).
fn from_user_request(error: StoreError) -> RelationError {
    match error {
        StoreError::Invalid(reason) => RelationError::InvalidRelation(reason),
        StoreError::NotFound(_) => RelationError::ObjectNotFound,
        other => RelationError::Storage(other.to_string()),
    }
}

/// Store errors for something the MODEL proposed: the store rejecting it means the output was untrustworthy.
fn from_model_proposal(error: StoreError) -> RelationError {
    match error {
        StoreError::Invalid(reason) => RelationError::InvalidOutput(reason),
        StoreError::NotFound(_) => RelationError::InvalidOutput("refers to an object that does not exist".into()),
        other => RelationError::Storage(other.to_string()),
    }
}

/// The cloud model boundary: knowledge objects (and the edges they already have) in, untrusted candidates out.
pub trait RelationProposer: Send + Sync {
    fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Result<Vec<RelationCandidate>, RelationError>>;
}

/// Creates one user-authored relation, atomically. The caller supplies only kind and ends; the id,
/// timestamp and `user` origin are internal, and a symmetric edge is stored in canonical order.
pub fn create_manual_relation(store: &CaptureStore, input: NewRelation) -> Result<Relation, RelationError> {
    store.create_relation(input, "user").map_err(from_user_request)
}

pub struct GraphService {
    proposer: Arc<dyn RelationProposer>,
}

impl GraphService {
    pub fn new(proposer: Arc<dyn RelationProposer>) -> Self {
        Self { proposer }
    }

    /// Asks the model for relations among a bounded candidate set and persists the valid result.
    ///
    /// `object_ids` are objects that must be in the candidate set (see `candidates`); with none, the
    /// most recent objects are used. Returns only the relations this run ADDED, so running it again
    /// returns an empty list rather than duplicates. Fewer than two candidates means nothing to
    /// relate: the model is not called.
    pub async fn infer(&self, store: &CaptureStore, object_ids: &[String]) -> Result<Vec<Relation>, RelationError> {
        let all = store.list_knowledge_objects().map_err(|error| RelationError::Storage(error.to_string()))?;
        let objects = candidates::select_candidates(all, object_ids)?;
        if objects.len() < 2 {
            return Ok(vec![]);
        }

        let in_scope = |relation: &Relation| objects.iter().any(|o| o.id == relation.source_object_id) && objects.iter().any(|o| o.id == relation.target_object_id);
        let existing: Vec<Relation> = store.list_relations().map_err(|error| RelationError::Storage(error.to_string()))?.into_iter().filter(in_scope).collect();

        let proposals = self.proposer.propose(&objects, &existing).await?;
        let accepted = validate::validate_proposals(&objects, proposals)?;
        // All-or-nothing. Edges that already exist are skipped, so a repeated run adds nothing.
        store.record_relations(accepted, "model").map_err(from_model_proposal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::capture_store::CreateCaptureInput;
    use crate::storage::knowledge_store::NewKnowledgeObject;
    use crate::storage::relation_store::canonical_ends;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    type Proposed = Result<Vec<RelationCandidate>, RelationError>;

    struct FakeProposer {
        result: Mutex<Proposed>,
        calls: AtomicUsize,
        saw: Mutex<Vec<(Vec<String>, usize)>>,
    }

    impl FakeProposer {
        fn returning(result: Proposed) -> Arc<Self> {
            Arc::new(Self { result: Mutex::new(result), calls: AtomicUsize::new(0), saw: Mutex::new(Vec::new()) })
        }
        fn set(&self, result: Proposed) {
            *self.result.lock().unwrap() = result;
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl RelationProposer for FakeProposer {
        fn propose<'a>(&'a self, objects: &'a [KnowledgeObject], existing: &'a [Relation]) -> BoxFuture<'a, Proposed> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.saw.lock().unwrap().push((objects.iter().map(|o| o.title.clone()).collect(), existing.len()));
                self.result.lock().unwrap().clone()
            })
        }
    }

    /// Three captures, one object each, like the acceptance scenario.
    fn scenario() -> (CaptureStore, Vec<KnowledgeObject>) {
        let store = CaptureStore::open_in_memory().unwrap();
        let mut objects = Vec::new();
        for (text, title) in [
            ("I want Arthur to organize ideas automatically.", "Arthur organizes ideas"),
            ("The Cognitive Graph should connect related ideas instead of showing flat notes.", "Graph connects ideas"),
            ("Before Graph inference works, Thought Distillation has to create KnowledgeObjects.", "Distillation first"),
        ] {
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: text.into() }).unwrap();
            let length = text.chars().count() as i64;
            objects.extend(store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: title.into(), body: text.into(), source_start: 0, source_end: length }]).unwrap());
        }
        (store, objects)
    }

    fn proposal(kind: &str, source: &str, target: &str) -> RelationCandidate {
        RelationCandidate { source_object_id: source.into(), target_object_id: target.into(), kind: kind.into(), reason: "because".into() }
    }

    fn service(result: Proposed) -> (GraphService, Arc<FakeProposer>) {
        let fake = FakeProposer::returning(result);
        (GraphService::new(fake.clone()), fake)
    }

    fn run(service: &GraphService, store: &CaptureStore, ids: &[String]) -> Result<Vec<Relation>, RelationError> {
        tauri::async_runtime::block_on(service.infer(store, ids))
    }

    fn relation_count(store: &CaptureStore) -> usize {
        store.list_relations().unwrap().len()
    }

    #[test]
    fn a_sensible_proposal_is_validated_persisted_and_marked_as_model_origin() {
        let (store, o) = scenario();
        let (service, fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]));

        let added = run(&service, &store, &[]).unwrap();

        assert_eq!(added.len(), 2);
        assert!(added.iter().all(|r| r.origin == "model"));
        assert_eq!((added[0].kind.as_str(), added[0].source_object_id.as_str(), added[0].target_object_id.as_str()), ("extends", o[1].id.as_str(), o[0].id.as_str()), "direction is kept");
        assert_eq!(store.list_relations().unwrap(), added);
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn the_model_sees_only_knowledge_objects_and_never_the_raw_captures() {
        let (store, _o) = scenario();
        let (service, fake) = service(Ok(vec![]));
        run(&service, &store, &[]).unwrap();
        let saw = fake.saw.lock().unwrap();
        assert_eq!(saw[0].0.len(), 3);
        assert_eq!(saw[0].1, 0, "no relations existed yet");
    }

    #[test]
    fn zero_relations_is_a_valid_result_and_writes_nothing() {
        let (store, _o) = scenario();
        let (service, fake) = service(Ok(vec![]));
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);
        assert_eq!(relation_count(&store), 0);
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn fewer_than_two_objects_means_nothing_to_relate_and_the_model_is_not_called() {
        let store = CaptureStore::open_in_memory().unwrap();
        let (service, fake) = service(Ok(vec![]));
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);

        let (store, _o) = {
            let store = CaptureStore::open_in_memory().unwrap();
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: "one thought".into() }).unwrap();
            let objects = store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "idea".into(), title: "t".into(), body: "b".into(), source_start: 0, source_end: 3 }]).unwrap();
            (store, objects)
        };
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);
        assert_eq!(fake.calls(), 0);
    }

    #[test]
    fn hallucinated_object_ids_reject_the_whole_set() {
        let (store, o) = scenario();
        let ghost = "00000000-0000-4000-8000-000000000000";
        for bad in [proposal("extends", &o[1].id, ghost), proposal("extends", ghost, &o[0].id), proposal("extends", "obj-7", &o[0].id)] {
            let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), bad]));
            let error = run(&service, &store, &[]).unwrap_err();
            assert_eq!(error.code(), "llm_invalid_output");
            assert_eq!(relation_count(&store), 0, "the valid candidate was not written either");
        }
    }

    #[test]
    fn an_existing_object_outside_the_candidate_set_is_rejected_too() {
        let limit = candidates::MAX_INFERENCE_CANDIDATES;
        let (store, objects) = many_objects(limit + 5);
        // The oldest object exists in the database but falls outside the most-recent window.
        let (service, _fake) = service(Ok(vec![proposal("related_to", &objects[limit + 4].id, &objects[0].id)]));

        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn self_relations_invalid_kinds_and_unsupported_kinds_are_rejected() {
        let (store, o) = scenario();
        for bad in [proposal("extends", &o[0].id, &o[0].id), proposal("friends_with", &o[0].id, &o[1].id), proposal("", &o[0].id, &o[1].id), proposal("Extends", &o[0].id, &o[1].id)] {
            let (service, _fake) = service(Ok(vec![bad]));
            assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
        }
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn duplicate_candidates_are_rejected_including_a_symmetric_pair_stated_both_ways() {
        let (store, o) = scenario();
        for duplicated in [
            vec![proposal("extends", &o[1].id, &o[0].id), proposal("extends", &o[1].id, &o[0].id)],
            vec![proposal("related_to", &o[1].id, &o[0].id), proposal("related_to", &o[0].id, &o[1].id)],
            vec![proposal("duplicates", &o[1].id, &o[0].id), proposal("duplicates", &o[0].id, &o[1].id)],
        ] {
            let (service, _fake) = service(Ok(duplicated));
            assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
            assert_eq!(relation_count(&store), 0);
        }
        // Opposite directions of a directional kind are two different edges.
        let (service, _fake) = service(Ok(vec![proposal("depends_on", &o[1].id, &o[0].id), proposal("depends_on", &o[0].id, &o[1].id)]));
        assert_eq!(run(&service, &store, &[]).unwrap().len(), 2);
    }

    #[test]
    fn a_symmetric_proposal_is_stored_in_canonical_order_whichever_way_the_model_stated_it() {
        let (store, o) = scenario();
        let (low, high) = canonical_ends("related_to", &o[0].id, &o[1].id);
        // The model states the edge "backwards" relative to the canonical order.
        let (service, fake) = service(Ok(vec![proposal("related_to", &high, &low)]));

        let stored = run(&service, &store, &[]).unwrap();
        assert_eq!((stored[0].source_object_id.as_str(), stored[0].target_object_id.as_str()), (low.as_str(), high.as_str()));

        // Stating it the other way round on a later run is the same edge: nothing is added.
        fake.set(Ok(vec![proposal("related_to", &low, &high)]));
        assert_eq!(run(&service, &store, &[]).unwrap(), vec![]);
        assert_eq!(relation_count(&store), 1);
    }

    #[test]
    fn one_invalid_candidate_among_valid_ones_writes_nothing() {
        let (store, o) = scenario();
        let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id), proposal("extends", &o[2].id, &o[2].id)]));
        assert!(run(&service, &store, &[]).is_err());
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn a_database_failure_during_the_write_leaves_no_partial_run() {
        let (store, o) = scenario();
        store.execute_sql_for_test("CREATE TRIGGER poison BEFORE INSERT ON relations WHEN NEW.kind = 'depends_on' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
        let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]));
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "storage_failed");
        assert_eq!(relation_count(&store), 0);
    }

    #[test]
    fn running_inference_twice_adds_nothing_the_second_time() {
        let (store, o) = scenario();
        let (service, fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("related_to", &o[0].id, &o[2].id)]));

        let first = run(&service, &store, &[]).unwrap();
        let second = run(&service, &store, &[]).unwrap();

        assert_eq!(first.len(), 2);
        assert_eq!(second, vec![], "the model proposed the same edges again; they already exist");
        assert_eq!(store.list_relations().unwrap(), first);
        assert_eq!(fake.saw.lock().unwrap()[1].1, 2, "the second run told the model which edges already exist");
    }

    #[test]
    fn a_manual_edge_is_not_duplicated_or_re_attributed_by_inference() {
        let (store, o) = scenario();
        let manual = create_manual_relation(&store, NewRelation { kind: "extends".into(), source_object_id: o[1].id.clone(), target_object_id: o[0].id.clone() }).unwrap();
        let (service, _fake) = service(Ok(vec![proposal("extends", &o[1].id, &o[0].id), proposal("depends_on", &o[1].id, &o[2].id)]));

        let added = run(&service, &store, &[]).unwrap();

        assert_eq!(added.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["depends_on"]);
        let all = store.list_relations().unwrap();
        assert_eq!(all[0], manual);
        assert_eq!((all[0].origin.as_str(), all[1].origin.as_str()), ("user", "model"));
    }

    #[test]
    fn a_provider_failure_stores_nothing_and_can_be_retried() {
        let (store, o) = scenario();
        let (service, fake) = service(Err(RelationError::Network));
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_failed");
        assert_eq!(relation_count(&store), 0);

        fake.set(Ok(vec![proposal("extends", &o[1].id, &o[0].id)]));
        assert_eq!(run(&service, &store, &[]).unwrap().len(), 1);
    }

    #[test]
    fn requested_objects_must_exist_and_be_well_formed() {
        let (store, o) = scenario();
        let (service, fake) = service(Ok(vec![]));
        assert_eq!(run(&service, &store, &["00000000-0000-4000-8000-000000000000".into()]).unwrap_err(), RelationError::ObjectNotFound);
        assert_eq!(run(&service, &store, &["nope".into()]).unwrap_err().code(), "invalid_relation");
        assert_eq!(run(&service, &store, &[o[0].id.clone()]).unwrap(), vec![]);
        assert_eq!(fake.calls(), 1, "only the valid request reached the model");
    }

    /// `count` single-object captures. Returns the objects oldest first.
    fn many_objects(count: usize) -> (CaptureStore, Vec<KnowledgeObject>) {
        let store = CaptureStore::open_in_memory().unwrap();
        let mut objects = Vec::new();
        for index in 0..count {
            let text = format!("thought number {index}");
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: text.clone() }).unwrap();
            let length = text.chars().count() as i64;
            objects.extend(store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: "note".into(), title: format!("object {index}"), body: text, source_start: 0, source_end: length }]).unwrap());
        }
        (store, objects)
    }

    #[test]
    fn the_candidate_set_is_the_most_recent_objects_up_to_a_hard_limit() {
        let limit = candidates::MAX_INFERENCE_CANDIDATES;
        let (store, objects) = many_objects(limit + 10);
        let (service, fake) = service(Ok(vec![]));
        run(&service, &store, &[]).unwrap();

        let saw = fake.saw.lock().unwrap();
        assert_eq!(saw[0].0.len(), limit);
        // Newest distillations first: the ten oldest objects are left out.
        let oldest: Vec<String> = objects.iter().take(10).map(|o| o.title.clone()).collect();
        assert!(saw[0].0.iter().all(|title| !oldest.contains(title)));
        assert_eq!(saw[0].0[0], format!("object {}", limit + 9));
    }

    #[test]
    fn requested_objects_are_always_included_and_the_limit_still_holds() {
        let limit = candidates::MAX_INFERENCE_CANDIDATES;
        let (store, objects) = many_objects(limit + 10);
        let (service, fake) = service(Ok(vec![]));
        run(&service, &store, &[objects[0].id.clone(), objects[1].id.clone()]).unwrap();

        let titles = &fake.saw.lock().unwrap()[0].0;
        assert_eq!(titles.len(), limit);
        assert!(titles.contains(&"object 0".to_string()) && titles.contains(&"object 1".to_string()), "the oldest two were asked for");
        assert!(!titles.contains(&"object 2".to_string()), "the next-oldest was not, and it does not fit");
    }

    #[test]
    fn asking_about_more_objects_than_the_limit_is_rejected_before_any_model_call() {
        let (store, objects) = many_objects(candidates::MAX_INFERENCE_CANDIDATES + 2);
        let (service, fake) = service(Ok(vec![]));
        let ids: Vec<String> = objects.iter().map(|o| o.id.clone()).collect();
        assert_eq!(run(&service, &store, &ids).unwrap_err().code(), "invalid_relation");
        assert_eq!(fake.calls(), 0);
    }

    #[test]
    fn too_many_proposals_are_rejected() {
        let (store, o) = scenario();
        let many = (0..=crate::storage::relation_store::MAX_RELATIONS_PER_BATCH).map(|_| proposal("extends", &o[0].id, &o[1].id)).collect();
        let (service, _fake) = service(Ok(many));
        assert_eq!(run(&service, &store, &[]).unwrap_err().code(), "llm_invalid_output");
    }

    #[test]
    fn manual_creation_reports_invalid_and_missing_objects_distinctly() {
        let (store, o) = scenario();
        let make = |kind: &str, a: &str, b: &str| create_manual_relation(&store, NewRelation { kind: kind.into(), source_object_id: a.into(), target_object_id: b.into() });
        assert_eq!(make("extends", &o[0].id, &o[0].id).unwrap_err().code(), "invalid_relation");
        assert_eq!(make("nope", &o[0].id, &o[1].id).unwrap_err().code(), "invalid_relation");
        assert_eq!(make("extends", "bad", &o[1].id).unwrap_err().code(), "invalid_relation");
        assert_eq!(make("extends", &o[0].id, "00000000-0000-4000-8000-000000000000").unwrap_err(), RelationError::ObjectNotFound);
        let made = make("supersedes", &o[1].id, &o[0].id).unwrap();
        assert_eq!(made.origin, "user");
        assert_eq!(make("supersedes", &o[1].id, &o[0].id).unwrap(), made, "idempotent");
    }

    #[test]
    fn errors_serialize_to_the_contract_shape_and_leak_nothing() {
        let value = serde_json::to_value(RelationError::NotConfigured).unwrap();
        assert_eq!(value, serde_json::json!({ "code": "llm_not_configured", "message": "The language model is not configured on this device." }));
        for error in [
            RelationError::ObjectNotFound,
            RelationError::InvalidRelation("x".into()),
            RelationError::Network,
            RelationError::Auth(401),
            RelationError::Provider(500),
            RelationError::Refused,
            RelationError::Storage("x".into()),
            RelationError::InvalidOutput("y".into()),
        ] {
            let message = error.message();
            assert!(!message.contains("sk-"), "{message}");
        }
    }

    /// Opt-in: calls the real OpenAI API. Run with
    /// `ARTHUR_LIVE_KEY_FILE=/path/to/key cargo test live_ -- --ignored --nocapture`.
    #[test]
    #[ignore = "calls the real OpenAI API; set ARTHUR_LIVE_KEY_FILE"]
    fn live_inference_proposes_a_sensible_validated_relation() {
        use crate::graph::openai::OpenAiRelationProposer;
        use crate::providers::credentials::FileCredentialSource;

        let key_file = std::env::var("ARTHUR_LIVE_KEY_FILE").expect("ARTHUR_LIVE_KEY_FILE");
        let proposer = Arc::new(OpenAiRelationProposer::new(Arc::new(FileCredentialSource::new(key_file.into()))).unwrap());
        let service = GraphService::new(proposer.clone());

        let store = CaptureStore::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for (kind, title, text) in [
            ("idea", "Arthur should organize ideas automatically", "I want Arthur to organize ideas automatically."),
            ("idea", "Cognitive Graph should connect related ideas", "The Cognitive Graph should connect related ideas instead of showing flat notes."),
            ("note", "Distillation must create KnowledgeObjects before Graph inference", "Before Graph inference works, Thought Distillation has to create KnowledgeObjects."),
        ] {
            let capture = store.create(CreateCaptureInput { source: "text".into(), content: text.into() }).unwrap();
            let length = text.chars().count() as i64;
            ids.extend(store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: kind.into(), title: title.into(), body: text.into(), source_start: 0, source_end: length }]).unwrap());
        }
        let titles: std::collections::HashMap<_, _> = ids.iter().map(|o| (o.id.clone(), o.title.clone())).collect();

        let raw = tauri::async_runtime::block_on(proposer.propose(&ids, &[]));
        println!("RAW PROPOSALS (before validation):");
        match &raw {
            Ok(candidates) => {
                for c in candidates {
                    let name = |id: &String| titles.get(id).cloned().unwrap_or_else(|| format!("UNKNOWN {id}"));
                    println!("  {} --{}--> {}   // {}", name(&c.source_object_id), c.kind, name(&c.target_object_id), c.reason);
                }
                println!("  ({} proposed)", candidates.len());
            }
            Err(error) => println!("  ERROR {error}"),
        }

        println!("VALIDATED AND STORED:");
        let result = tauri::async_runtime::block_on(service.infer(&store, &[]));
        match result {
            Ok(relations) => {
                for r in &relations {
                    println!("  {} --{}--> {}   [{}]", titles[&r.source_object_id], r.kind, titles[&r.target_object_id], r.origin);
                }
                println!("  ({} relations)", relations.len());
            }
            Err(error) => println!("  ERROR {error}"),
        }
    }
}
